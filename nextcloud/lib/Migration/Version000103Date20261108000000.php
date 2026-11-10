<?php

declare(strict_types=1);

namespace OCA\Tracker\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\DB\Types;
use OCP\IDBConnection;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Sync between devices (local-first apps):
 * - every record gets a uuid (devices create records offline), a per-field
 *   clock (latest change wins, per field) and a change number (seq);
 * - deletions are kept as tombstones so they sync too;
 * - "carried over" becomes a set of block marks (merges without double counting);
 * - commitments remember their calendar's address (to find it on other devices).
 */
class Version000103Date20261108000000 extends SimpleMigrationStep {
	private const TABLES = ['tracker_commitments', 'tracker_tasks', 'tracker_subtasks', 'tracker_sessions'];

	public function __construct(
		private IDBConnection $db,
	) {
	}

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		foreach (self::TABLES as $name) {
			$t = $schema->getTable($name);
			if (!$t->hasColumn('uuid')) {
				$t->addColumn('uuid', Types::STRING, ['notnull' => false, 'length' => 36]);
			}
			if (!$t->hasColumn('clock')) {
				$t->addColumn('clock', Types::TEXT, ['notnull' => false]);
			}
			if (!$t->hasColumn('seq')) {
				$t->addColumn('seq', Types::BIGINT, ['notnull' => true, 'default' => 0, 'unsigned' => true]);
			}
			$short = substr($name, 8, 4);
			if (!$t->hasIndex('tracker_' . $short . '_uuid')) {
				$t->addIndex(['uuid'], 'tracker_' . $short . '_uuid');
			}
			if (!$t->hasIndex('tracker_' . $short . '_seq')) {
				$t->addIndex(['user_id', 'seq'], 'tracker_' . $short . '_seq');
			}
		}

		$tasks = $schema->getTable('tracker_tasks');
		if (!$tasks->hasColumn('carried_keys')) {
			$tasks->addColumn('carried_keys', Types::TEXT, ['notnull' => false]);
		}
		$commitments = $schema->getTable('tracker_commitments');
		if (!$commitments->hasColumn('calendar_url')) {
			$commitments->addColumn('calendar_url', Types::STRING, ['notnull' => false, 'length' => 1024]);
		}

		if (!$schema->hasTable('tracker_sync_state')) {
			$t = $schema->createTable('tracker_sync_state');
			$t->addColumn('user_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			// last change number given out
			$t->addColumn('seq', Types::BIGINT, ['notnull' => true, 'default' => 0, 'unsigned' => true]);
			// last clock value seen or given out (hybrid logical clock)
			$t->addColumn('hlc', Types::STRING, ['notnull' => false, 'length' => 64]);
			// settings: their field clocks and change number
			$t->addColumn('settings_clock', Types::TEXT, ['notnull' => false]);
			$t->addColumn('settings_seq', Types::BIGINT, ['notnull' => true, 'default' => 0, 'unsigned' => true]);
			$t->setPrimaryKey(['user_id']);
		}

		if (!$schema->hasTable('tracker_tombstones')) {
			$t = $schema->createTable('tracker_tombstones');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'unsigned' => true]);
			$t->addColumn('user_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			$t->addColumn('type', Types::STRING, ['notnull' => true, 'length' => 16]);
			$t->addColumn('uuid', Types::STRING, ['notnull' => true, 'length' => 36]);
			$t->addColumn('seq', Types::BIGINT, ['notnull' => true, 'unsigned' => true]);
			$t->addColumn('hlc', Types::STRING, ['notnull' => true, 'length' => 64]);
			$t->setPrimaryKey(['id']);
			$t->addIndex(['user_id', 'seq'], 'tracker_tomb_seq');
			$t->addIndex(['uuid'], 'tracker_tomb_uuid');
		}
		return $schema;
	}

	public function postSchemaChange(IOutput $output, Closure $schemaClosure, array $options): void {
		// Existing records: a uuid each, and a change number so devices pull them
		$seqByUser = [];
		foreach (self::TABLES as $table) {
			$qb = $this->db->getQueryBuilder();
			$qb->select('id', 'user_id')->from($table)->where($qb->expr()->isNull('uuid'))->orderBy('id');
			$res = $qb->executeQuery();
			while ($row = $res->fetch()) {
				$user = (string)$row['user_id'];
				$seqByUser[$user] = ($seqByUser[$user] ?? $this->currentSeq($user)) + 1;
				$up = $this->db->getQueryBuilder();
				$up->update($table)
					->set('uuid', $up->createNamedParameter($this->uuid()))
					->set('clock', $up->createNamedParameter('{}'))
					->set('seq', $up->createNamedParameter($seqByUser[$user], IQueryBuilder::PARAM_INT))
					->where($up->expr()->eq('id', $up->createNamedParameter((int)$row['id'], IQueryBuilder::PARAM_INT)));
				$up->executeStatement();
			}
			$res->closeCursor();
		}

		// "Carried over" counts become that many (anonymous) block marks
		$qb = $this->db->getQueryBuilder();
		$qb->select('id', 'carried')->from('tracker_tasks')
			->where($qb->expr()->isNull('carried_keys'))
			->andWhere($qb->expr()->gt('carried', $qb->createNamedParameter(0, IQueryBuilder::PARAM_INT)));
		$res = $qb->executeQuery();
		while ($row = $res->fetch()) {
			$keys = [];
			for ($i = 1; $i <= (int)$row['carried']; $i++) {
				$keys[] = 'legacy-' . $i;
			}
			$up = $this->db->getQueryBuilder();
			$up->update('tracker_tasks')
				->set('carried_keys', $up->createNamedParameter(json_encode($keys)))
				->where($up->expr()->eq('id', $up->createNamedParameter((int)$row['id'], IQueryBuilder::PARAM_INT)));
			$up->executeStatement();
		}
		$res->closeCursor();

		foreach ($seqByUser as $user => $seq) {
			$this->saveSeq((string)$user, $seq);
		}
		if ($seqByUser !== []) {
			$output->info('Prepared ' . count($seqByUser) . ' user(s) for sync');
		}
	}

	private function currentSeq(string $user): int {
		$qb = $this->db->getQueryBuilder();
		$qb->select('seq')->from('tracker_sync_state')->where($qb->expr()->eq('user_id', $qb->createNamedParameter($user)));
		$v = $qb->executeQuery()->fetchOne();
		return $v === false || $v === null ? 0 : (int)$v;
	}

	private function saveSeq(string $user, int $seq): void {
		$qb = $this->db->getQueryBuilder();
		$qb->update('tracker_sync_state')
			->set('seq', $qb->createNamedParameter($seq, IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($user)));
		if ($qb->executeStatement() === 0) {
			$ins = $this->db->getQueryBuilder();
			$ins->insert('tracker_sync_state')->values([
				'user_id' => $ins->createNamedParameter($user),
				'seq' => $ins->createNamedParameter($seq, IQueryBuilder::PARAM_INT),
				'settings_seq' => $ins->createNamedParameter($seq, IQueryBuilder::PARAM_INT),
			]);
			$ins->executeStatement();
		}
	}

	private function uuid(): string {
		$b = random_bytes(16);
		$b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
		$b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
		return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
	}
}
