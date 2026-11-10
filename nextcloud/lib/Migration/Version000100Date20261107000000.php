<?php

declare(strict_types=1);

namespace OCA\Tracker\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

class Version000100Date20261107000000 extends SimpleMigrationStep {

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		if (!$schema->hasTable('tracker_commitments')) {
			$t = $schema->createTable('tracker_commitments');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'unsigned' => true]);
			$t->addColumn('user_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			$t->addColumn('name', Types::STRING, ['notnull' => true, 'length' => 255]);
			$t->addColumn('color', Types::STRING, ['notnull' => true, 'length' => 16, 'default' => '#0082c9']);
			$t->addColumn('calendar_id', Types::BIGINT, ['notnull' => false, 'unsigned' => true]);
			$t->addColumn('position', Types::INTEGER, ['notnull' => true, 'default' => 0]);
			$t->addColumn('block_checked_until', Types::BIGINT, ['notnull' => true, 'default' => 0]);
			$t->addColumn('created', Types::BIGINT, ['notnull' => true, 'default' => 0]);
			$t->setPrimaryKey(['id']);
			$t->addIndex(['user_id'], 'tracker_c_user');
			$t->addIndex(['calendar_id'], 'tracker_c_cal');
		}

		if (!$schema->hasTable('tracker_tasks')) {
			$t = $schema->createTable('tracker_tasks');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'unsigned' => true]);
			$t->addColumn('user_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			$t->addColumn('commitment_id', Types::BIGINT, ['notnull' => true, 'unsigned' => true]);
			$t->addColumn('title', Types::STRING, ['notnull' => true, 'length' => 255]);
			$t->addColumn('note', Types::TEXT, ['notnull' => false]);
			$t->addColumn('estimate', Types::INTEGER, ['notnull' => false]);
			$t->addColumn('position', Types::INTEGER, ['notnull' => true, 'default' => 0]);
			$t->addColumn('done', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
			$t->addColumn('done_at', Types::BIGINT, ['notnull' => false]);
			$t->addColumn('carried', Types::INTEGER, ['notnull' => true, 'default' => 0]);
			$t->addColumn('created', Types::BIGINT, ['notnull' => true, 'default' => 0]);
			$t->setPrimaryKey(['id']);
			$t->addIndex(['user_id', 'commitment_id'], 'tracker_t_user_c');
			$t->addIndex(['user_id', 'done_at'], 'tracker_t_done');
		}

		if (!$schema->hasTable('tracker_subtasks')) {
			$t = $schema->createTable('tracker_subtasks');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'unsigned' => true]);
			$t->addColumn('user_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			$t->addColumn('task_id', Types::BIGINT, ['notnull' => true, 'unsigned' => true]);
			$t->addColumn('title', Types::STRING, ['notnull' => true, 'length' => 255]);
			$t->addColumn('position', Types::INTEGER, ['notnull' => true, 'default' => 0]);
			$t->addColumn('done', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
			$t->addColumn('done_at', Types::BIGINT, ['notnull' => false]);
			$t->addColumn('created', Types::BIGINT, ['notnull' => true, 'default' => 0]);
			$t->setPrimaryKey(['id']);
			$t->addIndex(['task_id'], 'tracker_s_task');
			$t->addIndex(['user_id', 'done_at'], 'tracker_s_done');
		}

		if (!$schema->hasTable('tracker_sessions')) {
			$t = $schema->createTable('tracker_sessions');
			$t->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'unsigned' => true]);
			$t->addColumn('user_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			// NULL = unplanned time not tied to a commitment
			$t->addColumn('commitment_id', Types::BIGINT, ['notnull' => false, 'unsigned' => true]);
			$t->addColumn('start', Types::BIGINT, ['notnull' => true]);
			// NULL while the timer is running
			$t->addColumn('end', Types::BIGINT, ['notnull' => false]);
			$t->addColumn('block_uid', Types::STRING, ['notnull' => false, 'length' => 512]);
			$t->addColumn('pomodoro', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
			$t->addColumn('reminded', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
			$t->setPrimaryKey(['id']);
			$t->addIndex(['user_id', 'start'], 'tracker_se_user_start');
			$t->addIndex(['end'], 'tracker_se_end');
		}

		return $schema;
	}
}
