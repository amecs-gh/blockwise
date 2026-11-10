<?php

declare(strict_types=1);

namespace OCA\Tracker\Service;

use OCA\Tracker\AppInfo\Application;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\Notification\IManager;

/**
 * Sends Nextcloud notifications (web + mobile push). Rendering is in Notifier.
 */
class NotificationService {
	public function __construct(
		private IManager $manager,
		private ITimeFactory $time,
	) {
	}

	/**
	 * @param string $subject overlap | block_ending | long_break | back_to_work
	 * @param string $objectId used to replace an earlier notification about the same thing
	 */
	public function send(string $userId, string $subject, string $objectId, array $params = []): void {
		$this->dismiss($userId, $subject, $objectId);
		$n = $this->manager->createNotification();
		$n->setApp(Application::APP_ID)
			->setUser($userId)
			->setDateTime($this->time->getDateTime())
			->setObject($subject, substr($objectId, 0, 64))
			->setSubject($subject, $params);
		$this->manager->notify($n);
	}

	public function dismiss(string $userId, string $subject, string $objectId): void {
		$n = $this->manager->createNotification();
		$n->setApp(Application::APP_ID)
			->setUser($userId)
			->setObject($subject, substr($objectId, 0, 64));
		$this->manager->markProcessed($n);
	}
}
