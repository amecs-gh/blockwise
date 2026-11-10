<?php

declare(strict_types=1);

namespace OCA\Tracker\Db;

use JsonSerializable;
use OCP\AppFramework\Db\Entity;

/**
 * A tracked stretch of time. commitmentId NULL = unplanned, end NULL = running.
 *
 * @method string getUserId()
 * @method void setUserId(string $userId)
 * @method int|null getCommitmentId()
 * @method void setCommitmentId(?int $id)
 * @method int getStart()
 * @method void setStart(int $ts)
 * @method int|null getEnd()
 * @method void setEnd(?int $ts)
 * @method string|null getBlockUid()
 * @method void setBlockUid(?string $uid)
 * @method int getPomodoro()
 * @method void setPomodoro(int $on)
 * @method int getReminded()
 * @method void setReminded(int $reminded)
 * @method string|null getUuid()
 * @method void setUuid(string $uuid)
 * @method string|null getClock()
 * @method void setClock(?string $clock)
 * @method int getSeq()
 * @method void setSeq(int $seq)
 */
class Session extends Entity implements JsonSerializable {
	protected $userId;
	protected $commitmentId;
	protected $start;
	protected $end;
	protected $blockUid;
	protected $pomodoro;
	protected $reminded;
	// sync (see OCA\Tracker\Sync\SyncClock)
	protected $uuid;
	protected $clock;
	protected $seq;

	public function __construct() {
		$this->addType('seq', 'integer');
		$this->addType('commitmentId', 'integer');
		$this->addType('start', 'integer');
		$this->addType('end', 'integer');
		$this->addType('pomodoro', 'integer');
		$this->addType('reminded', 'integer');
	}

	public function jsonSerialize(): array {
		return [
			'id' => $this->getId(),
			'uuid' => $this->getUuid(),
			'commitmentId' => $this->getCommitmentId(),
			'start' => $this->getStart(),
			'end' => $this->getEnd(),
			'blockUid' => $this->getBlockUid(),
			'pomodoro' => (bool)$this->getPomodoro(),
		];
	}
}
