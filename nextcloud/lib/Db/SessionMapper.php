<?php

declare(strict_types=1);

namespace OCA\Tracker\Db;

use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Db\QBMapper;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCA\Tracker\Sync\SyncClock;
use OCA\Tracker\Sync\SyncedMapper;
use OCP\IDBConnection;

/** @extends QBMapper<Session> */
class SessionMapper extends QBMapper {
	use SyncedMapper;

	public function __construct(IDBConnection $db, SyncClock $sync) {
		parent::__construct($db, 'tracker_sessions', Session::class);
		$this->sync = $sync;
	}

	protected function syncType(): string {
		return 'session';
	}

	public function find(int $id, string $userId): Session {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('id', $qb->createNamedParameter($id, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)));
		return $this->findEntity($qb);
	}

	public function findRunning(string $userId): ?Session {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->isNull('end'))
			->orderBy('start', 'DESC')
			->setMaxResults(1);
		try {
			return $this->findEntity($qb);
		} catch (DoesNotExistException) {
			return null;
		}
	}

	/** @return Session[] all running sessions of all users */
	public function findAllRunning(): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->isNull('end'));
		return $this->findEntities($qb);
	}

	/** @return Session[] sessions overlapping [from, to) */
	public function findBetween(string $userId, int $from, int $to): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->lt('start', $qb->createNamedParameter($to, IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->orX(
				$qb->expr()->isNull('end'),
				$qb->expr()->gt('end', $qb->createNamedParameter($from, IQueryBuilder::PARAM_INT)),
			))
			->orderBy('start', 'ASC');
		return $this->findEntities($qb);
	}

	/** Tracked time of a deleted commitment stays, as unplanned time. One by one, so each change syncs. */
	public function unlinkCommitment(string $userId, int $commitmentId): void {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->eq('commitment_id', $qb->createNamedParameter($commitmentId, IQueryBuilder::PARAM_INT)));
		foreach ($this->findEntities($qb) as $s) {
			$s->setCommitmentId(null);
			$this->update($s);
		}
	}

	/** @return Session[] running sessions (normally at most one) */
	public function findRunningForUser(string $userId): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->isNull('end'))
			->orderBy('start', 'ASC');
		return $this->findEntities($qb);
	}
}
