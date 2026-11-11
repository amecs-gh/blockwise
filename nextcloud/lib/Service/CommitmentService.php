<?php

declare(strict_types=1);

namespace OCA\Tracker\Service;

use OCA\Tracker\Db\Commitment;
use OCA\Tracker\Db\CommitmentMapper;
use OCA\Tracker\Db\NoteMapper;
use OCA\Tracker\Db\SessionMapper;
use OCA\Tracker\Db\SubtaskMapper;
use OCA\Tracker\Db\TaskMapper;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IDBConnection;

/**
 * Commitments and their one-to-one link with a Nextcloud calendar.
 */
class CommitmentService {
	public function __construct(
		private CommitmentMapper $mapper,
		private TaskMapper $taskMapper,
		private SubtaskMapper $subtaskMapper,
		private SessionMapper $sessionMapper,
		private NoteMapper $noteMapper,
		private CalendarService $calendars,
		private ITimeFactory $time,
		private IDBConnection $db,
	) {
	}

	/**
	 * Commitments of the user, after pulling name/color changes made in the
	 * Calendar app and unlinking calendars that no longer exist.
	 *
	 * @return Commitment[]
	 */
	public function listSynced(string $userId): array {
		$list = $this->mapper->findAllForUser($userId);
		foreach ($list as $c) {
			if ($c->getCalendarId() === null) {
				continue;
			}
			$cal = $this->calendars->getCalendar($userId, $c->getCalendarId());
			if ($cal === null) {
				$c->setCalendarId(null);
				$this->mapper->update($c);
				continue;
			}
			$url = CalendarService::calendarUrl($userId, $cal['uri']);
			if ($cal['name'] !== $c->getName() || $cal['color'] !== $c->getColor() || $c->getCalendarUrl() !== $url) {
				$c->setName($cal['name']);
				$c->setColor($cal['color']);
				$c->setCalendarUrl($url);
				$this->mapper->update($c);
			}
		}
		return $list;
	}

	public function get(string $userId, int $id): Commitment {
		return $this->mapper->find($id, $userId);
	}

	/**
	 * @param int|null $calendarId link an existing calendar; null = create a new one
	 */
	public function create(string $userId, string $name, string $color, ?int $calendarId): Commitment {
		$color = CalendarService::shortColor($color);

		if ($calendarId !== null) {
			$cal = $this->calendars->getCalendar($userId, $calendarId);
			if ($cal === null) {
				throw new ServiceException('Calendar not found');
			}
			foreach ($this->mapper->findAllForUser($userId) as $existing) {
				if ($existing->getCalendarId() === $calendarId) {
					throw new ServiceException('This calendar is already a commitment');
				}
			}
			// Linking an existing calendar keeps its name and color
			$name = $cal['name'];
			$color = $cal['color'];
		} else {
			$name = $this->cleanName($name);
			$calendarId = $this->calendars->createCalendar($userId, $name, $color);
		}

		$c = new Commitment();
		$c->setUserId($userId);
		$c->setName($name);
		$c->setColor($color);
		$c->setCalendarId($calendarId);
		$c->setPosition(count($this->mapper->findAllForUser($userId)));
		// Blocks before today don't count as "missed" for carry-over
		$c->setBlockCheckedUntil($this->time->getTime());
		$c->setCreated($this->time->getTime());
		return $this->mapper->insert($c);
	}

	public function update(string $userId, int $id, ?string $name, ?string $color, ?int $calendarId, bool $relink, ?int $weeklyGoal = null, bool $setGoal = false): Commitment {
		$c = $this->mapper->find($id, $userId);
		if ($setGoal) {
			$c->setWeeklyGoal($weeklyGoal !== null && $weeklyGoal > 0 ? min($weeklyGoal, 168 * 60) : null);
		}
		if ($name !== null) {
			$c->setName($this->cleanName($name));
		}
		if ($color !== null) {
			$c->setColor(CalendarService::shortColor($color));
		}
		if ($relink) {
			if ($calendarId === null) {
				$calendarId = $this->calendars->createCalendar($userId, $c->getName(), $c->getColor());
			} elseif ($this->calendars->getCalendar($userId, $calendarId) === null) {
				throw new ServiceException('Calendar not found');
			}
			$c->setCalendarId($calendarId);
		}
		$this->mapper->update($c);
		// Only ever write to a calendar the user still owns
		if ($c->getCalendarId() !== null && $this->calendars->getCalendar($userId, $c->getCalendarId()) !== null) {
			$this->calendars->updateCalendar($c->getCalendarId(), $c->getName(), $c->getColor());
		}
		return $c;
	}

	/**
	 * Deletes the commitment, its tasks and notes; tracked time stays in the
	 * statistics as unplanned time. The calendar is kept, unless `withCalendar`:
	 * then it goes to Nextcloud's trash bin with its events, first (only the
	 * user's own calendar, and only if no other commitment uses it).
	 */
	public function delete(string $userId, int $id, bool $withCalendar = false): void {
		$c = $this->mapper->find($id, $userId);
		if ($withCalendar && $c->getCalendarId() !== null) {
			$this->trashCalendar($userId, $c->getCalendarId());
		}
		$this->db->beginTransaction();
		try {
			foreach ($this->taskMapper->findForUser($userId, $id) as $task) {
				$this->subtaskMapper->deleteByTask($task->getId());
			}
			$this->taskMapper->deleteByCommitment($userId, $id);
			$this->sessionMapper->unlinkCommitment($userId, $id);
			$this->mapper->delete($c);
			$this->db->commit();
		} catch (\Throwable $e) {
			$this->db->rollBack();
			throw $e;
		}
	}

	/**
	 * Moves a commitment's calendar to the trash bin (the Mac app asks before it
	 * deletes the commitment). Only a calendar of exactly one of the user's
	 * commitments: never one the user just has, or one two commitments share.
	 */
	public function trashCalendar(string $userId, int $calendarId): void {
		$users = array_filter($this->mapper->findAllForUser($userId), fn (Commitment $c) => $c->getCalendarId() === $calendarId);
		if (count($users) !== 1) {
			throw new ServiceException('This calendar is not a commitment\'s own calendar');
		}
		$this->calendars->trashCalendar($userId, $calendarId);
	}

	/** @param int[] $ids */
	public function reorder(string $userId, array $ids): void {
		$pos = 0;
		foreach (array_slice($ids, 0, 500) as $id) {
			$c = $this->mapper->find((int)$id, $userId);
			$c->setPosition($pos++);
			$this->mapper->update($c);
		}
	}

	/**
	 * Blocks of all commitments in [from, to), each tagged with its commitment.
	 *
	 * @param Commitment[]|null $commitments
	 * @return list<array{uid: string, title: string, start: int, end: int, calendarId: int, commitmentId: int}>
	 */
	public function blocks(string $userId, int $from, int $to, ?array $commitments = null): array {
		$commitments ??= $this->mapper->findAllForUser($userId);
		$all = [];
		foreach ($commitments as $c) {
			// Re-check ownership: a calendar can be transferred to someone else or moved to the trash
			if ($c->getCalendarId() === null || $c->getUserId() !== $userId || $this->calendars->getCalendar($userId, $c->getCalendarId()) === null) {
				continue;
			}
			foreach ($this->calendars->getBlocks($c->getCalendarId(), $from, $to) as $b) {
				$b['commitmentId'] = $c->getId();
				$all[] = $b;
			}
		}
		usort($all, fn ($a, $b) => $a['start'] <=> $b['start']);
		return $all;
	}

	/**
	 * Pairs of blocks from different commitments that overlap in time.
	 *
	 * @param list<array{uid: string, title: string, start: int, end: int, commitmentId: int}> $blocks sorted by start
	 * @return list<array{a: array, b: array, start: int, end: int}>
	 */
	public static function findOverlaps(array $blocks): array {
		$overlaps = [];
		$n = count($blocks);
		for ($i = 0; $i < $n; $i++) {
			for ($j = $i + 1; $j < $n && $blocks[$j]['start'] < $blocks[$i]['end']; $j++) {
				if ($blocks[$j]['commitmentId'] === $blocks[$i]['commitmentId']) {
					continue;
				}
				$overlaps[] = [
					'a' => $blocks[$i],
					'b' => $blocks[$j],
					'start' => max($blocks[$i]['start'], $blocks[$j]['start']),
					'end' => min($blocks[$i]['end'], $blocks[$j]['end']),
				];
			}
		}
		return $overlaps;
	}

	private function cleanName(string $name): string {
		$name = trim($name);
		if ($name === '') {
			throw new ServiceException('Name is required');
		}
		return mb_substr($name, 0, 255);
	}
}
