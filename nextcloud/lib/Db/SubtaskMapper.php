<?php

declare(strict_types=1);

namespace OCA\Tracker\Db;

use OCP\AppFramework\Db\QBMapper;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCA\Tracker\Sync\SyncClock;
use OCA\Tracker\Sync\SyncedMapper;
use OCP\IDBConnection;

/** @extends QBMapper<Subtask> */
class SubtaskMapper extends QBMapper {
	use SyncedMapper;

	public function __construct(IDBConnection $db, SyncClock $sync) {
		parent::__construct($db, 'tracker_subtasks', Subtask::class);
		$this->sync = $sync;
	}

	protected function syncType(): string {
		return 'subtask';
	}

	public function find(int $id, string $userId): Subtask {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
		return $this->findEntity($qb);
	}

	/**
	 * @param int[] $taskIds
	 * @return Subtask[]
	 */
	public function findForTasks(array $taskIds): array {
		if ($taskIds === []) {
			return [];
		}
		$result = [];
		foreach (array_chunk($taskIds, 500) as $chunk) {
			$qb = $this->db->getQueryBuilder();
			$qb->select('*')->from($this->getTableName())
				->where($qb->expr()->in('task_id', $qb->createNamedParameter($chunk, IQueryBuilder::PARAM_INT_ARRAY)))
				->orderBy('position', 'ASC')->addOrderBy('id', 'ASC');
			array_push($result, ...$this->findEntities($qb));
		}
		return $result;
	}

	/** @return Subtask[] subtasks checked in [from, to) */
	public function findDoneBetween(string $userId, int $from, int $to): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->eq('done', $qb->createNamedParameter(1, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->gte('done_at', $qb->createNamedParameter($from, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->lt('done_at', $qb->createNamedParameter($to, IQueryBuilder::PARAM_INT)))
			->orderBy('done_at', 'ASC');
		return $this->findEntities($qb);
	}

	public function maxPosition(int $taskId): int {
		$qb = $this->db->getQueryBuilder();
		$qb->select($qb->func()->max('position'))->from($this->getTableName())
			->where($qb->expr()->eq('task_id', $qb->createNamedParameter($taskId, IQueryBuilder::PARAM_INT)));
		$res = $qb->executeQuery();
		$max = $res->fetchOne();
		$res->closeCursor();
		return $max === null || $max === false ? 0 : (int)$max;
	}

	/** One by one, so each deletion syncs */
	public function deleteByTask(int $taskId): void {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('task_id', $qb->createNamedParameter($taskId, IQueryBuilder::PARAM_INT)));
		foreach ($this->findEntities($qb) as $s) {
			$this->delete($s);
		}
	}
}
