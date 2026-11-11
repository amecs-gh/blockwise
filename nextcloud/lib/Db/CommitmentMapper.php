<?php

declare(strict_types=1);

namespace OCA\Tracker\Db;

use OCP\AppFramework\Db\QBMapper;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCA\Tracker\Sync\SyncClock;
use OCA\Tracker\Sync\SyncedMapper;
use OCP\IDBConnection;

/** @extends QBMapper<Commitment> */
class CommitmentMapper extends QBMapper {
	use SyncedMapper;

	public function __construct(IDBConnection $db, SyncClock $sync) {
		parent::__construct($db, 'tracker_commitments', Commitment::class);
		$this->sync = $sync;
	}

	protected function syncType(): string {
		return 'commitment';
	}

	public function find(int $id, string $userId): Commitment {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
		return $this->findEntity($qb);
	}

	/** @return Commitment[] */
	public function findAllForUser(string $userId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			// Same position (e.g. made on two devices): by creation, then uuid, like the apps
			->orderBy('position', 'ASC')->addOrderBy('created', 'ASC')->addOrderBy('uuid', 'ASC');
		return $this->findEntities($qb);
	}

	/** @return Commitment[] */
	public function findByCalendar(int $calendarId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('calendar_id', $qb->createNamedParameter($calendarId, IQueryBuilder::PARAM_INT)));
		return $this->findEntities($qb);
	}

	/** @return string[] */
	public function findUserIds(): array {
		$qb = $this->db->getQueryBuilder();
		$qb->selectDistinct('user_id')->from($this->getTableName());
		$res = $qb->executeQuery();
		$ids = [];
		while ($row = $res->fetch()) {
			$ids[] = (string)$row['user_id'];
		}
		$res->closeCursor();
		return $ids;
	}
}
