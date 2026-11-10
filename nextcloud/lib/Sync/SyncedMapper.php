<?php

declare(strict_types=1);

namespace OCA\Tracker\Sync;

use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Db\Entity;
use OCP\DB\QueryBuilder\IQueryBuilder;

/**
 * For the mappers of synced records: every insert/update/delete goes through
 * the sync clock, in one transaction with the write (so change numbers are
 * committed in order). Used instead of raw bulk SQL, so nothing escapes sync.
 */
trait SyncedMapper {
	protected SyncClock $sync;

	abstract protected function syncType(): string;

	public function insert(Entity $entity): Entity {
		$this->db->beginTransaction();
		try {
			$this->sync->beforeWrite($this->syncType(), $entity, true);
			$r = parent::insert($entity);
			$this->db->commit();
			return $r;
		} catch (\Throwable $e) {
			$this->db->rollBack();
			throw $e;
		}
	}

	public function update(Entity $entity): Entity {
		$this->db->beginTransaction();
		try {
			$this->sync->beforeWrite($this->syncType(), $entity, false);
			$r = parent::update($entity);
			$this->db->commit();
			return $r;
		} catch (\Throwable $e) {
			$this->db->rollBack();
			throw $e;
		}
	}

	public function delete(Entity $entity): Entity {
		$this->db->beginTransaction();
		try {
			$r = parent::delete($entity);
			$this->sync->tombstone((string)$entity->getUserId(), $this->syncType(), (string)$entity->getUuid());
			$this->db->commit();
			return $r;
		} catch (\Throwable $e) {
			$this->db->rollBack();
			throw $e;
		}
	}

	/** By uuid, any user (the caller checks the owner). */
	public function findByUuid(string $uuid): Entity {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('uuid', $qb->createNamedParameter($uuid)));
		return $this->findEntity($qb);
	}

	public function findByUuidOrNull(string $uuid): ?Entity {
		try {
			return $this->findByUuid($uuid);
		} catch (DoesNotExistException $e) {
			return null;
		}
	}

	/** Records of the user changed after change number $since, oldest first. */
	public function findChangedSince(string $userId, int $since, int $limit): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from($this->getTableName())
			->where($qb->expr()->eq('user_id', $qb->createNamedParameter($userId)))
			->andWhere($qb->expr()->gt('seq', $qb->createNamedParameter($since, IQueryBuilder::PARAM_INT)))
			->orderBy('seq', 'ASC')
			->setMaxResults($limit);
		return $this->findEntities($qb);
	}
}
