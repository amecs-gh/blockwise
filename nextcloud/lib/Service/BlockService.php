<?php

declare(strict_types=1);

namespace OCA\Tracker\Service;

use DateTimeImmutable;
use DateTimeInterface;
use DateTimeZone;
use OCA\DAV\CalDAV\CalDavBackend;
use OCA\Tracker\Db\Commitment;
use OCA\Tracker\Db\CommitmentMapper;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\IConfig;
use Sabre\VObject\Component\VCalendar;
use Sabre\VObject\Component\VEvent;
use Sabre\VObject\Reader;
use Sabre\VObject\UUIDUtil;
use Throwable;

/**
 * Plan, move, change and delete blocks: events in a commitment's calendar, so
 * they show the same everywhere (Nextcloud Calendar, phones through CalDAV).
 * Repeats are ordinary iCalendar rules (RRULE, EXDATE, RECURRENCE-ID), like
 * Apple Calendar: "this block only", "this and all future ones", or "all".
 *
 * Only events in calendars linked to the user's own commitments can be
 * touched; a block is found by the event's id in such a calendar.
 */
class BlockService {
	public const REPEATS = ['', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly'];
	private const RULES = [
		'daily' => 'FREQ=DAILY',
		'weekdays' => 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
		'weekly' => 'FREQ=WEEKLY',
		'biweekly' => 'FREQ=WEEKLY;INTERVAL=2',
		'monthly' => 'FREQ=MONTHLY',
	];

	public function __construct(
		private CalDavBackend $backend,
		private CalendarService $calendars,
		private CommitmentMapper $commitmentMapper,
		private IConfig $config,
	) {
	}

	// --- reading: what the calendar page needs to change a block ---

	/** "weekly", … from an RRULE, "custom" for anything else, "" without one; and its end */
	public static function describeRule(VEvent $master): array {
		if (!isset($master->RRULE)) {
			return ['repeat' => '', 'until' => null];
		}
		$parts = $master->RRULE->getParts();
		$until = null;
		if (isset($parts['UNTIL'])) {
			try {
				$until = (new DateTimeImmutable(is_array($parts['UNTIL']) ? $parts['UNTIL'][0] : $parts['UNTIL'], new DateTimeZone('UTC')))->getTimestamp();
			} catch (Throwable) {
				$until = null;
			}
		}
		unset($parts['UNTIL'], $parts['WKST']);
		$norm = static function (array $p): string {
			ksort($p);
			return implode(';', array_map(fn ($k, $v) => $k . '=' . (is_array($v) ? implode(',', $v) : $v), array_keys($p), $p));
		};
		$have = $norm($parts);
		foreach (self::RULES as $kind => $rule) {
			$want = [];
			foreach (explode(';', $rule) as $pair) {
				[$k, $v] = explode('=', $pair);
				$want[$k] = str_contains($v, ',') ? explode(',', $v) : $v;
			}
			if ($norm($want) === $have) {
				return ['repeat' => $kind, 'until' => $until];
			}
		}
		return ['repeat' => 'custom', 'until' => $until];
	}

	// --- changing ---

	/** @return array{uid: string, series: int, occurrence: int} */
	public function create(string $userId, int $calendarId, string $title, int $start, int $end, string $repeat, ?int $until, ?string $tz): array {
		$this->checkTimes($start, $end);
		$zone = $this->zone($userId, $tz);
		$vcal = new VCalendar(['PRODID' => '-//Blockwise//Blockwise//EN']);
		$uid = UUIDUtil::getUUID();
		$ev = $vcal->add('VEVENT', ['UID' => $uid, 'DTSTAMP' => new DateTimeImmutable('now', new DateTimeZone('UTC')), 'SUMMARY' => $title]);
		$ev->add('DTSTART', $this->local($start, $zone));
		$ev->add('DTEND', $this->local($end, $zone));
		if ($repeat !== '') {
			$ev->add('RRULE', $this->rule($repeat, $until, $start));
		}
		$uri = $uid . '.ics';
		self::addTimezones($vcal);
		$this->backend->createCalendarObject($calendarId, $uri, $vcal->serialize());
		return ['uid' => $uid . '#' . $start, 'series' => $this->objectId($calendarId, $uri), 'occurrence' => $start];
	}

	/**
	 * @param array{title?: string, start?: int, end?: int, repeat?: string, until?: ?int} $ch
	 * @param int|null $toCalendar another commitment's calendar
	 */
	public function update(string $userId, int $objectId, int $occurrence, array $ch, string $scope, ?int $toCalendar, ?string $tz): array {
		[$calendarId, $uri, $vcal, $master] = $this->load($userId, $objectId);
		$zone = $this->zone($userId, $tz, $master);
		$this->checkOccurrence($vcal, $master, $occurrence);
		$dur = $this->end($master) - $master->DTSTART->getDateTime()->getTimestamp();
		$start = $ch['start'] ?? $occurrence;
		$end = $ch['end'] ?? ($start + $this->occurrenceLength($vcal, $occurrence, $dur));
		$this->checkTimes($start, $end);
		$title = $ch['title'] ?? null;
		$recurring = isset($master->RRULE);
		$target = $toCalendar !== null && $toCalendar !== $calendarId ? $toCalendar : null;
		if (!$recurring) {
			$scope = 'all';
		}
		$first = $master->DTSTART->getDateTime()->getTimestamp();
		if ($scope === 'future' && $occurrence <= $first) {
			$scope = 'all';
		}

		if ($scope === 'this') {
			$this->dropOverride($vcal, $occurrence);
			if ($target !== null) {
				// To another commitment: out of this series, a block of its own there
				$master->add('EXDATE', $this->local($occurrence, $this->masterZone($master)));
				$this->save($calendarId, $uri, $vcal);
				$base = $this->summary($master);
				return $this->create($userId, $target, $title ?? $base, $start, $end, '', null, $tz);
			}
			$over = clone $master;
			foreach (['RRULE', 'EXDATE', 'RDATE', 'EXRULE', 'DTSTART', 'DTEND', 'DURATION'] as $p) {
				unset($over->{$p});
			}
			$over->add('RECURRENCE-ID', $this->local($occurrence, $this->masterZone($master)));
			$over->add('DTSTART', $this->local($start, $zone));
			$over->add('DTEND', $this->local($end, $zone));
			if ($title !== null) {
				$over->SUMMARY = $title;
			}
			$vcal->add($over);
			$this->save($calendarId, $uri, $vcal);
			return ['ok' => true, 'series' => $objectId, 'occurrence' => $occurrence];
		}

		if ($scope === 'future') {
			// This series ends before this block; a new one starts here
			$rule = $this->ruleForNew($master, $ch, $start);
			$this->endBefore($vcal, $master, $occurrence);
			$this->save($calendarId, $uri, $vcal);
			$new = $this->create($userId, $target ?? $calendarId, $title ?? $this->summary($master), $start, $end, '', null, $tz);
			if ($rule !== null) {
				[$nCal, $nUri, $nVcal, $nMaster] = $this->load($userId, $new['series']);
				$nMaster->add('RRULE', $rule);
				$this->save($nCal, $nUri, $nVcal);
			}
			return ['ok' => true, 'series' => $new['series'], 'occurrence' => $start];
		}

		// All of them: the series moves by the same amount, the rule as chosen
		$delta = $start - $occurrence;
		$mzone = $this->masterZone($master);
		$newFirst = $first + $delta;
		$master->DTSTART = $this->local($newFirst, $recurring ? $mzone : $zone);
		unset($master->DURATION);
		$master->DTEND = $this->local($newFirst + ($end - $start), $recurring ? $mzone : $zone);
		if ($title !== null) {
			$master->SUMMARY = $title;
		}
		if (array_key_exists('repeat', $ch) && $ch['repeat'] !== 'custom' && $ch['repeat'] !== self::describeRule($master)['repeat'] || array_key_exists('until', $ch)) {
			$repeat = $ch['repeat'] ?? self::describeRule($master)['repeat'];
			if ($repeat === 'custom') {
				// A rule made elsewhere: only its end changes
				$parts = $master->RRULE->getParts();
				unset($parts['UNTIL'], $parts['COUNT']);
				if (($ch['until'] ?? null) !== null) {
					$parts['UNTIL'] = gmdate('Ymd\THis\Z', (int)$ch['until']);
				}
				$master->RRULE = $parts;
			} else {
				unset($master->RRULE);
				if ($repeat !== '') {
					$master->add('RRULE', $this->rule($repeat, $ch['until'] ?? null, $newFirst));
				} else {
					foreach (['EXDATE', 'RDATE'] as $p) {
						unset($master->{$p});
					}
					foreach ($this->overrides($vcal) as $o) {
						$vcal->remove($o);
					}
				}
			}
		} elseif ($delta !== 0 && isset($master->RRULE)) {
			// The end of the repeat moves along (its last block stays)
			$parts = $master->RRULE->getParts();
			if (isset($parts['UNTIL'])) {
				$u = self::describeRule($master)['until'];
				if ($u !== null) {
					$parts['UNTIL'] = gmdate('Ymd\THis\Z', $u + $delta);
					$master->RRULE = $parts;
				}
			}
		}
		if ($delta !== 0) {
			// Skipped and changed occurrences keep their place in the series
			$ex = [];
			foreach ($master->select('EXDATE') as $e) {
				foreach ($e->getDateTimes() as $d) {
					$ex[] = $d->getTimestamp() + $delta;
				}
			}
			unset($master->EXDATE);
			foreach ($ex as $t) {
				$master->add('EXDATE', $this->local($t, $mzone));
			}
			foreach ($this->overrides($vcal) as $o) {
				$rid = $o->{'RECURRENCE-ID'}->getDateTime()->getTimestamp();
				$o->{'RECURRENCE-ID'} = $this->local($rid + $delta, $mzone);
			}
		}
		$this->stamp($master);
		if ($target !== null) {
			$this->backend->deleteCalendarObject($calendarId, $uri);
			$this->backend->createCalendarObject($target, $uri, $vcal->serialize());
			return ['ok' => true, 'series' => $this->objectId($target, $uri), 'occurrence' => $start];
		}
		$this->save($calendarId, $uri, $vcal);
		return ['ok' => true, 'series' => $objectId, 'occurrence' => $start];
	}

	public function delete(string $userId, int $objectId, int $occurrence, string $scope): void {
		[$calendarId, $uri, $vcal, $master] = $this->load($userId, $objectId);
		$recurring = isset($master->RRULE);
		$first = $master->DTSTART->getDateTime()->getTimestamp();
		if (!$recurring || $scope === 'all' || ($scope === 'future' && $occurrence <= $first)) {
			$this->backend->deleteCalendarObject($calendarId, $uri);
			return;
		}
		$this->checkOccurrence($vcal, $master, $occurrence);
		if ($scope === 'future') {
			$this->endBefore($vcal, $master, $occurrence);
		} else {
			$this->dropOverride($vcal, $occurrence);
			$master->add('EXDATE', $this->local($occurrence, $this->masterZone($master)));
		}
		$this->stamp($master);
		$this->save($calendarId, $uri, $vcal);
	}

	/** The calendar of one of the user's commitments (by commitment id or calendar id) */
	public function commitmentCalendar(string $userId, ?int $commitmentId, ?int $calendarId): int {
		$own = array_filter($this->commitmentMapper->findAllForUser($userId), fn (Commitment $c) => $c->getCalendarId() !== null);
		foreach ($own as $c) {
			if (($commitmentId !== null && $c->getId() === $commitmentId) || ($commitmentId === null && $calendarId !== null && $c->getCalendarId() === $calendarId)) {
				if ($this->calendars->getCalendar($userId, (int)$c->getCalendarId()) === null) {
					break;
				}
				return (int)$c->getCalendarId();
			}
		}
		throw new ServiceException('This commitment has no calendar yet. Try again in a moment.');
	}

	// --- helpers ---

	/** The event, only in a calendar of one of the user's commitments: [calendarId, uri, VCalendar, master VEVENT] */
	private function load(string $userId, int $objectId): array {
		foreach ($this->commitmentMapper->findAllForUser($userId) as $c) {
			$calId = $c->getCalendarId();
			if ($calId === null || $this->calendars->getCalendar($userId, (int)$calId) === null) {
				continue;
			}
			foreach ($this->backend->getCalendarObjects((int)$calId) as $o) {
				if ((int)$o['id'] !== $objectId) {
					continue;
				}
				$obj = $this->backend->getCalendarObject((int)$calId, $o['uri']);
				if ($obj === null) {
					break;
				}
				try {
					/** @var VCalendar $vcal */
					$vcal = Reader::read((string)$obj['calendardata']);
				} catch (Throwable) {
					throw new ServiceException('This event could not be read.');
				}
				foreach ($vcal->select('VEVENT') as $ev) {
					if (!isset($ev->{'RECURRENCE-ID'})) {
						if (!isset($ev->DTSTART) || !$ev->DTSTART->hasTime()) {
							throw new ServiceException('All-day events are not blocks.');
						}
						return [(int)$calId, (string)$o['uri'], $vcal, $ev];
					}
				}
				throw new ServiceException('This event could not be read.');
			}
		}
		throw new DoesNotExistException('Block not found');
	}

	private function objectId(int $calendarId, string $uri): int {
		$o = $this->backend->getCalendarObject($calendarId, $uri);
		return $o === null ? 0 : (int)$o['id'];
	}

	private function save(int $calendarId, string $uri, VCalendar $vcal): void {
		self::addTimezones($vcal);
		$this->backend->updateCalendarObject($calendarId, $uri, $vcal->serialize());
	}

	/**
	 * A VTIMEZONE for each time zone the events name (RFC 5545 asks for it; some
	 * calendar apps need it): the zone's changes from last year to 10 years ahead.
	 */
	public static function addTimezones(VCalendar $vcal): void {
		$have = [];
		foreach ($vcal->select('VTIMEZONE') as $tz) {
			$have[(string)$tz->TZID] = true;
		}
		$want = [];
		foreach ($vcal->select('VEVENT') as $ev) {
			foreach (['DTSTART', 'DTEND', 'RECURRENCE-ID', 'EXDATE'] as $p) {
				foreach ($ev->select($p) as $prop) {
					if (isset($prop['TZID'])) {
						$want[(string)$prop['TZID']] = true;
					}
				}
			}
		}
		$year = (int)gmdate('Y');
		foreach (array_keys($want) as $name) {
			if (isset($have[$name]) || !in_array($name, DateTimeZone::listIdentifiers(), true)) {
				continue;
			}
			$zone = new DateTimeZone($name);
			$from = gmmktime(0, 0, 0, 1, 1, $year - 1);
			$to = gmmktime(0, 0, 0, 1, 1, $year + 11);
			$trans = $zone->getTransitions($from, $to);
			if (!$trans) {
				continue;
			}
			$vtz = $vcal->add($vcal->createComponent('VTIMEZONE', ['TZID' => $name], false));
			$prev = (int)$trans[0]['offset'];
			$fmt = static fn (int $o): string => ($o < 0 ? '-' : '+') . sprintf('%02d%02d', intdiv(abs($o), 3600), intdiv(abs($o) % 3600, 60));
			if (count($trans) === 1) {
				// No changes (no DST): one STANDARD part
				$vtz->add($vcal->createComponent('STANDARD', ['DTSTART' => '19700101T000000', 'TZOFFSETFROM' => $fmt($prev), 'TZOFFSETTO' => $fmt($prev), 'TZNAME' => (string)$trans[0]['abbr']], false));
				continue;
			}
			foreach (array_slice($trans, 1) as $t) {
				$off = (int)$t['offset'];
				// The local time when it changes, on the clock before the change
				$local = gmdate('Ymd\THis', (int)$t['ts'] + $prev);
				$vtz->add($vcal->createComponent($t['isdst'] ? 'DAYLIGHT' : 'STANDARD', ['DTSTART' => $local, 'TZOFFSETFROM' => $fmt($prev), 'TZOFFSETTO' => $fmt($off), 'TZNAME' => (string)$t['abbr']], false));
				$prev = $off;
			}
		}
	}

	private function checkTimes(int $start, int $end): void {
		if ($start <= 0 || $end <= $start || $end - $start > 86400) {
			throw new ServiceException('Invalid time');
		}
	}

	/** The occurrence must be one of the series (or the event itself) */
	private function checkOccurrence(VCalendar $vcal, VEvent $master, int $occurrence): void {
		if (!isset($master->RRULE)) {
			if ($master->DTSTART->getDateTime()->getTimestamp() !== $occurrence) {
				throw new DoesNotExistException('Block not found');
			}
			return;
		}
		$utc = new DateTimeZone('UTC');
		$exp = (clone $vcal)->expand(new DateTimeImmutable('@' . ($occurrence - 1), $utc), new DateTimeImmutable('@' . ($occurrence + 86401), $utc));
		foreach ($exp->select('VEVENT') as $e) {
			$rid = isset($e->{'RECURRENCE-ID'}) ? $e->{'RECURRENCE-ID'}->getDateTime()->getTimestamp() : $e->DTSTART->getDateTime()->getTimestamp();
			if ($rid === $occurrence) {
				return;
			}
		}
		throw new DoesNotExistException('Block not found');
	}

	private function occurrenceLength(VCalendar $vcal, int $occurrence, int $default): int {
		foreach ($this->overrides($vcal) as $o) {
			if ($o->{'RECURRENCE-ID'}->getDateTime()->getTimestamp() === $occurrence && isset($o->DTSTART)) {
				return $this->end($o) - $o->DTSTART->getDateTime()->getTimestamp();
			}
		}
		return $default;
	}

	private function end(VEvent $e): int {
		$s = $e->DTSTART->getDateTime();
		if (isset($e->DTEND)) {
			return $e->DTEND->getDateTime()->getTimestamp();
		}
		if (isset($e->DURATION)) {
			return $s->add($e->DURATION->getDateInterval())->getTimestamp();
		}
		return $s->getTimestamp() + 3600;
	}

	/** @return list<VEvent> changed occurrences */
	private function overrides(VCalendar $vcal): array {
		$out = [];
		foreach ($vcal->select('VEVENT') as $ev) {
			if (isset($ev->{'RECURRENCE-ID'})) {
				$out[] = $ev;
			}
		}
		return $out;
	}

	private function dropOverride(VCalendar $vcal, int $occurrence): void {
		foreach ($this->overrides($vcal) as $o) {
			if ($o->{'RECURRENCE-ID'}->getDateTime()->getTimestamp() === $occurrence) {
				$vcal->remove($o);
			}
		}
	}

	/** The series stops before `occurrence` (skips and changes after it go too) */
	private function endBefore(VCalendar $vcal, VEvent $master, int $occurrence): void {
		$parts = $master->RRULE->getParts();
		unset($parts['COUNT']);
		$parts['UNTIL'] = gmdate('Ymd\THis\Z', $occurrence - 1);
		$master->RRULE = $parts;
		foreach ($this->overrides($vcal) as $o) {
			if ($o->{'RECURRENCE-ID'}->getDateTime()->getTimestamp() >= $occurrence) {
				$vcal->remove($o);
			}
		}
		$this->stamp($master);
	}

	/** The rule for the new series of "this and all future": as chosen, else the old one (without COUNT) */
	private function ruleForNew(VEvent $master, array $ch, int $start): ?string {
		$repeat = $ch['repeat'] ?? 'keep';
		if ($repeat === '') {
			return null;
		}
		if ($repeat !== 'keep' && $repeat !== 'custom') {
			return $this->rule($repeat, $ch['until'] ?? self::describeRule($master)['until'], $start);
		}
		$parts = $master->RRULE->getParts();
		unset($parts['COUNT']);
		if (array_key_exists('until', $ch)) {
			unset($parts['UNTIL']);
			if ($ch['until'] !== null) {
				$parts['UNTIL'] = gmdate('Ymd\THis\Z', (int)$ch['until']);
			}
		}
		return implode(';', array_map(fn ($k, $v) => $k . '=' . (is_array($v) ? implode(',', $v) : $v), array_keys($parts), $parts));
	}

	private function rule(string $repeat, ?int $until, int $start): string {
		if (!isset(self::RULES[$repeat])) {
			throw new ServiceException('Invalid repeat');
		}
		$r = self::RULES[$repeat];
		if ($until !== null && $until >= $start) {
			$r .= ';UNTIL=' . gmdate('Ymd\THis\Z', $until);
		}
		return $r;
	}

	private function summary(VEvent $e): string {
		return (string)($e->SUMMARY ?? '');
	}

	private function stamp(VEvent $e): void {
		$e->DTSTAMP = new DateTimeImmutable('now', new DateTimeZone('UTC'));
		$seq = isset($e->SEQUENCE) ? (int)(string)$e->SEQUENCE : 0;
		$e->SEQUENCE = $seq + 1;
	}

	/** Repeats follow local time (across DST): the device's zone, else the user's Nextcloud setting, else UTC */
	private function zone(string $userId, ?string $tz, ?VEvent $master = null): DateTimeZone {
		foreach ([$tz, $this->config->getUserValue($userId, 'core', 'timezone', '')] as $name) {
			if (is_string($name) && $name !== '' && strlen($name) <= 64 && in_array($name, DateTimeZone::listIdentifiers(), true)) {
				return new DateTimeZone($name);
			}
		}
		return $master !== null ? $this->masterZone($master) : new DateTimeZone('UTC');
	}

	private function masterZone(VEvent $master): DateTimeZone {
		$z = $master->DTSTART->getDateTime()->getTimezone();
		return $z ?: new DateTimeZone('UTC');
	}

	private function local(int $ts, DateTimeZone $zone): DateTimeInterface {
		return (new DateTimeImmutable('@' . $ts))->setTimezone($zone);
	}
}
