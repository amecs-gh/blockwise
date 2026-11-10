<?php

declare(strict_types=1);

namespace OCA\Tracker\Db;

use JsonSerializable;
use OCP\AppFramework\Db\Entity;

/**
 * @method string getUserId()
 * @method void setUserId(string $userId)
 * @method string getName()
 * @method void setName(string $name)
 * @method string getColor()
 * @method void setColor(string $color)
 * @method int|null getCalendarId()
 * @method void setCalendarId(?int $calendarId)
 * @method int getPosition()
 * @method void setPosition(int $position)
 * @method int getBlockCheckedUntil()
 * @method void setBlockCheckedUntil(int $ts)
 * @method int|null getWeeklyGoal()
 * @method void setWeeklyGoal(?int $minutes)
 * @method int getCreated()
 * @method void setCreated(int $created)
 * @method string|null getCalendarUrl()
 * @method void setCalendarUrl(?string $url)
 * @method string|null getUuid()
 * @method void setUuid(string $uuid)
 * @method string|null getClock()
 * @method void setClock(?string $clock)
 * @method int getSeq()
 * @method void setSeq(int $seq)
 */
class Commitment extends Entity implements JsonSerializable {
	protected $userId;
	protected $name;
	protected $color;
	protected $calendarId;
	protected $position;
	protected $blockCheckedUntil;
	protected $weeklyGoal;
	protected $created;
	protected $calendarUrl;
	// sync (see OCA\Tracker\Sync\SyncClock)
	protected $uuid;
	protected $clock;
	protected $seq;

	public function __construct() {
		$this->addType('seq', 'integer');
		$this->addType('calendarId', 'integer');
		$this->addType('position', 'integer');
		$this->addType('blockCheckedUntil', 'integer');
		$this->addType('weeklyGoal', 'integer');
		$this->addType('created', 'integer');
	}

	public function jsonSerialize(): array {
		return [
			'id' => $this->getId(),
			'uuid' => $this->getUuid(),
			'name' => $this->getName(),
			'color' => $this->getColor(),
			'calendarId' => $this->getCalendarId(),
			'position' => $this->getPosition(),
			'weeklyGoal' => $this->getWeeklyGoal(),
			'calendarUrl' => $this->getCalendarUrl(),
		];
	}
}
