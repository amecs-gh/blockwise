<?php

declare(strict_types=1);

namespace OCA\Tracker\Service;

use DateTimeImmutable;
use DateTimeZone;
use OCA\Tracker\Db\Commitment;
use OCA\Tracker\Db\CommitmentMapper;
use OCA\Tracker\Sync\SyncClock;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IConfig;
use Sabre\DAV\UUIDUtil;

/**
 * Blocks in backups. Blocks are events in the commitments' calendars, so a
 * backup takes them from there (a year back to a year ahead): a repeating event
 * once, its occurrences moved or deleted in the calendar left out of the repeat
 * (a moved one as a block of its own), the rest one by one. Importing puts them
 * back as events, in each commitment's calendar (made if the commitment has
 * none here); what is there already (same title and time) is not added again.
 * The same format as the apps' (js/engine.js): records of type "block".
 */
class BackupService {
	private const REPEATS = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly'];

	public function __construct(
		private CommitmentMapper $mapper,
		private CommitmentService $commitments,
		private CalendarService $calendars,
		private BlockService $blocks,
		private SyncClock $clock,
		private ITimeFactory $time,
		private IConfig $config,
	) {
	}

	private function zone(string $userId): DateTimeZone {
		$tz = $this->config->getUserValue($userId, 'core', 'timezone', '') ?: date_default_timezone_get();
		try {
			return new DateTimeZone($tz);
		} catch (\Throwable $e) {
			return new DateTimeZone('UTC');
		}
	}

	/** Start times of a repeat from $start until $to (local time, like the apps) */
	private function occurrences(int $start, string $repeat, ?int $until, int $to, DateTimeZone $zone): array {
		$base = (new DateTimeImmutable('@' . $start))->setTimezone($zone);
		$out = [];
		$step = $repeat === 'weekly' ? 7 : ($repeat === 'biweekly' ? 14 : 1);
		for ($k = 0; $k < 3000 && count($out) < 1000; $k++) {
			if ($repeat === 'monthly') {
				$d = $base->modify('+' . $k . ' month');
				if ((int)$d->format('j') !== (int)$base->format('j')) {
					continue;
				}
			} else {
				$d = $base->modify('+' . ($k * $step) . ' day');
			}
			$t = $d->getTimestamp();
			if ($t >= $to || ($until !== null && $t > $until)) {
				break;
			}
			if ($repeat === 'weekdays' && (int)$d->format('N') >= 6) {
				continue;
			}
			$out[] = $t;
		}
		return $out;
	}

	/** @return array<string, bool> the commitments (by uuid) that have a calendar here */
	public function withCalendar(string $userId): array {
		$out = [];
		foreach ($this->mapper->findAllForUser($userId) as $c) {
			if ($c->getUuid() !== null && $c->getCalendarId() !== null && $this->calendars->getCalendar($userId, $c->getCalendarId()) !== null) {
				$out[$c->getUuid()] = true;
			}
		}
		return $out;
	}

	/** @return list<array{type: string, id: string, fields: array, clock: array}> */
	public function blockRecords(string $userId): array {
		$now = $this->time->getTime();
		$from = $now - 365 * 86400;
		$to = $now + 365 * 86400;
		$uuids = [];
		foreach ($this->mapper->findAllForUser($userId) as $c) {
			if ($c->getUuid() !== null) {
				$uuids[$c->getId()] = $c->getUuid();
			}
		}
		$zone = $this->zone($userId);
		$groups = [];
		foreach ($this->commitments->blocks($userId, $from, $to) as $b) {
			$cu = $uuids[$b['commitmentId']] ?? null;
			if ($cu === null || $b['end'] <= $b['start'] || $b['end'] - $b['start'] > 86400) {
				continue;
			}
			$b['commitment'] = $cu;
			$repeating = !empty($b['series']) && in_array($b['repeat'] ?? '', self::REPEATS, true);
			$key = $repeating ? $b['calendarId'] . '|' . $b['series'] : 'one|' . $b['uid'];
			$groups[$key][] = $b;
		}
		$out = [];
		$rec = function (array $f) use ($userId, &$out) {
			$fields = [
				'commitment' => $f['commitment'],
				'title' => mb_substr((string)$f['title'], 0, 255),
				'start' => (int)$f['start'],
				'end' => (int)$f['end'],
				'repeat' => $f['repeat'] ?? '',
				'until' => $f['until'] ?? null,
				'skip' => $f['skip'] ?? [],
				'created' => $this->time->getTime(),
			];
			$clock = [];
			foreach (array_keys($fields) as $k) {
				$clock[$k] = $this->clock->next($userId);
			}
			$out[] = ['type' => 'block', 'id' => UUIDUtil::getUUID(), 'fields' => $fields, 'clock' => $clock];
		};
		foreach ($groups as $list) {
			$one = $list[0];
			if (count($list) === 1 && !in_array($one['repeat'] ?? '', self::REPEATS, true)) {
				$rec(['repeat' => '', 'until' => null] + $one);
				continue;
			}
			usort($list, fn ($a, $b) => $a['occurrence'] <=> $b['occurrence']);
			$base = $list[0];
			foreach ($list as $e) {
				if ($e['start'] === $e['occurrence']) {
					$base = $e;
					break;
				}
			}
			$occ0 = (int)$base['occurrence'];
			$len = $base['end'] - $base['start'];
			$until = $base['until'] !== null ? (int)$base['until'] : null;
			$seriesZone = $zone;
			if (!empty($base['tz'])) {
				try {
					$seriesZone = new DateTimeZone($base['tz']);
				} catch (\Throwable $e) {
					// the user's
				}
			}
			$expected = $this->occurrences($occ0, $base['repeat'], $until, $to, $seriesZone);
			$have = [];
			foreach ($list as $e) {
				$have[(int)$e['occurrence']] = $e;
			}
			$same = fn (array $e, int $t) => $e['start'] === $t && $e['end'] - $e['start'] === $len && $e['title'] === $base['title'];
			$skip = [];
			foreach ($expected as $t) {
				if (!isset($have[$t]) || !$same($have[$t], $t)) {
					$skip[] = $t;
				}
			}
			$rec(['commitment' => $base['commitment'], 'title' => $base['title'], 'start' => $occ0, 'end' => $occ0 + $len, 'repeat' => $base['repeat'], 'until' => $until, 'skip' => array_slice($skip, 0, 1000)]);
			$exp = array_flip($expected);
			foreach ($list as $e) {
				$t = (int)$e['occurrence'];
				if (!isset($exp[$t]) || !$same($e, $t)) {
					$rec(['repeat' => '', 'until' => null] + $e);
				}
			}
		}
		return $out;
	}

	/**
	 * Block records from a backup into the calendars.
	 * @param list<array> $records the backup's block records
	 * @param list<string> $commitmentUuids the backup's commitments (each gets a calendar if it has none)
	 * @return array{blocks: int, calendars: int}
	 */
	public function importBlocks(string $userId, array $records, array $commitmentUuids): array {
		$result = ['blocks' => 0, 'calendars' => 0];
		$byUuid = [];
		foreach ($this->mapper->findAllForUser($userId) as $c) {
			if ($c->getUuid() !== null) {
				$byUuid[$c->getUuid()] = $c;
			}
		}
		foreach ($records as $r) {
			if (is_array($r['fields'] ?? null) && is_string($r['fields']['commitment'] ?? null)) {
				$commitmentUuids[] = $r['fields']['commitment'];
			}
		}
		$calOf = [];
		foreach (array_unique($commitmentUuids) as $u) {
			$c = $byUuid[$u] ?? null;
			if (!$c instanceof Commitment) {
				continue;
			}
			if ($c->getCalendarId() === null || $this->calendars->getCalendar($userId, $c->getCalendarId()) === null) {
				$c = $this->commitments->update($userId, $c->getId(), null, null, null, true);
			}
			$calOf[$u] = $c->getCalendarId();
		}
		$wanted = [];
		foreach ($records as $r) {
			$f = is_array($r['fields'] ?? null) ? $r['fields'] : [];
			$cal = $calOf[$f['commitment'] ?? ''] ?? null;
			$start = (int)($f['start'] ?? 0);
			$end = (int)($f['end'] ?? 0);
			if ($cal === null || $end <= $start || $end - $start > 86400) {
				continue;
			}
			$repeat = in_array($f['repeat'] ?? '', self::REPEATS, true) ? $f['repeat'] : '';
			$until = $repeat !== '' && is_numeric($f['until'] ?? null) ? (int)$f['until'] : null;
			$skip = $repeat !== '' && is_array($f['skip'] ?? null) ? array_slice(array_values(array_filter($f['skip'], 'is_int')), 0, 1000) : [];
			$wanted[] = ['cal' => $cal, 'title' => mb_substr((string)($f['title'] ?? ''), 0, 255), 'start' => $start, 'end' => $end, 'repeat' => $repeat, 'until' => $until, 'skip' => $skip];
		}
		if ($wanted === []) {
			return $result;
		}
		// Already there (the same backup imported twice): not again
		$lo = min(array_column($wanted, 'start'));
		$hi = max(array_column($wanted, 'end')) + 86400;
		$there = [];
		foreach (array_unique(array_column($wanted, 'cal')) as $cal) {
			foreach ($this->calendars->getBlocks($cal, $lo, $hi) as $b) {
				$there[$cal . '|' . $b['start'] . '|' . $b['end'] . '|' . $b['title']] = true;
			}
		}
		$tz = $this->zone($userId)->getName();
		foreach ($wanted as $w) {
			if (isset($there[$w['cal'] . '|' . $w['start'] . '|' . $w['end'] . '|' . $w['title']])) {
				continue;
			}
			try {
				$made = $this->blocks->create($userId, $w['cal'], $w['title'], $w['start'], $w['end'], $w['repeat'], $w['until'], $tz);
				foreach ($w['skip'] as $t) {
					try {
						$this->blocks->delete($userId, $made['series'], $t, 'this');
					} catch (\Throwable $e) {
						// not an occurrence of it
					}
				}
				$result['blocks']++;
			} catch (\Throwable $e) {
				// that one not
			}
		}
		return $result;
	}
}
