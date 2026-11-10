<?php

declare(strict_types=1);

namespace OCA\Tracker\Sync;

use OCA\Tracker\Db\Commitment;
use OCA\Tracker\Db\CommitmentMapper;
use OCA\Tracker\Db\Session;
use OCA\Tracker\Db\SessionMapper;
use OCA\Tracker\Db\Subtask;
use OCA\Tracker\Db\Note;
use OCA\Tracker\Db\NoteMapper;
use OCA\Tracker\Db\SubtaskMapper;
use OCA\Tracker\Db\Task;
use OCA\Tracker\Db\TaskMapper;
use OCA\Tracker\Service\CalendarService;
use OCA\Tracker\Service\NoteService;
use OCA\Tracker\Service\CommitmentService;
use OCA\Tracker\Service\ServiceException;
use OCA\Tracker\Service\SettingsService;
use OCP\AppFramework\Db\Entity;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/**
 * Sync with devices that keep their own copy (local-first apps).
 *
 * Wire format of a record:
 *   {"type": "task", "id": "<uuid>", "fields": {"title": "…", …}, "clock": {"title": "<clock>", …}}
 *   {"type": "task", "id": "<uuid>", "deleted": true}
 *   {"type": "settings", "id": "settings", "fields": {…}, "clock": {…}}
 * References to other records ("commitment" of a task, "task" of a subtask…)
 * are their uuids.
 *
 * Pull: records changed after a change number ("cursor"), oldest first.
 * Push: per field, the value with the later clock wins; "carriedBlocks" is a
 * set and merges by union; a deleted record stays deleted.
 */
class SyncService {
	public const PAGE = 1000;
	public const MAX_PUSH = 2000;
	/** Clocks further ahead than this are refused (a device with a wrong date would win every conflict) */
	public const MAX_AHEAD_MS = 24 * 3600 * 1000;
	private const ORDER = ['settings' => 0, 'commitment' => 1, 'task' => 2, 'subtask' => 3, 'note' => 4, 'session' => 5];

	/** @var array<string, array<int, string>> type => id => uuid (per request) */
	private array $uuids = [];

	public function __construct(
		private SyncClock $clock,
		private CommitmentMapper $commitments,
		private TaskMapper $tasks,
		private SubtaskMapper $subtasks,
		private NoteMapper $notes,
		private SessionMapper $sessions,
		private SettingsService $settings,
		private CommitmentService $commitmentService,
		private CalendarService $calendars,
		private ITimeFactory $time,
		private IDBConnection $db,
	) {
	}

	private function mapper(string $type): object {
		return match ($type) {
			'commitment' => $this->commitments,
			'task' => $this->tasks,
			'subtask' => $this->subtasks,
			'note' => $this->notes,
			'session' => $this->sessions,
		};
	}

	// --- pull -------------------------------------------------------------------------------

	/**
	 * @return array{cursor: int, more: bool, reset: bool, records: list<array>}
	 */
	public function pull(string $userId, int $since, int $limit = self::PAGE): array {
		$limit = max(1, min($limit, self::PAGE));
		// Calendar names, colors and addresses up to date (renamed in the Calendar app…)
		$this->commitmentService->listSynced($userId);

		$current = $this->clock->currentSeq($userId);
		$reset = $since > $current; // the server's data was restored or recreated: start over
		if ($reset || $since < 0) {
			$since = 0;
		}

		$items = [];
		$more = false;
		foreach (SyncFields::TYPES as $type) {
			$rows = $this->mapper($type)->findChangedSince($userId, $since, $limit + 1);
			$more = $more || count($rows) > $limit;
			foreach (array_slice($rows, 0, $limit) as $e) {
				$items[] = [(int)$e->getSeq(), $this->serialize($type, $e, $userId)];
			}
		}
		$qb = $this->db->getQueryBuilder();
		$qb->select('type', 'uuid', 'seq')->from('tracker_tombstones')
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->gt('seq', $qb->createNamedParameter($since, IQueryBuilder::PARAM_INT)))
			->orderBy('seq', 'ASC')
			->setMaxResults($limit + 1);
		$rows = $qb->executeQuery()->fetchAll();
		$more = $more || count($rows) > $limit;
		foreach (array_slice($rows, 0, $limit) as $r) {
			$items[] = [(int)$r['seq'], ['type' => (string)$r['type'], 'id' => (string)$r['uuid'], 'deleted' => true]];
		}
		$meta = $this->clock->settingsMeta($userId);
		if ($meta['seq'] > $since) {
			$items[] = [$meta['seq'], $this->serializeSettings($userId, $meta['clock'])];
		}

		usort($items, fn ($a, $b) => $a[0] <=> $b[0]);
		if (count($items) > $limit) {
			$more = true;
			$items = array_slice($items, 0, $limit);
		}
		$cursor = $items === [] ? max($since, $more ? $since : $current) : end($items)[0];
		return [
			'cursor' => $cursor,
			'more' => $more,
			'reset' => $reset,
			'records' => array_map(fn ($i) => $i[1], $items),
		];
	}

	private function uuidOf(string $type, ?int $id, string $userId): ?string {
		if ($id === null) {
			return null;
		}
		if (!isset($this->uuids[$type][$id])) {
			try {
				$this->uuids[$type][$id] = (string)$this->mapper($type)->find($id, $userId)->getUuid();
			} catch (\Throwable $e) {
				return null;
			}
		}
		return $this->uuids[$type][$id];
	}

	private function serialize(string $type, Entity $e, string $userId): array {
		$f = match ($type) {
			'commitment' => [
				'name' => $e->getName(),
				'color' => $e->getColor(),
				'goal' => $e->getWeeklyGoal(),
				'position' => (int)$e->getPosition(),
				'calendarUrl' => $e->getCalendarUrl(),
				'created' => (int)$e->getCreated(),
			],
			'task' => [
				'commitment' => $this->uuidOf('commitment', $e->getCommitmentId(), $userId),
				'title' => $e->getTitle(),
				'note' => $e->getNote(),
				'position' => (int)$e->getPosition(),
				'done' => (bool)$e->getDone(),
				'doneAt' => $e->getDoneAt(),
				'created' => (int)$e->getCreated(),
				'carriedBlocks' => $e->carriedBlocks(),
			],
			'subtask' => [
				'task' => $this->uuidOf('task', $e->getTaskId(), $userId),
				'title' => $e->getTitle(),
				'position' => (int)$e->getPosition(),
				'done' => (bool)$e->getDone(),
				'doneAt' => $e->getDoneAt(),
				'estimate' => $e->getEstimate(),
				'created' => (int)$e->getCreated(),
			],
			'note' => [
				'commitment' => $this->uuidOf('commitment', $e->getCommitmentId(), $userId),
				'text' => $e->getText(),
				'position' => (int)$e->getPosition(),
				'done' => (bool)$e->getDone(),
				'doneAt' => $e->getDoneAt(),
				'created' => (int)$e->getCreated(),
			],
			'session' => [
				'commitment' => $this->uuidOf('commitment', $e->getCommitmentId(), $userId),
				'start' => (int)$e->getStart(),
				'end' => $e->getEnd(),
				'blockUid' => $e->getBlockUid(),
				'pomodoro' => (bool)$e->getPomodoro(),
			],
		};
		return ['type' => $type, 'id' => (string)$e->getUuid(), 'fields' => $f, 'clock' => (object)SyncClock::decode($e->getClock())];
	}

	private function serializeSettings(string $userId, array $clock): array {
		$f = $this->settings->get($userId);
		$f['longBreakUntil'] = $this->settings->getLongBreakUntil($userId);
		return ['type' => 'settings', 'id' => 'settings', 'fields' => $f, 'clock' => (object)$clock];
	}

	// --- push -------------------------------------------------------------------------------

	/**
	 * @param array $records as in the wire format
	 * @return array{applied: int, rejected: list<array{id: string, reason: string}>, cursor: int}
	 */
	public function push(string $userId, array $records): array {
		if (count($records) > self::MAX_PUSH) {
			throw new ServiceException('Too many changes at once');
		}
		$records = array_values(array_filter($records, 'is_array'));
		// Parents before children, deletions after changes of the same type
		usort($records, fn ($a, $b) => [self::ORDER[$a['type'] ?? ''] ?? 9, !empty($a['deleted'])] <=> [self::ORDER[$b['type'] ?? ''] ?? 9, !empty($b['deleted'])]);

		$applied = 0;
		$rejected = [];
		foreach ($records as $rec) {
			$id = is_string($rec['id'] ?? null) ? $rec['id'] : '';
			try {
				$this->clock->setRemote(true);
				$this->applyOne($userId, $rec);
				$applied++;
			} catch (ServiceException|\InvalidArgumentException|\TypeError $e) {
				$rejected[] = ['id' => $id, 'reason' => $e->getMessage()];
			} finally {
				$this->clock->setRemote(false);
			}
		}
		$this->oneRunningSession($userId);
		return ['applied' => $applied, 'rejected' => $rejected, 'cursor' => $this->clock->currentSeq($userId)];
	}

	private function applyOne(string $userId, array $rec): void {
		$type = $rec['type'] ?? null;
		if (!is_string($type) || !isset(self::ORDER[$type])) {
			throw new ServiceException('Unknown type');
		}
		$clocks = $this->checkClocks($rec['clock'] ?? []);
		foreach ($clocks as $c) {
			$this->clock->observe($userId, $c);
		}
		if ($type === 'settings') {
			$this->applySettings($userId, is_array($rec['fields'] ?? null) ? $rec['fields'] : [], $clocks);
			return;
		}

		$id = $rec['id'] ?? null;
		if (!SyncClock::isUuid($id)) {
			throw new ServiceException('Invalid id');
		}
		$mapper = $this->mapper($type);
		$existing = $mapper->findByUuidOrNull($id);
		if ($existing !== null && $existing->getUserId() !== $userId) {
			throw new ServiceException('Not found');
		}
		if ($this->clock->isDeleted($userId, $id)) {
			return; // deleted stays deleted
		}
		if (!empty($rec['deleted'])) {
			if ($existing !== null) {
				$this->clock->setRemote(false); // the deletion itself gets a server tombstone
				$this->deleteCascade($type, $existing, $userId);
			}
			return;
		}

		$fields = is_array($rec['fields'] ?? null) ? $rec['fields'] : [];
		$isNew = $existing === null;
		$e = $existing ?? $this->newEntity($type, $userId, $id);
		$stored = SyncClock::decode($e->getClock());
		$before = $isNew ? [] : ['name' => $e instanceof Commitment ? $e->getName() : null, 'color' => $e instanceof Commitment ? $e->getColor() : null, 'url' => $e instanceof Commitment ? $e->getCalendarUrl() : null];
		$changed = [];

		foreach (SyncFields::MAP[$type] as $wire => $prop) {
			if (!array_key_exists($wire, $fields) || !isset($clocks[$wire])) {
				continue;
			}
			if ($wire === 'carriedBlocks') {
				// A set: union of both sides
				$incoming = is_array($fields[$wire]) ? $fields[$wire] : [];
				$e->setCarriedBlocks(array_merge($e->carriedBlocks(), array_filter($incoming, 'is_string')));
				$stored[$wire] = max($stored[$wire] ?? '', $clocks[$wire]);
				$changed[] = $wire;
				continue;
			}
			if (isset($stored[$wire]) && strcmp($clocks[$wire], $stored[$wire]) <= 0) {
				continue; // ours is as new or newer
			}
			$e->{'set' . ucfirst($prop)}($this->clean($type, $wire, $fields[$wire], $userId));
			$stored[$wire] = $clocks[$wire];
			$changed[] = $wire;
		}

		if ($isNew) {
			$this->requireFields($type, $e);
		}
		if ($e instanceof Session && $e->getEnd() !== null && $e->getEnd() < $e->getStart()) {
			$e->setEnd($e->getStart());
		}
		if ($changed === [] && !$isNew) {
			return;
		}
		$e->setClock(json_encode((object)$stored, JSON_UNESCAPED_SLASHES));
		$e = $isNew ? $mapper->insert($e) : $mapper->update($e);

		if ($e instanceof Commitment) {
			$this->afterCommitment($userId, $e, $isNew, $before, $changed);
		}
	}

	/** @return array<string, string> field => clock (valid ones only) */
	private function checkClocks(mixed $clock): array {
		if (!is_array($clock)) {
			return [];
		}
		$limit = (int)$this->time->now()->format('Uv') + self::MAX_AHEAD_MS;
		$out = [];
		foreach ($clock as $k => $v) {
			if (!is_string($k) || !is_string($v) || !preg_match(SyncClock::CLOCK_RE, $v)) {
				continue;
			}
			if (SyncClock::millis($v) > $limit) {
				throw new ServiceException('The device clock is too far ahead');
			}
			$out[$k] = $v;
		}
		return $out;
	}

	private function newEntity(string $type, string $userId, string $uuid): Entity {
		$now = $this->time->getTime();
		$e = match ($type) {
			'commitment' => new Commitment(),
			'task' => new Task(),
			'subtask' => new Subtask(),
			'note' => new Note(),
			'session' => new Session(),
		};
		$e->setUserId($userId);
		$e->setUuid($uuid);
		if ($e instanceof Commitment) {
			$e->setColor('#0082c9');
			$e->setPosition(0);
			$e->setBlockCheckedUntil($now);
			$e->setCreated($now);
		} elseif ($e instanceof Task) {
			$e->setPosition(0);
			$e->setDone(0);
			$e->setCarried(0);
			$e->setCreated($now);
		} elseif ($e instanceof Subtask || $e instanceof Note) {
			$e->setPosition(0);
			$e->setDone(0);
			$e->setCreated($now);
		} elseif ($e instanceof Session) {
			$e->setPomodoro(0);
			$e->setReminded(0);
		}
		return $e;
	}

	private function requireFields(string $type, Entity $e): void {
		$ok = match ($type) {
			'commitment' => (string)$e->getName() !== '',
			'task' => $e->getCommitmentId() !== null && (string)$e->getTitle() !== '',
			'subtask' => $e->getTaskId() !== null && (string)$e->getTitle() !== '',
			'note' => $e->getCommitmentId() !== null && (string)$e->getText() !== '',
			'session' => $e->getStart() !== null,
		};
		if (!$ok) {
			throw new ServiceException('Incomplete record');
		}
	}

	/** A field value from a device, checked and converted to what the database stores. */
	private function clean(string $type, string $field, mixed $v, string $userId): mixed {
		$int = function (mixed $x, int $min, int $max): int {
			if (!is_int($x) && !(is_float($x) && floor($x) === $x)) {
				throw new ServiceException('Invalid number');
			}
			return max($min, min($max, (int)$x));
		};
		$text = function (mixed $x, int $max, bool $required = true): ?string {
			if ($x === null && !$required) {
				return null;
			}
			if (!is_string($x)) {
				throw new ServiceException('Invalid text');
			}
			$x = trim($x);
			if ($x === '') {
				if ($required) {
					throw new ServiceException('Text is required');
				}
				return null;
			}
			return mb_substr($x, 0, $max);
		};
		$time = fn (mixed $x) => $x === null ? null : $int($x, 0, 32503680000);
		$bool = function (mixed $x): int {
			if (!is_bool($x)) {
				throw new ServiceException('Invalid flag');
			}
			return $x ? 1 : 0;
		};
		$ref = function (string $refType, mixed $uuid) use ($userId): ?int {
			if ($uuid === null) {
				return null;
			}
			if (!SyncClock::isUuid($uuid) || $this->clock->isDeleted($userId, $uuid)) {
				throw new ServiceException('Unknown ' . $refType);
			}
			$r = $this->mapper($refType)->findByUuidOrNull($uuid);
			if ($r === null || $r->getUserId() !== $userId) {
				throw new ServiceException('Unknown ' . $refType);
			}
			return (int)$r->getId();
		};

		return match ("$type.$field") {
			'commitment.name' => $text($v, 255),
			'commitment.color' => CalendarService::shortColor(is_string($v) ? $v : ''),
			'commitment.goal' => $v === null ? null : ($int($v, 0, 168 * 60) ?: null),
			'commitment.position', 'task.position', 'subtask.position', 'note.position' => $int($v, -1000000, 1000000),
			'commitment.calendarUrl' => $text($v, 1024, false),
			'commitment.created', 'task.created', 'subtask.created', 'note.created' => $int($v, 0, 32503680000),
			'task.commitment' => $ref('commitment', $v) ?? throw new ServiceException('Unknown commitment'),
			'task.title', 'subtask.title' => $text($v, 255),
			'task.note' => $text($v, 10000, false),
			'task.done', 'subtask.done', 'note.done' => $bool($v),
			'task.doneAt', 'subtask.doneAt', 'note.doneAt' => $time($v),
			'note.commitment' => $ref('commitment', $v) ?? throw new ServiceException('Unknown commitment'),
			'note.text' => NoteService::cleanText(is_string($v) ? $v : throw new ServiceException('Invalid text')),
			'subtask.task' => $ref('task', $v) ?? throw new ServiceException('Unknown task'),
			'subtask.estimate' => $v === null ? null : ($int($v, 0, 100000) ?: null),
			'session.commitment' => $ref('commitment', $v),
			'session.start' => $int($v, 0, 32503680000),
			'session.end' => $time($v),
			'session.blockUid' => $text($v, 512, false),
			'session.pomodoro' => $bool($v),
		};
	}

	/** Calendar side of a commitment that came from a device. */
	private function afterCommitment(string $userId, Commitment $c, bool $isNew, array $before, array $changed): void {
		$this->clock->setRemote(false); // what the server decides here gets its own clock
		$dirty = false;
		if (in_array('calendarUrl', $changed, true)) {
			$id = $c->getCalendarUrl() !== null ? $this->calendars->calendarIdForUrl($userId, $c->getCalendarUrl()) : null;
			if ($id !== $c->getCalendarId()) {
				$c->setCalendarId($id);
				$dirty = true;
			}
		}
		if ($c->getCalendarId() === null && $c->getCalendarUrl() === null) {
			// Created on a device without a calendar: create it here, like the web app does
			$calId = $this->calendars->createCalendar($userId, $c->getName(), $c->getColor());
			$cal = $this->calendars->getCalendar($userId, $calId);
			$c->setCalendarId($calId);
			$c->setCalendarUrl($cal !== null ? CalendarService::calendarUrl($userId, $cal['uri']) : null);
			$dirty = true;
		} elseif ($c->getCalendarId() !== null && !$isNew && ($c->getName() !== $before['name'] || $c->getColor() !== $before['color'])) {
			if ($this->calendars->getCalendar($userId, $c->getCalendarId()) !== null) {
				$this->calendars->updateCalendar($c->getCalendarId(), $c->getName(), $c->getColor());
			}
		}
		if ($dirty) {
			$this->commitments->update($c);
		}
	}

	private function deleteCascade(string $type, Entity $e, string $userId): void {
		if ($e instanceof Commitment) {
			foreach ($this->tasks->findForUser($userId, (int)$e->getId()) as $t) {
				$this->subtasks->deleteByTask((int)$t->getId());
				$this->tasks->delete($t);
			}
			$this->notes->deleteByCommitment($userId, (int)$e->getId());
			$this->sessions->unlinkCommitment($userId, (int)$e->getId());
		} elseif ($e instanceof Task) {
			$this->subtasks->deleteByTask((int)$e->getId());
		}
		$this->mapper($type)->delete($e);
	}

	private function applySettings(string $userId, array $fields, array $clocks): void {
		$meta = $this->clock->settingsMeta($userId);
		$values = [];
		$accepted = [];
		foreach (SyncFields::SETTINGS as $k) {
			if (!array_key_exists($k, $fields) || !isset($clocks[$k])) {
				continue;
			}
			if (isset($meta['clock'][$k]) && strcmp($clocks[$k], $meta['clock'][$k]) <= 0) {
				continue;
			}
			$v = $fields[$k];
			// Each setting has one type: a wrong one is ignored (and its clock not taken)
			$ok = match ($k) {
				'pomodoro' => is_bool($v),
				'longBreakUntil' => $v === null || is_int($v),
				default => is_int($v),
			};
			if (!$ok) {
				continue;
			}
			$accepted[$k] = $clocks[$k];
			$values[$k] = $v;
		}
		if (array_key_exists('longBreakUntil', $values)) {
			$v = $values['longBreakUntil'];
			$this->settings->setLongBreakUntil($userId, is_int($v) && $v > 0 ? $v : null, $accepted['longBreakUntil']);
			unset($values['longBreakUntil'], $accepted['longBreakUntil']);
		}
		if ($values !== []) {
			$this->settings->set($userId, $values, $accepted);
		}
	}

	/**
	 * Two devices may each have started a session offline. Only the newest
	 * keeps running; the others end when it started.
	 */
	private function oneRunningSession(string $userId): void {
		$running = $this->sessions->findRunningForUser($userId);
		if (count($running) < 2) {
			return;
		}
		$newest = array_pop($running);
		foreach ($running as $s) {
			$s->setEnd(max((int)$s->getStart(), (int)$newest->getStart()));
			$this->sessions->update($s);
		}
	}
}
