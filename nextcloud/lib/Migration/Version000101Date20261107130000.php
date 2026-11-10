<?php

declare(strict_types=1);

namespace OCA\Tracker\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Only subtasks are checkable: give every task without subtasks one subtask
 * with the task's own title, carrying over its done state.
 */
class Version000101Date20261107130000 extends SimpleMigrationStep {
	public function __construct(
		private IDBConnection $db,
	) {
	}

	public function postSchemaChange(IOutput $output, Closure $schemaClosure, array $options): void {
		$qb = $this->db->getQueryBuilder();
		$qb->select('t.id', 't.user_id', 't.title', 't.done', 't.done_at', 't.created')
			->from('tracker_tasks', 't')
			->leftJoin('t', 'tracker_subtasks', 's', $qb->expr()->eq('s.task_id', 't.id'))
			->where($qb->expr()->isNull('s.id'));
		$res = $qb->executeQuery();
		$count = 0;
		while ($row = $res->fetch()) {
			$ins = $this->db->getQueryBuilder();
			$ins->insert('tracker_subtasks')->values([
				'user_id' => $ins->createNamedParameter($row['user_id']),
				'task_id' => $ins->createNamedParameter((int)$row['id'], IQueryBuilder::PARAM_INT),
				'title' => $ins->createNamedParameter($row['title']),
				'position' => $ins->createNamedParameter(1, IQueryBuilder::PARAM_INT),
				'done' => $ins->createNamedParameter((int)$row['done'], IQueryBuilder::PARAM_INT),
				'done_at' => $ins->createNamedParameter($row['done_at'] === null ? null : (int)$row['done_at'], $row['done_at'] === null ? IQueryBuilder::PARAM_NULL : IQueryBuilder::PARAM_INT),
				'created' => $ins->createNamedParameter((int)$row['created'], IQueryBuilder::PARAM_INT),
			])->executeStatement();
			$count++;
		}
		$res->closeCursor();
		if ($count > 0) {
			$output->info("Added a subtask to $count task(s) without subtasks");
		}
	}
}
