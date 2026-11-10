<?php

declare(strict_types=1);

namespace OCA\Tracker\Db;

use OCP\AppFramework\Db\QBMapper;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCA\Tracker\Sync\SyncClock;
use OCA\Tracker\Sync\SyncedMapper;
use OCP\IDBConnection;

/** @extends QBMapper<Task> */
class TaskMapper extends QBMapper {
	use SyncedMapper;

	public function __construct(IDBConnection $db, SyncClock $sync) {
		parent::__construct($db, 'tracker_tasks', Task::class);
		$this->sync = $sync;
	}

	protected function syncType(): string {
		return 'task';
	}

	public function find(int $id, string $userId): Task {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
		return $this->findEntity($qb);
	}

	/**
	 * @param int|null $commitmentId null = all commitments
	 * @param bool|null $done null = both
	 * @return Task[]
	 */
	public function findForUser(string $userId, ?int $commitmentId = null, ?bool $done = null): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
		if ($commitmentId !== null) {
			$qb->andWhere($qb->expr()->eq('commitment_id', $qb->createNamedParameter($commitmentId, IQueryBuilder::PARAM_INT)));
		}
		if ($done !== null) {
			$qb->andWhere($qb->expr()->eq('done', $qb->createNamedParameter($done ? 1 : 0, IQueryBuilder::PARAM_INT)));
		}
		$qb->orderBy('position', 'ASC')->addOrderBy('id', 'ASC');
		return $this->findEntities($qb);
	}

	/** @return Task[] tasks completed in [from, to) */
	public function findDoneBetween(string $userId, int $from, int $to): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->gte('done_at', $qb->createNamedParameter($from, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->lt('done_at', $qb->createNamedParameter($to, IQueryBuilder::PARAM_INT)))
			->orderBy('done_at', 'ASC');
		return $this->findEntities($qb);
	}

	public function maxPosition(string $userId, int $commitmentId): int {
		$qb = $this->db->getQueryBuilder();
		$qb->select($qb->func()->max('position'))->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->eq('commitment_id', $qb->createNamedParameter($commitmentId, IQueryBuilder::PARAM_INT)));
		$res = $qb->executeQuery();
		$max = $res->fetchOne();
		$res->closeCursor();
		return $max === null || $max === false ? 0 : (int)$max;
	}

	/** One by one, so each deletion syncs */
	public function deleteByCommitment(string $userId, int $commitmentId): void {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->eq('commitment_id', $qb->createNamedParameter($commitmentId, IQueryBuilder::PARAM_INT)));
		foreach ($this->findEntities($qb) as $t) {
			$this->delete($t);
		}
	}
}
