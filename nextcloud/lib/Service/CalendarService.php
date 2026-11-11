<?php

declare(strict_types=1);

namespace OCA\Tracker\Service;

use DateTimeImmutable;
use DateTimeZone;
use OCA\DAV\CalDAV\CalDavBackend;
use Psr\Log\LoggerInterface;
use Sabre\DAV\PropPatch;
use Sabre\VObject\Component\VCalendar;
use Sabre\VObject\Component\VEvent;
use Sabre\VObject\Reader;
use Throwable;

/**
 * Thin layer over Nextcloud's CalDAV backend: list/create/update the user's
 * calendars and read events as "blocks".
 */
class CalendarService {
	private const P_NAME = '{DAV:}displayname';
	private const P_COLOR = '{http://apple.com/ns/ical/}calendar-color';
	private const P_DELETED = '{http://nextcloud.com/ns}deleted-at';
	private const P_COMPONENTS = '{urn:ietf:params:xml:ns:caldav}supported-calendar-component-set';

	public function __construct(
		private CalDavBackend $backend,
		private LoggerInterface $logger,
	) {
	}

	public static function principal(string $userId): string {
		return 'principals/users/' . $userId;
	}

	/**
	 * The calendar's address on this server, as CalDAV clients (DAVx5, Apple
	 * Calendar) know it: how other devices find the same calendar.
	 */
	public static function calendarUrl(string $userId, string $uri): string {
		return '/remote.php/dav/calendars/' . rawurlencode($userId) . '/' . rawurlencode($uri) . '/';
	}

	/** The user's own calendar at this address (or a full URL ending in it), or null. */
	public function calendarIdForUrl(string $userId, string $url): ?int {
		$prefix = '/remote.php/dav/calendars/' . rawurlencode($userId) . '/';
		$path = (string)(parse_url($url, PHP_URL_PATH) ?? '');
		$at = strpos($path, $prefix);
		if ($at === false) {
			return null;
		}
		$uri = rawurldecode(trim(substr($path, $at + strlen($prefix)), '/'));
		if ($uri === '' || str_contains($uri, '/')) {
			return null;
		}
		$cal = $this->backend->getCalendarByUri(self::principal($userId), $uri);
		if ($cal === null) {
			return null;
		}
		return $this->getCalendar($userId, (int)$cal['id']) !== null ? (int)$cal['id'] : null;
	}

	/**
	 * Calendars owned by the user that can hold events.
	 *
	 * @return array<int, array{id: int, uri: string, name: string, color: string}>
	 */
	public function listCalendars(string $userId): array {
		$principal = self::principal($userId);
		$out = [];
		foreach ($this->backend->getCalendarsForUser($principal) as $cal) {
			$normalized = $this->normalize($cal, $principal);
			if ($normalized !== null) {
				$out[$normalized['id']] = $normalized;
			}
		}
		return $out;
	}

	/** @return array{id: int, uri: string, name: string, color: string}|null null if missing, trashed or not the user's */
	public function getCalendar(string $userId, int $calendarId): ?array {
		$cal = $this->backend->getCalendarById($calendarId);
		if ($cal === null) {
			return null;
		}
		return $this->normalize($cal, self::principal($userId));
	}

	private function normalize(array $cal, string $principal): ?array {
		if (($cal['principaluri'] ?? '') !== $principal) {
			return null; // shared with the user, not owned
		}
		if (($cal['uri'] ?? '') === 'contact_birthdays' || !empty($cal[self::P_DELETED])) {
			return null;
		}
		$components = $cal[self::P_COMPONENTS] ?? null;
		if ($components !== null && method_exists($components, 'getValue') && !in_array('VEVENT', $components->getValue(), true)) {
			return null; // task-only list etc.
		}
		return [
			'id' => (int)$cal['id'],
			'uri' => (string)$cal['uri'],
			'name' => (string)($cal[self::P_NAME] ?? $cal['uri']),
			'color' => self::shortColor((string)($cal[self::P_COLOR] ?? '#0082c9')),
		];
	}

	/** Calendar app stores #RRGGBBAA sometimes; we use #RRGGBB. */
	public static function shortColor(string $color): string {
		if (preg_match('/^#[0-9a-fA-F]{8}$/', $color)) {
			return substr($color, 0, 7);
		}
		return preg_match('/^#[0-9a-fA-F]{6}$/', $color) ? $color : '#0082c9';
	}

	public function createCalendar(string $userId, string $name, string $color): int {
		$principal = self::principal($userId);
		$existing = array_column($this->backend->getCalendarsForUser($principal), 'uri');
		$base = trim(preg_replace('/[^a-z0-9]+/', '-', strtolower($name)) ?? '', '-') ?: 'commitment';
		$base = substr($base, 0, 200);
		$uri = $base;
		for ($i = 2; in_array($uri, $existing, true); $i++) {
			$uri = $base . '-' . $i;
		}
		return (int)$this->backend->createCalendar($principal, $uri, [
			self::P_NAME => $name,
			self::P_COLOR => $color,
			self::P_COMPONENTS => new \Sabre\CalDAV\Xml\Property\SupportedCalendarComponentSet(['VEVENT']),
		]);
	}

	/**
	 * Moves the user's own calendar, with its events, to Nextcloud's trash bin
	 * (the Calendar app can restore it while the server keeps deleted items).
	 */
	public function trashCalendar(string $userId, int $calendarId): void {
		if ($this->getCalendar($userId, $calendarId) === null) {
			throw new ServiceException('Calendar not found');
		}
		$this->backend->deleteCalendar($calendarId, false);
	}

	public function updateCalendar(int $calendarId, string $name, string $color): void {
		$patch = new PropPatch([self::P_NAME => $name, self::P_COLOR => $color]);
		$this->backend->updateCalendar($calendarId, $patch);
		$patch->commit();
	}

	/**
	 * Timed events of a calendar overlapping [from, to), recurring events expanded.
	 * All-day events are not blocks and are skipped.
	 *
	 * @return list<array{uid: string, title: string, start: int, end: int, calendarId: int}>
	 */
	public function getBlocks(int $calendarId, int $from, int $to): array {
		$utc = new DateTimeZone('UTC');
		$start = (new DateTimeImmutable('@' . $from))->setTimezone($utc);
		$end = (new DateTimeImmutable('@' . $to))->setTimezone($utc);

		$filters = [
			'name' => 'VCALENDAR',
			'comp-filters' => [[
				'name' => 'VEVENT',
				'comp-filters' => [],
				'prop-filters' => [],
				'is-not-defined' => false,
				'time-range' => ['start' => $start, 'end' => $end],
			]],
			'prop-filters' => [],
			'is-not-defined' => false,
			'time-range' => null,
		];

		try {
			$uris = $this->backend->calendarQuery($calendarId, $filters);
			if ($uris === []) {
				return [];
			}
			$objects = $this->backend->getMultipleCalendarObjects($calendarId, $uris);
		} catch (Throwable $e) {
			$this->logger->warning('Could not read calendar ' . $calendarId, ['exception' => $e]);
			return [];
		}

		$blocks = [];
		foreach ($objects as $object) {
			array_push($blocks, ...$this->blocksFromData((string)$object['calendardata'], $calendarId, $start, $end, (int)($object['id'] ?? 0)));
		}
		usort($blocks, fn ($a, $b) => $a['start'] <=> $b['start']);
		return $blocks;
	}

	/**
	 * @return list<array{uid: string, title: string, start: int, end: int, calendarId: int}>
	 */
	public function blocksFromData(string $data, int $calendarId, DateTimeImmutable $from, DateTimeImmutable $to, int $objectId = 0): array {
		try {
			/** @var VCalendar $vcal */
			$vcal = Reader::read($data);
			// The series: its repeat (to change it from the calendar page)
			$rule = ['repeat' => '', 'until' => null];
			foreach ($vcal->select('VEVENT') as $ev) {
				if (!isset($ev->{'RECURRENCE-ID'})) {
					$rule = BlockService::describeRule($ev);
					break;
				}
			}
			$vcal = $vcal->expand($from, $to);
		} catch (Throwable $e) {
			$this->logger->debug('Skipping unreadable event', ['exception' => $e]);
			return [];
		}
		$out = [];
		foreach ($vcal->select('VEVENT') as $event) {
			/** @var VEvent $event */
			if (!isset($event->DTSTART) || !$event->DTSTART->hasTime()) {
				continue; // all-day
			}
			if (isset($event->STATUS) && strtoupper((string)$event->STATUS) === 'CANCELLED') {
				continue;
			}
			$s = $event->DTSTART->getDateTime()->getTimestamp();
			if (isset($event->DTEND)) {
				$e = $event->DTEND->getDateTime()->getTimestamp();
			} elseif (isset($event->DURATION)) {
				$e = $event->DTSTART->getDateTime()->add($event->DURATION->getDateInterval())->getTimestamp();
			} else {
				$e = $s;
			}
			if ($e <= $s || $e <= $from->getTimestamp() || $s >= $to->getTimestamp()) {
				continue;
			}
			$uid = (string)($event->UID ?? '');
			$out[] = [
				// one id per occurrence, stable across reads
				'uid' => $uid . '#' . $s,
				'title' => (string)($event->SUMMARY ?? ''),
				'start' => $s,
				'end' => $e,
				'calendarId' => $calendarId,
				// Which event and which of its occurrences (to move, change or delete it)
				'series' => $objectId,
				'occurrence' => isset($event->{'RECURRENCE-ID'}) ? $event->{'RECURRENCE-ID'}->getDateTime()->getTimestamp() : $s,
				'repeat' => $rule['repeat'],
				'until' => $rule['until'],
			];
		}
		return $out;
	}
}
