<?php

declare(strict_types=1);

namespace OCA\Tracker\Listener;

use OCA\DAV\Events\CalendarDeletedEvent;
use OCA\DAV\Events\CalendarMovedToTrashEvent;
use OCA\DAV\Events\CalendarUpdatedEvent;
use OCA\Tracker\Db\CommitmentMapper;
use OCA\Tracker\Service\CalendarService;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Keeps commitments in sync when their calendar is renamed, recolored or
 * deleted in the Calendar app.
 *
 * @template-implements IEventListener<CalendarUpdatedEvent|CalendarDeletedEvent|CalendarMovedToTrashEvent>
 */
class CalendarChangeListener implements IEventListener {
	public function __construct(
		private CommitmentMapper $commitments,
		private CalendarService $calendars,
		private LoggerInterface $logger,
	) {
	}

	public function handle(Event $event): void {
		if (!($event instanceof CalendarUpdatedEvent || $event instanceof CalendarDeletedEvent || $event instanceof CalendarMovedToTrashEvent)) {
			return;
		}
		try {
			foreach ($this->commitments->findByCalendar($event->getCalendarId()) as $c) {
				$cal = $event instanceof CalendarUpdatedEvent
					? $this->calendars->getCalendar($c->getUserId(), $event->getCalendarId())
					: null;
				if ($cal === null) {
					$c->setCalendarId(null);
				} else {
					$c->setName($cal['name']);
					$c->setColor($cal['color']);
				}
				$this->commitments->update($c);
			}
		} catch (Throwable $e) {
			$this->logger->warning('Calendar sync failed', ['exception' => $e]);
		}
	}
}
