<?php

declare(strict_types=1);

namespace OCA\Tracker\Listener;

use DateTimeImmutable;
use OCA\Tracker\Db\CommitmentMapper;
use OCA\Tracker\Service\CalendarService;
use OCA\Tracker\Service\CommitmentService;
use OCA\Tracker\Service\NotificationService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\Calendar\Events\AbstractCalendarObjectEvent;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * When an event is saved in a commitment calendar, warn if it overlaps a
 * block of another commitment. Calendars that aren't commitments are ignored.
 *
 * @template-implements IEventListener<AbstractCalendarObjectEvent>
 */
class CalendarObjectListener implements IEventListener {
	/** Only look this far ahead for recurring events */
	private const HORIZON = 366 * 86400;

	public function __construct(
		private CommitmentMapper $commitments,
		private CommitmentService $commitmentService,
		private CalendarService $calendars,
		private NotificationService $notifications,
		private ITimeFactory $time,
		private LoggerInterface $logger,
	) {
	}

	public function handle(Event $event): void {
		if (!$event instanceof AbstractCalendarObjectEvent) {
			return;
		}
		try {
			$this->check($event);
		} catch (Throwable $e) {
			// Never break saving an event because of this app
			$this->logger->warning('Overlap check failed', ['exception' => $e]);
		}
	}

	private function check(AbstractCalendarObjectEvent $event): void {
		$linked = $this->commitments->findByCalendar($event->getCalendarId());
		if ($linked === []) {
			return;
		}
		$commitment = $linked[0];
		$userId = $commitment->getUserId();
		$data = (string)($event->getObjectData()['calendardata'] ?? '');
		if ($data === '') {
			return;
		}

		$now = $this->time->getTime();
		$from = new DateTimeImmutable('@' . ($now - 86400));
		$to = new DateTimeImmutable('@' . ($now + self::HORIZON));
		$own = $this->calendars->blocksFromData($data, $event->getCalendarId(), $from, $to);
		if ($own === []) {
			return;
		}
		$own = array_slice($own, 0, 200);
		foreach ($own as &$b) {
			$b['commitmentId'] = $commitment->getId();
		}
		unset($b);

		$others = array_filter(
			$this->commitments->findAllForUser($userId),
			fn ($c) => $c->getId() !== $commitment->getId() && $c->getCalendarId() !== null,
		);
		if ($others === []) {
			return;
		}
		$rangeStart = min(array_column($own, 'start'));
		$rangeEnd = max(array_column($own, 'end'));
		$blocks = array_merge($own, $this->commitmentService->blocks($userId, $rangeStart, $rangeEnd, array_values($others)));
		usort($blocks, fn ($a, $b) => $a['start'] <=> $b['start']);

		$names = [];
		foreach ($this->commitments->findAllForUser($userId) as $c) {
			$names[$c->getId()] = $c->getName();
		}

		$ownUids = array_flip(array_column($own, 'uid'));
		foreach (CommitmentService::findOverlaps($blocks) as $o) {
			if (!isset($ownUids[$o['a']['uid']]) && !isset($ownUids[$o['b']['uid']])) {
				continue;
			}
			$this->notifications->send($userId, 'overlap', $o['a']['uid'] . '|' . $o['b']['uid'], [
				// Event titles can come from invitations: keep them short
				'a' => mb_substr($o['a']['title'] !== '' ? $o['a']['title'] : ($names[$o['a']['commitmentId']] ?? ''), 0, 100),
				'b' => mb_substr($o['b']['title'] !== '' ? $o['b']['title'] : ($names[$o['b']['commitmentId']] ?? ''), 0, 100),
				'start' => $o['start'],
			]);
			return; // one notification per save is enough; the app lists all overlaps
		}
	}
}
