<?php

declare(strict_types=1);

namespace OCA\Tracker\Db;

use JsonSerializable;
use OCP\AppFramework\Db\Entity;

/**
 * @method string getUserId()
 * @method void setUserId(string $userId)
 * @method int getCommitmentId()
 * @method void setCommitmentId(int $id)
 * @method string getTitle()
 * @method void setTitle(string $title)
 * @method string|null getNote()
 * @method void setNote(?string $note)
 * @method int|null getEstimate()
 * @method void setEstimate(?int $minutes)
 * @method int getPosition()
 * @method void setPosition(int $position)
 * @method int getDone()
 * @method void setDone(int $done)
 * @method int|null getDoneAt()
 * @method void setDoneAt(?int $ts)
 * @method int getCarried()
 * @method void setCarried(int $carried)
 * @method int getCreated()
 * @method void setCreated(int $created)
 * @method string|null getCarriedKeys()
 * @method void setCarriedKeys(?string $json)
 * @method string|null getUuid()
 * @method void setUuid(string $uuid)
 * @method string|null getClock()
 * @method void setClock(?string $clock)
 * @method int getSeq()
 * @method void setSeq(int $seq)
 */
class Task extends Entity implements JsonSerializable {
	protected $userId;
	protected $commitmentId;
	protected $title;
	protected $note;
	protected $estimate;
	protected $position;
	protected $done;
	protected $doneAt;
	protected $carried;
	protected $created;
	protected $carriedKeys;
	// sync (see OCA\Tracker\Sync\SyncClock)
	protected $uuid;
	protected $clock;
	protected $seq;

	/** @var Subtask[] filled by the service, not persisted */
	public array $subtasks = [];

	public function __construct() {
		$this->addType('seq', 'integer');
		$this->addType('commitmentId', 'integer');
		$this->addType('estimate', 'integer');
		$this->addType('position', 'integer');
		$this->addType('done', 'integer');
		$this->addType('doneAt', 'integer');
		$this->addType('carried', 'integer');
		$this->addType('created', 'integer');
	}

	/** Blocks this task was carried over from (a set: merges between devices without double counting). */
	public function carriedBlocks(): array {
		$d = json_decode((string)$this->getCarriedKeys(), true);
		return is_array($d) ? array_values(array_filter($d, 'is_string')) : [];
	}

	public function setCarriedBlocks(array $keys): void {
		$keys = array_values(array_unique(array_filter($keys, fn ($k) => is_string($k) && $k !== '' && strlen($k) <= 600)));
		$keys = array_slice($keys, -500);
		$this->setCarriedKeys($keys === [] ? null : json_encode($keys, JSON_UNESCAPED_SLASHES));
		$this->setCarried(count($keys));
	}

	public function estimateSum(): ?int {
		$sum = null;
		foreach ($this->subtasks as $s) {
			if ($s->getEstimate() !== null) {
				$sum = ($sum ?? 0) + $s->getEstimate();
			}
		}
		return $sum;
	}

	/**
	 * Seconds of work left, open subtasks without an estimate count as $default minutes.
	 * With $at, subtasks finished at or after $at count as open (the state at that time).
	 */
	public function remainingSeconds(int $defaultMinutes, ?int $at = null): int {
		$sec = 0;
		foreach ($this->subtasks as $s) {
			$open = !$s->getDone() || ($at !== null && (int)$s->getDoneAt() >= $at);
			if ($open) {
				$sec += ($s->getEstimate() ?? $defaultMinutes) * 60;
			}
		}
		return $sec;
	}

	public function jsonSerialize(): array {
		return [
			'id' => $this->getId(),
			'uuid' => $this->getUuid(),
			'commitmentId' => $this->getCommitmentId(),
			'title' => $this->getTitle(),
			'note' => $this->getNote(),
			// Sum of the subtask estimates (null if none has one)
			'estimate' => $this->estimateSum(),
			'position' => $this->getPosition(),
			'done' => (bool)$this->getDone(),
			'doneAt' => $this->getDoneAt(),
			'carried' => $this->getCarried(),
			'created' => $this->getCreated(),
			'subtasks' => $this->subtasks,
		];
	}
}
