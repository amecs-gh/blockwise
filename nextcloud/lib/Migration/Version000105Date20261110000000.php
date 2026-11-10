<?php

declare(strict_types=1);

namespace OCA\Tracker\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/** Notes of commitments (Notes tab): text you can tick off; synced like tasks. */
class Version000105Date20261110000000 extends SimpleMigrationStep {
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		if ($schema->hasTable('tracker_notes')) {
			return null;
		}
		$t = $schema->createTable('tracker_notes');
		$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'unsigned' => true]);
		$t->addColumn('user_id', Types::STRING, ['notnull' => true, 'length' => 64]);
		$t->addColumn('commitment_id', Types::BIGINT, ['notnull' => true, 'unsigned' => true]);
		$t->addColumn('text', Types::TEXT, ['notnull' => true]);
		$t->addColumn('position', Types::INTEGER, ['notnull' => true, 'default' => 0]);
		$t->addColumn('done', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
		$t->addColumn('done_at', Types::BIGINT, ['notnull' => false]);
		$t->addColumn('created', Types::BIGINT, ['notnull' => true, 'default' => 0]);
		$t->addColumn('uuid', Types::STRING, ['notnull' => false, 'length' => 36]);
		$t->addColumn('clock', Types::TEXT, ['notnull' => false]);
		$t->addColumn('seq', Types::BIGINT, ['notnull' => true, 'default' => 0, 'unsigned' => true]);
		$t->setPrimaryKey(['id']);
		$t->addIndex(['user_id', 'commitment_id'], 'tracker_note_commit');
		$t->addIndex(['user_id', 'done', 'done_at'], 'tracker_note_done');
		$t->addIndex(['user_id', 'seq'], 'tracker_note_seq');
		$t->addUniqueIndex(['uuid'], 'tracker_note_uuidu');
		return $schema;
	}
}
