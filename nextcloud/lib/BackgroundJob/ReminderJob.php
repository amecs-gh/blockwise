<?php

declare(strict_types=1);

namespace OCA\Tracker\BackgroundJob;

use OCA\Tracker\Db\CommitmentMapper;
use OCA\Tracker\Db\SessionMapper;
use OCA\Tracker\Service\CommitmentService;
use OCA\Tracker\Service\NotificationService;
use OCA\Tracker\Service\PlanService;
use OCA\Tracker\Service\SessionService;
use OCA\Tracker\Service\SettingsService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\IJob;
use OCP\BackgroundJob\TimedJob;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Runs with every cron run (every 5 minutes with system cron):
 * - "block ends soon" reminder for running sessions
 * - Pomodoro: stop tracking at the long break, notify when it is over
 * - mark tasks of ended blocks as carried over
 *
 * The web page shows the same reminders to the minute while it is open;
 * this job covers the phone and a closed browser.
 */
class ReminderJob extends TimedJob {
	public function __construct(
		ITimeFactory $time,
		private SessionMapper $sessions,
		private CommitmentMapper $commitments,
		private CommitmentService $commitmentService,
		private SessionService $sessionService,
		private SettingsService $settings,
		private PlanService $plans,
		private NotificationService $notifications,
		private LoggerInterface $logger,
	) {
		parent::__construct($time);
		$this->setInterval(60);
		$this->setTimeSensitivity(IJob::TIME_SENSITIVE);
	}

	protected function run($argument): void {
		$now = $this->time->getTime();

		foreach ($this->sessions->findAllRunning() as $session) {
			try {
				$this->checkSession($session, $now);
			} catch (Throwable $e) {
				$this->logger->warning('Reminder check failed', ['exception' => $e]);
			}
		}

		foreach ($this->settings->allLongBreaks() as $userId => $until) {
			if ($until <= $now) {
				$this->settings->setLongBreakUntil($userId, null);
				$this->notifications->dismiss($userId, 'long_break', 'pomodoro');
				$this->notifications->send($userId, 'back_to_work', 'pomodoro');
			}
		}

		foreach ($this->commitments->findUserIds() as $userId) {
			try {
				$this->plans->processEndedBlocks($userId);
			} catch (Throwable $e) {
				$this->logger->warning('Carry-over check failed', ['exception' => $e]);
			}
		}
	}

	private function checkSession(\OCA\Tracker\Db\Session $session, int $now): void {
		$userId = $session->getUserId();
		$settings = $this->settings->get($userId);

		if ($session->getPomodoro()) {
			$longAt = SettingsService::pomodoroLongBreakAt($session->getStart(), $settings);
			if ($now >= $longAt) {
				$this->sessionService->stop($userId, $longAt, true);
				$this->notifications->send($userId, 'long_break', 'pomodoro', ['minutes' => (int)$settings['longBreakMinutes']]);
				return;
			}
		}

		$reminder = (int)$settings['reminderMinutes'] * 60;
		if ($session->getCommitmentId() === null || $reminder <= 0) {
			return;
		}
		$c = $this->commitments->find($session->getCommitmentId(), $userId);
		$current = null;
		foreach ($this->commitmentService->blocks($userId, $now, $now + 1, [$c]) as $b) {
			$current = $b;
			break;
		}
		if ($current === null) {
			return;
		}
		if ($session->getBlockUid() !== $current['uid']) {
			// Tracking continued into another block: remind again for that one
			$session->setBlockUid($current['uid']);
			$session->setReminded(0);
			$this->sessions->update($session);
		}
		$left = $current['end'] - $now;
		if (!$session->getReminded() && $left > 0 && $left <= $reminder) {
			$this->notifications->send($userId, 'block_ending', (string)$session->getId(), [
				'minutes' => (int)ceil($left / 60),
				'commitment' => $c->getName(),
			]);
			$session->setReminded(1);
			$this->sessions->update($session);
		}
	}
}
