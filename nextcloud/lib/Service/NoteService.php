<?php

declare(strict_types=1);

namespace OCA\Tracker\Service;

use OCA\Tracker\Db\CommitmentMapper;
use OCA\Tracker\Db\Note;
use OCA\Tracker\Db\NoteMapper;
use OCP\AppFramework\Utility\ITimeFactory;

/** Notes of commitments: write, edit, tick off (shows in Done), reorder. */
class NoteService {
	/** Per commitment, so a list stays usable */
	public const MAX_PER_COMMITMENT = 1000;

	public function __construct(
		private NoteMapper $notes,
		private CommitmentMapper $commitments,
		private ITimeFactory $time,
	) {
	}

	/** @return Note[] */
	public function list(string $userId, ?int $commitmentId, ?bool $done): array {
		if ($commitmentId !== null) {
			$this->commitments->find($commitmentId, $userId); // yours, or "Not found"
		}
		return $this->notes->findForUser($userId, $commitmentId, $done);
	}

	public function create(string $userId, int $commitmentId, mixed $text): Note {
		$this->commitments->find($commitmentId, $userId);
		if (count($this->notes->findForUser($userId, $commitmentId)) >= self::MAX_PER_COMMITMENT) {
			throw new ServiceException('Too many notes');
		}
		$n = new Note();
		$n->setUserId($userId);
		$n->setCommitmentId($commitmentId);
		$n->setText(self::cleanText($text));
		$n->setPosition($this->notes->maxPosition($userId, $commitmentId) + 1);
		$n->setDone(0);
		$n->setCreated($this->time->getTime());
		return $this->notes->insert($n);
	}

	/** @param array{text?: mixed, done?: mixed, commitmentId?: mixed} $data */
	public function update(string $userId, int $id, array $data): Note {
		$n = $this->notes->find($id, $userId);
		if (array_key_exists('text', $data)) {
			$n->setText(self::cleanText($data['text']));
		}
		if (array_key_exists('done', $data)) {
			$done = filter_var($data['done'], FILTER_VALIDATE_BOOLEAN);
			if ($done !== (bool)$n->getDone()) {
				$n->setDone($done ? 1 : 0);
				$n->setDoneAt($done ? $this->time->getTime() : null);
			}
		}
		if (array_key_exists('commitmentId', $data) && is_numeric($data['commitmentId']) && (int)$data['commitmentId'] !== $n->getCommitmentId()) {
			$target = (int)$data['commitmentId'];
			$this->commitments->find($target, $userId);
			$n->setCommitmentId($target);
			$n->setPosition($this->notes->maxPosition($userId, $target) + 1);
		}
		return $this->notes->update($n);
	}

	public function delete(string $userId, int $id): void {
		$this->notes->delete($this->notes->find($id, $userId));
	}

	/** @param int[] $ids open notes of the commitment, in their new order */
	public function reorder(string $userId, int $commitmentId, array $ids): void {
		$this->commitments->find($commitmentId, $userId);
		$pos = 1;
		foreach (array_slice($ids, 0, self::MAX_PER_COMMITMENT) as $id) {
			if (!is_numeric($id)) {
				continue;
			}
			$n = $this->notes->find((int)$id, $userId);
			if ($n->getCommitmentId() !== $commitmentId) {
				continue;
			}
			if ($n->getPosition() !== $pos) {
				$n->setPosition($pos);
				$this->notes->update($n);
			}
			$pos++;
		}
	}

	public static function cleanText(mixed $text): string {
		$text = is_string($text) ? trim(str_replace("\r\n", "\n", $text)) : '';
		if ($text === '') {
			throw new ServiceException('Text is required');
		}
		return mb_substr($text, 0, Note::MAX_TEXT);
	}
}
