<?php

declare(strict_types=1);

namespace OCA\Tracker\Service;

use OCA\Tracker\Db\CommitmentMapper;
use OCA\Tracker\Db\Session;
use OCA\Tracker\Db\SessionMapper;
use OCP\AppFramework\Utility\ITimeFactory;

/**
 * Time tracking (play/stop). One running session per user at most.
 */
class SessionService {
	public function __construct(
		private SessionMapper $sessions,
		private CommitmentMapper $commitments,
		private CommitmentService $commitmentService,
		private SettingsService $settings,
		private NotificationService $notifications,
		private ITimeFactory $time,
	) {
	}

	public function running(string $userId): ?Session {
		return $this->sessions->findRunning($userId);
	}

	/**
	 * @param int|null $commitmentId null = unplanned time
	 * @param bool|null $pomodoro null = use the setting
	 */
	public function start(string $userId, ?int $commitmentId, ?bool $pomodoro = null): Session {
		$now = $this->time->getTime();
		$running = $this->sessions->findRunning($userId);
		if ($running !== null) {
			$this->finish($running, $now);
		}

		$blockUid = null;
		if ($commitmentId !== null) {
			$c = $this->commitments->find($commitmentId, $userId);
			foreach ($this->commitmentService->blocks($userId, $now, $now + 1, [$c]) as $b) {
				$blockUid = $b['uid'];
				break;
			}
		}

		$settings = $this->settings->get($userId);
		$s = new Session();
		$s->setUserId($userId);
		$s->setCommitmentId($commitmentId);
		$s->setStart($now);
		$s->setEnd(null);
		$s->setBlockUid($blockUid);
		$s->setPomodoro(($pomodoro ?? (bool)$settings['pomodoro']) ? 1 : 0);
		$s->setReminded(0);

		// A new focus session ends any long break
		$this->settings->setLongBreakUntil($userId, null);
		$this->notifications->dismiss($userId, 'long_break', 'pomodoro');
		$this->notifications->dismiss($userId, 'back_to_work', 'pomodoro');

		return $this->sessions->insert($s);
	}

	/**
	 * @param int|null $at end time; null = now. Never later than now or earlier than the start.
	 * @param bool $longBreak the Pomodoro cycle reached its long break
	 */
	public function stop(string $userId, ?int $at = null, bool $longBreak = false): ?Session {
		$running = $this->sessions->findRunning($userId);
		if ($running === null) {
			return null;
		}
		$s = $this->finish($running, $at ?? $this->time->getTime());
		if ($longBreak) {
			$settings = $this->settings->get($userId);
			$this->settings->setLongBreakUntil($userId, (int)$s->getEnd() + (int)$settings['longBreakMinutes'] * 60);
		}
		return $s;
	}

	private function finish(Session $s, int $at): Session {
		$now = $this->time->getTime();
		$s->setEnd(max($s->getStart(), min($at, $now)));
		$this->sessions->update($s);
		$this->notifications->dismiss($s->getUserId(), 'block_ending', (string)$s->getId());
		return $s;
	}

	/**
	 * You started earlier than you pressed play: the running session starts
	 * earlier (at most 12 hours back). Right after a switch, the session before
	 * ends then too; otherwise the start can't reach into it.
	 * @return array the session, and `clamped` when the start had to move
	 */
	public function moveStart(string $userId, int $id, int $want): array {
		$s = $this->sessions->find($id, $userId);
		if ($s->getEnd() !== null) {
			throw new ServiceException('Only the running session can be changed');
		}
		$now = $this->time->getTime();
		$start = max($now - 12 * 3600, min($want, $now));
		$prev = null;
		foreach ($this->sessions->findBetween($userId, $now - 36 * 3600, (int)$s->getStart() + 1) as $o) {
			if ($o->getId() !== $s->getId() && $o->getEnd() !== null && $o->getEnd() <= $s->getStart() && ($prev === null || $o->getEnd() > $prev->getEnd())) {
				$prev = $o;
			}
		}
		if ($prev !== null && $s->getStart() - $prev->getEnd() <= 1) {
			$start = max($start, (int)$prev->getStart() + 60); // the one before keeps at least a minute
			$prev->setEnd($start);
			$this->sessions->update($prev);
		} elseif ($prev !== null) {
			$start = max($start, (int)$prev->getEnd());
		}
		$s->setStart($start);
		$this->sessions->update($s);
		return $s->jsonSerialize() + ['clamped' => $start !== $want];
	}

	/**
	 * Time you worked but didn't track, added afterwards: in the past, at most
	 * 24 hours, and over no other tracked time (it would count twice).
	 */
	public function add(string $userId, ?int $commitmentId, int $start, int $end): Session {
		$now = $this->time->getTime();
		if ($start < 946684800) {
			throw new ServiceException('Invalid time');
		}
		if ($end <= $start) {
			throw new ServiceException('The end must be after the start');
		}
		if ($end > $now) {
			throw new ServiceException('Tracked time can only be added for the past');
		}
		if ($end - $start > 86400) {
			throw new ServiceException('At most 24 hours at once');
		}
		$blockUid = null;
		if ($commitmentId !== null) {
			$c = $this->commitments->find($commitmentId, $userId);
			foreach ($this->commitmentService->blocks($userId, $start, $end, [$c]) as $b) {
				$blockUid = $b['uid'];
				break;
			}
		}
		if ($this->sessions->findBetween($userId, $start, $end) !== []) {
			throw new ServiceException('This overlaps time you tracked already');
		}
		$s = new Session();
		$s->setUserId($userId);
		$s->setCommitmentId($commitmentId);
		$s->setStart($start);
		$s->setEnd($end);
		$s->setBlockUid($blockUid);
		$s->setPomodoro(0);
		$s->setReminded(1);
		return $this->sessions->insert($s);
	}

	/** @return Session[] */
	public function list(string $userId, int $from, int $to): array {
		return $this->sessions->findBetween($userId, $from, $to);
	}

	public function delete(string $userId, int $id): void {
		$this->sessions->delete($this->sessions->find($id, $userId));
	}
}
