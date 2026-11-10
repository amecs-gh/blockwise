<?php

declare(strict_types=1);

namespace OCA\Tracker\Sync;

use OCP\AppFramework\Db\Entity;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\DB\Exception as DbException;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;

/**
 * Change numbers and field clocks for sync.
 *
 * Every write of a synced record (through its mapper) gets the user's next
 * change number (seq), so a device can ask "what changed since N". Every
 * changed field gets a clock value: a hybrid logical clock, written as
 * "<milliseconds, 13 digits>-<counter, 4 hex>-<node>", so plain string
 * comparison orders changes and "latest change wins" per field.
 *
 * While changes from a device are applied ("remote" mode), records keep the
 * device's clocks instead of getting the server's.
 */
class SyncClock {
	public const NODE = 'srv';
	public const CLOCK_RE = '/^\d{13}-[0-9a-f]{4}-[A-Za-z0-9_-]{1,32}$/';

	private bool $remote = false;

	public function __construct(
		private IDBConnection $db,
		private ITimeFactory $time,
	) {
	}

	public function setRemote(bool $remote): void {
		$this->remote = $remote;
	}

	public function isRemote(): bool {
		return $this->remote;
	}

	public static function uuid(): string {
		$b = random_bytes(16);
		$b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
		$b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
		return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
	}

	public static function isUuid(mixed $v): bool {
		return is_string($v) && preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $v) === 1;
	}

	/** @return array<string, string> field => clock */
	public static function decode(?string $json): array {
		if ($json === null || $json === '') {
			return [];
		}
		$d = json_decode($json, true);
		return is_array($d) ? array_filter($d, 'is_string') : [];
	}

	/**
	 * Called by the mappers before a record is saved: uuid, clocks for the
	 * changed synced fields, and a change number.
	 *
	 * @return bool whether anything synced changed (else no change number)
	 */
	public function beforeWrite(string $type, Entity $e, bool $insert): bool {
		if ((string)$e->getUuid() === '') {
			$e->setUuid(self::uuid());
		}
		$props = $insert ? array_values(SyncFields::MAP[$type]) : array_keys($e->getUpdatedFields());
		$fields = SyncFields::wireNames($type, $props);
		if ($fields === [] && !$insert) {
			return false;
		}
		$userId = (string)$e->getUserId();
		if (!$this->remote) {
			$clock = self::decode($e->getClock());
			$now = $this->next($userId);
			foreach ($fields as $f) {
				$clock[$f] = $now;
			}
			$e->setClock(json_encode($clock, JSON_UNESCAPED_SLASHES));
		}
		$e->setSeq($this->nextSeq($userId));
		return true;
	}

	/** A deleted record, so devices delete it too. */
	public function tombstone(string $userId, string $type, string $uuid): void {
		if ($uuid === '') {
			return;
		}
		$qb = $this->db->getQueryBuilder();
		$qb->insert('tracker_tombstones')->values([
			'user_id' => $qb->createNamedParameter($userId),
			'type' => $qb->createNamedParameter($type),
			'uuid' => $qb->createNamedParameter($uuid),
			'seq' => $qb->createNamedParameter($this->nextSeq($userId), IQueryBuilder::PARAM_INT),
			'hlc' => $qb->createNamedParameter($this->next($userId)),
		]);
		$qb->executeStatement();
	}

	public function isDeleted(string $userId, string $uuid): bool {
		$qb = $this->db->getQueryBuilder();
		$qb->select('id')->from('tracker_tombstones')
			->where($qb->expr()->eq('uuid', $qb->createNamedParameter($uuid)))
			->andWhere($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->setMaxResults(1);
		return $qb->executeQuery()->fetchOne() !== false;
	}

	// --- per-user state ----------------------------------------------------------------------

	private function state(string $userId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from('tracker_sync_state')->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
		$row = $qb->executeQuery()->fetch();
		if ($row !== false) {
			return $row;
		}
		try {
			$ins = $this->db->getQueryBuilder();
			$ins->insert('tracker_sync_state')->values([
				'user_id' => $ins->createNamedParameter($userId),
				'seq' => $ins->createNamedParameter(0, IQueryBuilder::PARAM_INT),
				'settings_seq' => $ins->createNamedParameter(0, IQueryBuilder::PARAM_INT),
			]);
			$ins->executeStatement();
		} catch (DbException $ex) {
			if ($ex->getReason() !== DbException::REASON_UNIQUE_CONSTRAINT_VIOLATION) {
				throw $ex;
			}
		}
		return ['user_id' => $userId, 'seq' => 0, 'hlc' => null, 'settings_clock' => null, 'settings_seq' => 0];
	}

	/**
	 * The user's next change number. Incremented in the database row itself,
	 * so concurrent requests get distinct numbers in commit order.
	 */
	public function nextSeq(string $userId): int {
		$this->state($userId);
		$qb = $this->db->getQueryBuilder();
		$qb->update('tracker_sync_state')
			->set('seq', $qb->createFunction('seq + 1'))
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
		$qb->executeStatement();
		return $this->currentSeq($userId);
	}

	public function currentSeq(string $userId): int {
		$qb = $this->db->getQueryBuilder();
		$qb->select('seq')->from('tracker_sync_state')->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
		$v = $qb->executeQuery()->fetchOne();
		return $v === false ? 0 : (int)$v;
	}

	/** Next clock value for a change made on the server. */
	public function next(string $userId): string {
		$last = $this->state($userId)['hlc'] ?? null;
		$now = (int)floor($this->time->getTime() * 1000);
		if (method_exists($this->time, 'now')) {
			$now = (int)$this->time->now()->format('Uv');
		}
		[$ms, $counter] = self::parse($last);
		if ($now > $ms) {
			$ms = $now;
			$counter = 0;
		} else {
			$counter++;
		}
		$value = self::format($ms, $counter, self::NODE);
		$this->saveHlc($userId, $value);
		return $value;
	}

	/** A clock value from a device: later server clocks must come after it. */
	public function observe(string $userId, string $clock): void {
		$last = $this->state($userId)['hlc'] ?? null;
		if ($last === null || strcmp($clock, (string)$last) > 0) {
			// Keep the device's time and counter, but as the server's node
			[$ms, $counter] = self::parse($clock);
			$this->saveHlc($userId, self::format($ms, $counter, self::NODE));
		}
	}

	private function saveHlc(string $userId, string $value): void {
		$qb = $this->db->getQueryBuilder();
		$qb->update('tracker_sync_state')
			->set('hlc', $qb->createNamedParameter($value))
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
		$qb->executeStatement();
	}

	/** @return array{0: int, 1: int} milliseconds, counter */
	public static function parse(?string $clock): array {
		if ($clock === null || !preg_match('/^(\d{13})-([0-9a-f]{4})-/', $clock, $m)) {
			return [0, 0];
		}
		return [(int)$m[1], hexdec($m[2])];
	}

	public static function format(int $ms, int $counter, string $node): string {
		return sprintf('%013d-%04x-%s', $ms, min($counter, 0xffff), $node);
	}

	/** Milliseconds of a clock value (for refusing clocks far in the future). */
	public static function millis(string $clock): int {
		return self::parse($clock)[0];
	}

	// --- settings (one record per user) ------------------------------------------------------

	/** @return array{clock: array<string, string>, seq: int} */
	public function settingsMeta(string $userId): array {
		$s = $this->state($userId);
		return ['clock' => self::decode($s['settings_clock'] ?? null), 'seq' => (int)($s['settings_seq'] ?? 0)];
	}

	/**
	 * Settings changed: stamp these keys (server clock), or with $clocks keep
	 * the device's clocks. Call after the new values are saved: a device that
	 * pulls the new clock must also get the new value.
	 *
	 * @param string[] $keys
	 * @param array<string, string>|null $clocks
	 */
	public function settingsChanged(string $userId, array $keys, ?array $clocks = null): void {
		$keys = array_values(array_intersect($keys, SyncFields::SETTINGS));
		if ($keys === []) {
			return;
		}
		// One transaction holding the user's sync row: change number and clocks together,
		// so a device pulling meanwhile sees either all of it or none
		$this->db->beginTransaction();
		try {
			$seq = $this->nextSeq($userId);
			$meta = $this->settingsMeta($userId);
			$clock = $meta['clock'];
			$now = $clocks === null ? $this->next($userId) : null;
			foreach ($keys as $k) {
				$clock[$k] = $clocks[$k] ?? $now ?? $this->next($userId);
			}
			$qb = $this->db->getQueryBuilder();
			$qb->update('tracker_sync_state')
				->set('settings_clock', $qb->createNamedParameter(json_encode($clock, JSON_UNESCAPED_SLASHES)))
				->set('settings_seq', $qb->createNamedParameter($seq, IQueryBuilder::PARAM_INT))
				->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
			$qb->executeStatement();
			$this->db->commit();
		} catch (\Throwable $e) {
			$this->db->rollBack();
			throw $e;
		}
	}
}
