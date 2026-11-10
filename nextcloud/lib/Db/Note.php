<?php

declare(strict_types=1);

namespace OCA\Tracker\Db;

use JsonSerializable;
use OCP\AppFramework\Db\Entity;

/**
 * A note of a commitment (Notes tab): markdown text you can tick off.
 * Ticked notes show in Done, like subtasks.
 *
 * @method string getUserId()
 * @method void setUserId(string $userId)
 * @method int getCommitmentId()
 * @method void setCommitmentId(int $id)
 * @method string getText()
 * @method void setText(string $text)
 * @method int getPosition()
 * @method void setPosition(int $position)
 * @method int getDone()
 * @method void setDone(int $done)
 * @method int|null getDoneAt()
 * @method void setDoneAt(?int $ts)
 * @method int getCreated()
 * @method void setCreated(int $created)
 * @method string|null getUuid()
 * @method void setUuid(string $uuid)
 * @method string|null getClock()
 * @method void setClock(?string $clock)
 * @method int getSeq()
 * @method void setSeq(int $seq)
 */
class Note extends Entity implements JsonSerializable {
	public const MAX_TEXT = 20000;

	protected $userId;
	protected $commitmentId;
	protected $text;
	protected $position;
	protected $done;
	protected $doneAt;
	protected $created;
	// sync (see OCA\Tracker\Sync\SyncClock)
	protected $uuid;
	protected $clock;
	protected $seq;

	public function __construct() {
		$this->addType('seq', 'integer');
		$this->addType('commitmentId', 'integer');
		$this->addType('position', 'integer');
		$this->addType('done', 'integer');
		$this->addType('doneAt', 'integer');
		$this->addType('created', 'integer');
	}

	public function jsonSerialize(): array {
		return [
			'id' => $this->getId(),
			'uuid' => $this->getUuid(),
			'commitmentId' => $this->getCommitmentId(),
			'text' => $this->getText(),
			'position' => $this->getPosition(),
			'done' => (bool)$this->getDone(),
			'doneAt' => $this->getDoneAt(),
			'created' => $this->getCreated(),
		];
	}
}
