<?php

declare(strict_types=1);

namespace OCA\Tracker\Db;

use JsonSerializable;
use OCP\AppFramework\Db\Entity;

/**
 * @method string getUserId()
 * @method void setUserId(string $userId)
 * @method int getTaskId()
 * @method void setTaskId(int $id)
 * @method string getTitle()
 * @method void setTitle(string $title)
 * @method int getPosition()
 * @method void setPosition(int $position)
 * @method int getDone()
 * @method void setDone(int $done)
 * @method int|null getDoneAt()
 * @method void setDoneAt(?int $ts)
 * @method int|null getEstimate()
 * @method void setEstimate(?int $minutes)
 * @method int getCreated()
 * @method void setCreated(int $created)
 * @method string|null getUuid()
 * @method void setUuid(string $uuid)
 * @method string|null getClock()
 * @method void setClock(?string $clock)
 * @method int getSeq()
 * @method void setSeq(int $seq)
 */
class Subtask extends Entity implements JsonSerializable {
	protected $userId;
	protected $taskId;
	protected $title;
	protected $position;
	protected $done;
	protected $doneAt;
	protected $estimate;
	protected $created;
	// sync (see OCA\Tracker\Sync\SyncClock)
	protected $uuid;
	protected $clock;
	protected $seq;

	public function __construct() {
		$this->addType('seq', 'integer');
		$this->addType('taskId', 'integer');
		$this->addType('position', 'integer');
		$this->addType('done', 'integer');
		$this->addType('doneAt', 'integer');
		$this->addType('estimate', 'integer');
		$this->addType('created', 'integer');
	}

	public function jsonSerialize(): array {
		return [
			'id' => $this->getId(),
			'uuid' => $this->getUuid(),
			'taskId' => $this->getTaskId(),
			'title' => $this->getTitle(),
			'position' => $this->getPosition(),
			'done' => (bool)$this->getDone(),
			'doneAt' => $this->getDoneAt(),
			'estimate' => $this->getEstimate(),
		];
	}
}
