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
 * - Estimates move from tasks to subtasks (a task's estimate is the sum).
 * - Commitments get an optional weekly goal in minutes.
 */
class Version000102Date20261107150000 extends SimpleMigrationStep {
	public function __construct(
		private IDBConnection $db,
	) {
	}

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		$changed = false;

		$subtasks = $schema->getTable('tracker_subtasks');
		if (!$subtasks->hasColumn('estimate')) {
			$subtasks->addColumn('estimate', Types::INTEGER, ['notnull' => false]);
			$changed = true;
		}
		$commitments = $schema->getTable('tracker_commitments');
		if (!$commitments->hasColumn('weekly_goal')) {
			$commitments->addColumn('weekly_goal', Types::INTEGER, ['notnull' => false]);
			$changed = true;
		}
		return $changed ? $schema : null;
	}

	public function postSchemaChange(IOutput $output, Closure $schemaClosure, array $options): void {
		// Split each task estimate evenly over its subtasks (rounded to 5 minutes)
		$qb = $this->db->getQueryBuilder();
		$qb->select('id', 'estimate')->from('tracker_tasks')
			->where($qb->expr()->isNotNull('estimate'))
			->andWhere($qb->expr()->gt('estimate', $qb->createNamedParameter(0, IQueryBuilder::PARAM_INT)));
		$res = $qb->executeQuery();
		$moved = 0;
		while ($row = $res->fetch()) {
			$sq = $this->db->getQueryBuilder();
			$sq->select('id')->from('tracker_subtasks')
				->where($sq->expr()->eq('task_id', $sq->createNamedParameter((int)$row['id'], IQueryBuilder::PARAM_INT)))
				->andWhere($sq->expr()->isNull('estimate'));
			$ids = array_map('intval', $sq->executeQuery()->fetchAll(\PDO::FETCH_COLUMN));
			if ($ids !== []) {
				$each = max(5, (int)(round((int)$row['estimate'] / count($ids) / 5) * 5));
				$up = $this->db->getQueryBuilder();
				$up->update('tracker_subtasks')
					->set('estimate', $up->createNamedParameter($each, IQueryBuilder::PARAM_INT))
					->where($up->expr()->in('id', $up->createNamedParameter($ids, IQueryBuilder::PARAM_INT_ARRAY)));
				$up->executeStatement();
			}
			$clear = $this->db->getQueryBuilder();
			$clear->update('tracker_tasks')
				->set('estimate', $clear->createNamedParameter(null, IQueryBuilder::PARAM_NULL))
				->where($clear->expr()->eq('id', $clear->createNamedParameter((int)$row['id'], IQueryBuilder::PARAM_INT)));
			$clear->executeStatement();
			$moved++;
		}
		$res->closeCursor();
		if ($moved > 0) {
			$output->info("Moved the estimates of $moved task(s) to their subtasks");
		}
	}
}
