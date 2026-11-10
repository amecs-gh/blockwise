<?php

declare(strict_types=1);

namespace OCA\Tracker\Service;

use OCA\Tracker\Db\CommitmentMapper;
use OCA\Tracker\Db\NoteMapper;
use OCA\Tracker\Db\Subtask;
use OCA\Tracker\Db\SubtaskMapper;
use OCA\Tracker\Db\Task;
use OCA\Tracker\Db\TaskMapper;
use OCP\AppFramework\Utility\ITimeFactory;

/**
 * Task queue per commitment and the subtask checklists.
 * A task with subtasks is done exactly when all its subtasks are checked.
 */
class TaskService {
	/** Limits that keep one request from filling the database */
	public const MAX_NOTE = 10000;
	public const MAX_SUBTASKS = 200;
	public const MAX_IDS = 2000;
	public function __construct(
		private TaskMapper $tasks,
		private SubtaskMapper $subtasks,
		private CommitmentMapper $commitments,
		private NoteMapper $notes,
		private ITimeFactory $time,
	) {
	}

	/** @return Task[] with ->subtasks filled, in queue order */
	public function list(string $userId, ?int $commitmentId = null, ?bool $done = null): array {
		return $this->attachSubtasks($this->tasks->findForUser($userId, $commitmentId, $done));
	}

	/**
	 * @param Task[] $tasks
	 * @return Task[]
	 */
	public function attachSubtasks(array $tasks): array {
		$byId = [];
		foreach ($tasks as $t) {
			$t->subtasks = [];
			$byId[$t->getId()] = $t;
		}
		foreach ($this->subtasks->findForTasks(array_keys($byId)) as $s) {
			$byId[$s->getTaskId()]->subtasks[] = $s;
		}
		return $tasks;
	}

	public function get(string $userId, int $id): Task {
		return $this->attachSubtasks([$this->tasks->find($id, $userId)])[0];
	}

	/**
	 * @param int|null $estimate minutes; used when the task has no subtasks of its own
	 * @param array<string|array{title: string, estimate?: int|null}> $subtasks
	 */
	public function create(string $userId, int $commitmentId, string $title, ?string $note, ?int $estimate, array $subtasks = []): Task {
		$this->commitments->find($commitmentId, $userId); // ownership check
		$t = new Task();
		$t->setUserId($userId);
		$t->setCommitmentId($commitmentId);
		$t->setTitle($this->cleanTitle($title));
		$t->setNote($this->cleanNote($note));
		$t->setEstimate(null); // estimates live on subtasks
		if (count($subtasks) > self::MAX_SUBTASKS) {
			throw new ServiceException('Too many subtasks');
		}
		$t->setPosition($this->tasks->maxPosition($userId, $commitmentId) + 1);
		$t->setDone(0);
		$t->setCarried(0);
		$t->setCreated($this->time->getTime());
		$t = $this->tasks->insert($t);
		$list = [];
		foreach ($subtasks as $st) {
			$st = is_array($st) ? $st : ['title' => $st];
			$stTitle = $st['title'] ?? '';
			if (!is_string($stTitle) || trim($stTitle) === '') {
				continue;
			}
			$stEstimate = $st['estimate'] ?? null;
			$list[] = ['title' => $stTitle, 'estimate' => is_numeric($stEstimate) ? (int)$stEstimate : null];
		}
		// Only subtasks are checkable: a task without subtasks gets one with its own title
		if ($list === []) {
			// "Email supervisor 10m" -> task and its subtask "Email supervisor", 10 minutes
			if ($estimate === null) {
				[$plain, $estimate] = self::parseEstimate($t->getTitle());
				if ($estimate !== null) {
					$t->setTitle($plain);
					$this->tasks->update($t);
				}
			}
			$list = [['title' => $t->getTitle(), 'estimate' => $estimate]];
		}
		foreach ($list as $st) {
			$this->createSubtask($userId, $t->getId(), $st['title'], $st['estimate']);
		}
		return $this->get($userId, $t->getId());
	}

	/** @param array<string, mixed> $data title, note, commitmentId (done and estimate follow the subtasks) */
	public function update(string $userId, int $id, array $data): Task {
		$t = $this->get($userId, $id);
		if (array_key_exists('title', $data)) {
			$old = $t->getTitle();
			$t->setTitle($this->cleanTitle($this->str($data['title'])));
			if (count($t->subtasks) === 1 && $t->subtasks[0]->getTitle() === $old) {
				$t->subtasks[0]->setTitle($t->getTitle());
				$this->subtasks->update($t->subtasks[0]);
			}
		}
		if (array_key_exists('note', $data)) {
			$t->setNote($this->cleanNote(is_string($data['note']) ? $data['note'] : null));
		}
		if (array_key_exists('commitmentId', $data) && (int)$data['commitmentId'] !== $t->getCommitmentId()) {
			$target = (int)$data['commitmentId'];
			$this->commitments->find($target, $userId);
			$t->setCommitmentId($target);
			$t->setPosition($this->tasks->maxPosition($userId, $target) + 1);
			$t->setCarried(0);
		}
		$this->tasks->update($t);
		return $this->get($userId, $id);
	}

	public function delete(string $userId, int $id): void {
		$t = $this->tasks->find($id, $userId);
		$this->subtasks->deleteByTask($t->getId());
		$this->tasks->delete($t);
	}

	/** @param int[] $ids new queue order of (some of) the commitment's tasks */
	public function reorder(string $userId, int $commitmentId, array $ids): void {
		$this->commitments->find($commitmentId, $userId);
		$pos = 1;
		foreach (array_slice($ids, 0, self::MAX_IDS) as $id) {
			$t = $this->tasks->find((int)$id, $userId);
			if ($t->getCommitmentId() !== $commitmentId) {
				continue;
			}
			$t->setPosition($pos++);
			$this->tasks->update($t);
		}
	}

	/**
	 * Subtask order is their priority within the task.
	 *
	 * @param int[] $ids new order of (some of) the task's subtasks; others keep their relative order after them
	 */
	public function reorderSubtasks(string $userId, int $taskId, array $ids): Task {
		$t = $this->get($userId, $taskId);
		$byId = [];
		foreach ($t->subtasks as $sub) {
			$byId[$sub->getId()] = $sub;
		}
		$ordered = [];
		foreach (array_slice($ids, 0, self::MAX_IDS) as $id) {
			if (isset($byId[(int)$id])) {
				$ordered[] = $byId[(int)$id];
				unset($byId[(int)$id]);
			}
		}
		$pos = 1;
		foreach (array_merge($ordered, array_values($byId)) as $sub) {
			if ($sub->getPosition() !== $pos) {
				$sub->setPosition($pos);
				$this->subtasks->update($sub);
			}
			$pos++;
		}
		return $this->get($userId, $taskId);
	}

	/**
	 * "Draft 45m", "Draft 1h", "Draft 1h30", "Draft 1.5h", "Draft 90min" -> [title, minutes].
	 * A trailing number without a unit stays in the title ("Chapter 3").
	 *
	 * @return array{0: string, 1: int|null}
	 */
	public static function parseEstimate(string $line): array {
		$line = trim($line);
		if (!preg_match('/^(.*\S)\s+(?:(\d+(?:[.,]\d+)?)\s*h(?:\s*(\d+)\s*(?:m|min)?)?|(\d+)\s*(?:m|min))$/i', $line, $m)) {
			return [$line, null];
		}
		$minutes = isset($m[4]) && $m[4] !== ''
			? (int)$m[4]
			: (int)round((float)str_replace(',', '.', $m[2]) * 60) + (isset($m[3]) && $m[3] !== '' ? (int)$m[3] : 0);
		return [$m[1], $minutes > 0 ? $minutes : null];
	}

	public function createSubtask(string $userId, int $taskId, string $title, ?int $estimate = null): Subtask {
		if ($estimate === null) {
			[$title, $estimate] = self::parseEstimate($title);
		}
		$t = $this->tasks->find($taskId, $userId);
		if (count($this->subtasks->findForTasks([$t->getId()])) >= self::MAX_SUBTASKS) {
			throw new ServiceException('Too many subtasks');
		}
		$s = new Subtask();
		$s->setUserId($userId);
		$s->setTaskId($t->getId());
		$s->setTitle($this->cleanTitle($title));
		$s->setPosition($this->subtasks->maxPosition($t->getId()) + 1);
		$s->setDone(0);
		$s->setEstimate($this->cleanEstimate($estimate));
		$s->setCreated($this->time->getTime());
		$s = $this->subtasks->insert($s);
		$this->syncTaskDone($userId, $t->getId());
		return $s;
	}

	/** @param array<string, mixed> $data title, done, estimate (minutes, null = none) */
	public function updateSubtask(string $userId, int $id, array $data): Task {
		$s = $this->subtasks->find($id, $userId);
		if (array_key_exists('title', $data)) {
			$s->setTitle($this->cleanTitle($this->str($data['title'])));
		}
		if (array_key_exists('estimate', $data)) {
			$s->setEstimate($this->cleanEstimate(is_numeric($data['estimate']) ? (int)$data['estimate'] : null));
		}
		if (array_key_exists('done', $data)) {
			$done = (bool)$data['done'];
			if ($done !== (bool)$s->getDone()) {
				$s->setDone($done ? 1 : 0);
				$s->setDoneAt($done ? $this->time->getTime() : null);
			}
		}
		$this->subtasks->update($s);
		$this->syncTaskDone($userId, $s->getTaskId());
		return $this->get($userId, $s->getTaskId());
	}

	public function deleteSubtask(string $userId, int $id): Task {
		$s = $this->subtasks->find($id, $userId);
		if (count($this->subtasks->findForTasks([$s->getTaskId()])) <= 1) {
			throw new ServiceException('A task needs at least one subtask. Delete the task instead.');
		}
		$this->subtasks->delete($s);
		$this->syncTaskDone($userId, $s->getTaskId());
		return $this->get($userId, $s->getTaskId());
	}

	/** Task done state follows its subtasks. */
	private function syncTaskDone(string $userId, int $taskId): void {
		$t = $this->get($userId, $taskId);
		if ($t->subtasks === []) {
			return;
		}
		$all = $this->allDone($t->subtasks);
		if ($all && !$t->getDone()) {
			$t->setDone(1);
			$t->setDoneAt($this->time->getTime());
			$this->tasks->update($t);
		} elseif (!$all && $t->getDone()) {
			$t->setDone(0);
			$t->setDoneAt(null);
			$this->tasks->update($t);
		}
	}

	/** @param Subtask[] $subtasks */
	private function allDone(array $subtasks): bool {
		foreach ($subtasks as $s) {
			if (!$s->getDone()) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Subtasks checked off in [from, to).
	 *
	 * @return list<array{kind: string, id: int, title: string, task: string, taskId: int, commitmentId: int, doneAt: int}>
	 */
	public function done(string $userId, int $from, int $to): array {
		$items = [];
		$subtasks = $this->subtasks->findDoneBetween($userId, $from, $to);
		$taskIds = array_unique(array_map(fn ($s) => $s->getTaskId(), $subtasks));
		$taskById = [];
		foreach ($taskIds as $tid) {
			try {
				$taskById[$tid] = $this->tasks->find($tid, $userId);
			} catch (\Throwable) {
			}
		}
		foreach ($subtasks as $s) {
			$t = $taskById[$s->getTaskId()] ?? null;
			if ($t === null) {
				continue;
			}
			$items[] = [
				'kind' => 'subtask', 'id' => $s->getId(), 'title' => $s->getTitle(),
				'task' => $t->getTitle(), 'taskId' => $t->getId(),
				'commitmentId' => $t->getCommitmentId(), 'doneAt' => (int)$s->getDoneAt(),
			];
		}
		// Ticked notes (Notes tab)
		foreach ($this->notes->findDoneBetween($userId, $from, $to) as $n) {
			$items[] = [
				'kind' => 'note', 'id' => $n->getId(), 'title' => self::noteTitle($n->getText()),
				'task' => null, 'taskId' => null,
				'commitmentId' => $n->getCommitmentId(), 'doneAt' => (int)$n->getDoneAt(),
			];
		}
		usort($items, fn ($a, $b) => $a['doneAt'] <=> $b['doneAt'] ?: strcmp($a['kind'], $b['kind']) ?: $a['id'] <=> $b['id']);
		return $items;
	}

	/**
	 * A note in lists (Done): its first line as plain text, markdown removed,
	 * at most 120 characters. Same rules as js/markdown.js plainTitle().
	 */
	public static function noteTitle(string $text): string {
		$text = trim(str_replace(["\r\n", "\r"], "\n", $text));
		$line = trim(explode("\n", $text)[0]);
		$line = preg_replace('/^(#{1,6}\s+|>\s*|```\S*|~~~\S*)/', '', $line) ?? $line;
		$line = preg_replace('/^([-*+]|\d{1,9}[.)])\s+/', '', $line) ?? $line;
		$line = preg_replace('/^\[[ xX]\]\s*/', '', $line) ?? $line;
		$line = preg_replace('/\[([^\]]*)\]\([^)]*\)/', '$1', $line) ?? $line;
		$line = preg_replace('/(\*\*|__|~~|`)/', '', $line) ?? $line;
		$line = preg_replace('/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/', '$1$2', $line) ?? $line;
		$line = trim($line);
		return mb_strlen($line) > 120 ? rtrim(mb_substr($line, 0, 119)) . '…' : $line;
	}

	private function cleanTitle(string $title): string {
		$title = trim($title);
		if ($title === '') {
			throw new ServiceException('Title is required');
		}
		return mb_substr($title, 0, 255);
	}

	/** Request values can be any JSON type; only strings are text. */
	private function str(mixed $value): string {
		return is_string($value) ? $value : '';
	}

	private function cleanNote(?string $note): ?string {
		if ($note === null || trim($note) === '') {
			return null;
		}
		return mb_substr($note, 0, self::MAX_NOTE);
	}

	private function cleanEstimate(?int $minutes): ?int {
		if ($minutes === null || $minutes <= 0) {
			return null;
		}
		return min($minutes, 100000);
	}
}
