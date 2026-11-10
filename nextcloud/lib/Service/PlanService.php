<?php

declare(strict_types=1);

namespace OCA\Tracker\Service;

use OCA\Tracker\Db\Commitment;
use OCA\Tracker\Db\CommitmentMapper;
use OCA\Tracker\Db\Task;
use OCA\Tracker\Db\TaskMapper;
use OCP\AppFramework\Utility\ITimeFactory;

/**
 * Which tasks go into a block, and carrying unfinished ones over.
 *
 * The queue of a commitment is its open tasks in order. A block takes tasks
 * from the front of the queue until the estimates of their open subtasks fill
 * the block (at least one task). Nothing has to be moved when a block ends: unfinished tasks are
 * still at the front, so the next block starts with them. The "carried" counter
 * only records how often a task was planned into a block that ended without it
 * being finished.
 */
class PlanService {
	public function __construct(
		private CommitmentMapper $commitments,
		private TaskMapper $tasks,
		private TaskService $taskService,
		private CommitmentService $commitmentService,
		private SettingsService $settings,
		private ITimeFactory $time,
	) {
	}

	/**
	 * @param Task[] $queue in order
	 * @return Task[] the tasks planned for a block of $seconds
	 */
	public static function fill(array $queue, int $seconds, int $defaultEstimateMinutes, ?int $at = null): array {
		$planned = [];
		$used = 0;
		foreach ($queue as $t) {
			if ($planned !== [] && $used >= $seconds) {
				break;
			}
			$planned[] = $t;
			$used += $t->remainingSeconds($defaultEstimateMinutes, $at);
		}
		return $planned;
	}

	/**
	 * Marks tasks that were planned into blocks that ended since the last
	 * check and are still open. Safe to call often.
	 */
	public function processEndedBlocks(string $userId): void {
		$now = $this->time->getTime();
		$settings = $this->settings->get($userId);
		foreach ($this->commitments->findAllForUser($userId) as $c) {
			$since = max($c->getBlockCheckedUntil(), $now - 14 * 86400);
			if ($c->getCalendarId() !== null && $since < $now) {
				$this->processCommitment($userId, $c, $since, $now, (int)$settings['defaultEstimate']);
			}
			$c->setBlockCheckedUntil($now);
			$this->commitments->update($c);
		}
	}

	private function processCommitment(string $userId, Commitment $c, int $since, int $now, int $defaultEstimate): void {
		// Blocks that ended in (since, now]
		$ended = array_filter(
			$this->commitmentService->blocks($userId, $since - 86400, $now, [$c]),
			fn ($b) => $b['end'] > $since && $b['end'] <= $now,
		);
		if ($ended === []) {
			return;
		}
		$all = $this->taskService->attachSubtasks($this->tasks->findForUser($userId, $c->getId()));
		foreach ($ended as $block) {
			// The queue as it was when the block started: open now, or finished since then
			$queue = array_values(array_filter(
				$all,
				fn (Task $t) => $t->getCreated() < $block['end'] && (!$t->getDone() || (int)$t->getDoneAt() >= $block['start']),
			));
			foreach (self::fill($queue, $block['end'] - $block['start'], $defaultEstimate, $block['start']) as $t) {
				// One mark per block occurrence: counting it again (here or on a device) changes nothing
				$mark = $block['uid'] . '@' . $block['start'];
				if (!$t->getDone() && !in_array($mark, $t->carriedBlocks(), true)) {
					$t->setCarriedBlocks(array_merge($t->carriedBlocks(), [$mark]));
					$this->tasks->update($t);
				}
			}
		}
	}

	/**
	 * Everything the control panel needs.
	 */
	public function dashboard(string $userId, SessionService $sessions): array {
		$now = $this->time->getTime();
		$this->processEndedBlocks($userId);
		$commitments = $this->commitmentService->listSynced($userId);
		$settings = $this->settings->get($userId);
		$horizon = $now + 14 * 86400;
		$blocks = $this->commitmentService->blocks($userId, $now - 86400, $horizon, $commitments);
		$open = $this->taskService->list($userId, null, false);

		$out = [];
		foreach ($commitments as $c) {
			$own = array_values(array_filter($blocks, fn ($b) => $b['commitmentId'] === $c->getId() && $b['end'] > $now));
			$current = null;
			$next = null;
			foreach ($own as $b) {
				if ($b['start'] <= $now && $b['end'] > $now) {
					$current = $b;
				} elseif ($b['start'] > $now) {
					$next = $b;
					break;
				}
			}
			$queue = array_values(array_filter($open, fn (Task $t) => $t->getCommitmentId() === $c->getId()));
			$target = $current ?? $next;
			$planned = $target !== null
				? self::fill($queue, $target['end'] - max($now, $target['start']), (int)$settings['defaultEstimate'])
				: array_slice($queue, 0, 3);
			$plannedIds = array_map(fn (Task $t) => $t->getId(), $planned);

			// Next 7 days: block time in the calendar vs. the work left in open tasks
			$horizon7 = $now + 7 * 86400;
			$blockSeconds = 0;
			foreach ($own as $b) {
				$blockSeconds += max(0, min($b['end'], $horizon7) - max($b['start'], $now));
			}
			$neededSeconds = 0;
			foreach ($queue as $t) {
				$neededSeconds += $t->remainingSeconds((int)$settings['defaultEstimate']);
			}

			$out[] = [
				'commitment' => $c,
				'currentBlock' => $current,
				'nextBlock' => $next,
				'upcoming' => array_slice($own, 0, 5),
				'plannedTaskIds' => $plannedIds,
				'queue' => $queue,
				'capacity' => ['days' => 7, 'blockSeconds' => $blockSeconds, 'neededSeconds' => $neededSeconds],
			];
		}

		return [
			'now' => $now,
			'commitments' => $out,
			'overlaps' => CommitmentService::findOverlaps(array_values(array_filter($blocks, fn ($b) => $b['end'] > $now))),
			'running' => $sessions->running($userId),
			'longBreakUntil' => $this->settings->getLongBreakUntil($userId),
			'settings' => $settings,
		];
	}
}
