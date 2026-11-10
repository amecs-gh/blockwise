<?php

declare(strict_types=1);

namespace OCA\Tracker\Listener;

use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\IDBConnection;
use OCP\User\Events\UserDeletedEvent;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Removes everything Tracker stored for a user when the account is deleted.
 * (Calendars belong to the Calendar app and are removed by Nextcloud.)
 *
 * @template-implements IEventListener<UserDeletedEvent>
 */
class UserDeletedListener implements IEventListener {
	private const TABLES = ['tracker_sessions', 'tracker_notes', 'tracker_subtasks', 'tracker_tasks', 'tracker_commitments', 'tracker_tombstones', 'tracker_sync_state'];

	public function __construct(
		private IDBConnection $db,
		private LoggerInterface $logger,
	) {
	}

	public function handle(Event $event): void {
		if (!$event instanceof UserDeletedEvent) {
			return;
		}
		$userId = $event->getUser()->getUID();
		try {
			foreach (self::TABLES as $table) {
				$qb = $this->db->getQueryBuilder();
				$qb->delete($table)->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
				$qb->executeStatement();
			}
		} catch (Throwable $e) {
			$this->logger->error('Could not remove Tracker data of a deleted user', ['exception' => $e]);
		}
	}
}
