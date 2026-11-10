<?php

declare(strict_types=1);

namespace OCA\Tracker\Controller;

use OCA\Tracker\AppInfo\Application;
use OCA\Tracker\Service\CalendarService;
use OCA\Tracker\Service\CommitmentService;
use OCA\Tracker\Service\NoteService;
use OCA\Tracker\Service\PlanService;
use OCA\Tracker\Service\ServiceException;
use OCA\Tracker\Service\SessionService;
use OCA\Tracker\Service\SettingsService;
use OCA\Tracker\Service\TaskService;
use OCA\Tracker\Sync\SyncService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IRequest;

class ApiController extends Controller {
	public function __construct(
		IRequest $request,
		private ?string $userId,
		private CommitmentService $commitments,
		private CalendarService $calendars,
		private TaskService $tasks,
		private SessionService $sessions,
		private SettingsService $settings,
		private PlanService $plans,
		private SyncService $sync,
		private NoteService $notes,
		private ITimeFactory $time,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	/** Runs $fn and turns known errors into JSON error responses. */
	private function handle(callable $fn): JSONResponse {
		try {
			return new JSONResponse($fn());
		} catch (ServiceException $e) {
			return new JSONResponse(['message' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		} catch (DoesNotExistException) {
			return new JSONResponse(['message' => 'Not found'], Http::STATUS_NOT_FOUND);
		}
	}

	private function uid(): string {
		return (string)$this->userId;
	}

	/** @return array{0: int, 1: int} */
	private function range(?int $from, ?int $to): array {
		$now = $this->time->getTime();
		$from ??= $now - 30 * 86400;
		$to ??= $now + 86400;
		if ($to <= $from) {
			throw new ServiceException('Invalid range');
		}
		// Keep requests bounded (about 13 months)
		$from = max($from, $to - 400 * 86400);
		return [$from, $to];
	}

	// --- state & settings ---------------------------------------------------

	#[NoAdminRequired]
	public function state(): JSONResponse {
		return $this->handle(function () {
			$commitments = $this->commitments->listSynced($this->uid());
			$linked = array_filter(array_map(fn ($c) => $c->getCalendarId(), $commitments));
			$calendars = array_values(array_map(
				fn ($cal) => $cal + ['linked' => in_array($cal['id'], $linked, true), 'url' => CalendarService::calendarUrl($this->uid(), $cal['uri'])],
				$this->calendars->listCalendars($this->uid()),
			));
			return [
				'commitments' => $commitments,
				'calendars' => $calendars,
				'settings' => $this->settings->get($this->uid()),
				'running' => $this->sessions->running($this->uid()),
				'longBreakUntil' => $this->settings->getLongBreakUntil($this->uid()),
				'now' => $this->time->getTime(),
			];
		});
	}

	#[NoAdminRequired]
	public function dashboard(): JSONResponse {
		return $this->handle(fn () => $this->plans->dashboard($this->uid(), $this->sessions));
	}

	// --- sync (local-first apps) ---------------------------------------------

	/** Changes after change number $since (a page at a time: repeat while "more"). */
	#[NoAdminRequired]
	public function syncPull(int $since = 0): JSONResponse {
		// Read here, not as a parameter: Nextcloud limits any "limit" parameter to 500 and fails with an error above
		$limit = $this->request->getParam('limit');
		$limit = is_numeric($limit) ? (int)$limit : SyncService::PAGE;
		return $this->handle(fn () => $this->sync->pull($this->uid(), $since, max(1, min($limit, SyncService::PAGE))));
	}

	/** A device's changes; per field, the later change wins. */
	#[NoAdminRequired]
	public function syncPush(): JSONResponse {
		$records = $this->request->getParam('records');
		return $this->handle(fn () => $this->sync->push($this->uid(), is_array($records) ? $records : []));
	}

	#[NoAdminRequired]
	public function updateSettings(): JSONResponse {
		return $this->handle(fn () => $this->settings->set($this->uid(), $this->request->getParams()));
	}

	// --- commitments --------------------------------------------------------

	#[NoAdminRequired]
	public function createCommitment(string $name = '', string $color = '#0082c9', ?int $calendarId = null): JSONResponse {
		return $this->handle(fn () => $this->commitments->create($this->uid(), $name, $color, $calendarId));
	}

	#[NoAdminRequired]
	public function updateCommitment(int $id, ?string $name = null, ?string $color = null, ?int $calendarId = null, bool $relink = false): JSONResponse {
		$params = $this->request->getParams();
		$setGoal = array_key_exists('weeklyGoal', $params);
		$goal = $setGoal && $params['weeklyGoal'] !== null && $params['weeklyGoal'] !== '' ? (int)$params['weeklyGoal'] : null;
		return $this->handle(fn () => $this->commitments->update($this->uid(), $id, $name, $color, $calendarId, $relink, $goal, $setGoal));
	}

	#[NoAdminRequired]
	public function deleteCommitment(int $id): JSONResponse {
		return $this->handle(function () use ($id) {
			$this->commitments->delete($this->uid(), $id);
			return ['ok' => true];
		});
	}

	#[NoAdminRequired]
	public function reorderCommitments(array $ids = []): JSONResponse {
		return $this->handle(function () use ($ids) {
			$this->commitments->reorder($this->uid(), $ids);
			return ['ok' => true];
		});
	}

	// --- tasks & subtasks ---------------------------------------------------

	#[NoAdminRequired]
	public function tasks(?int $commitmentId = null, ?string $status = null): JSONResponse {
		$done = match ($status) {
			'open' => false,
			'done' => true,
			default => null,
		};
		return $this->handle(fn () => $this->tasks->list($this->uid(), $commitmentId, $done));
	}

	#[NoAdminRequired]
	public function createTask(int $commitmentId, string $title = '', ?string $note = null, ?int $estimate = null, array $subtasks = []): JSONResponse {
		return $this->handle(fn () => $this->tasks->create($this->uid(), $commitmentId, $title, $note, $estimate, $subtasks));
	}

	#[NoAdminRequired]
	public function updateTask(int $id): JSONResponse {
		$data = array_intersect_key($this->request->getParams(), array_flip(['title', 'note', 'commitmentId']));
		return $this->handle(fn () => $this->tasks->update($this->uid(), $id, $data));
	}

	#[NoAdminRequired]
	public function deleteTask(int $id): JSONResponse {
		return $this->handle(function () use ($id) {
			$this->tasks->delete($this->uid(), $id);
			return ['ok' => true];
		});
	}

	#[NoAdminRequired]
	public function reorderTasks(int $commitmentId, array $ids = []): JSONResponse {
		return $this->handle(function () use ($commitmentId, $ids) {
			$this->tasks->reorder($this->uid(), $commitmentId, $ids);
			return ['ok' => true];
		});
	}

	#[NoAdminRequired]
	public function createSubtask(int $taskId, string $title = '', ?int $estimate = null): JSONResponse {
		return $this->handle(function () use ($taskId, $title, $estimate) {
			$this->tasks->createSubtask($this->uid(), $taskId, $title, $estimate);
			return $this->tasks->get($this->uid(), $taskId);
		});
	}

	#[NoAdminRequired]
	public function reorderSubtasks(int $taskId, array $ids = []): JSONResponse {
		return $this->handle(fn () => $this->tasks->reorderSubtasks($this->uid(), $taskId, $ids));
	}

	#[NoAdminRequired]
	public function updateSubtask(int $id): JSONResponse {
		$data = array_intersect_key($this->request->getParams(), array_flip(['title', 'done', 'estimate']));
		return $this->handle(fn () => $this->tasks->updateSubtask($this->uid(), $id, $data));
	}

	#[NoAdminRequired]
	public function deleteSubtask(int $id): JSONResponse {
		return $this->handle(fn () => $this->tasks->deleteSubtask($this->uid(), $id));
	}

	// --- notes ---------------------------------------------------------------

	#[NoAdminRequired]
	public function notes(?int $commitmentId = null, ?string $status = null): JSONResponse {
		$done = match ($status) {
			'open' => false,
			'done' => true,
			default => null,
		};
		return $this->handle(fn () => $this->notes->list($this->uid(), $commitmentId, $done));
	}

	#[NoAdminRequired]
	public function createNote(int $commitmentId): JSONResponse {
		// Any JSON type may arrive: NoteService only takes strings
		$text = $this->request->getParam('text');
		return $this->handle(fn () => $this->notes->create($this->uid(), $commitmentId, $text));
	}

	#[NoAdminRequired]
	public function updateNote(int $id): JSONResponse {
		$data = array_intersect_key($this->request->getParams(), array_flip(['text', 'done', 'commitmentId']));
		return $this->handle(fn () => $this->notes->update($this->uid(), $id, $data));
	}

	#[NoAdminRequired]
	public function deleteNote(int $id): JSONResponse {
		return $this->handle(function () use ($id) {
			$this->notes->delete($this->uid(), $id);
			return ['ok' => true];
		});
	}

	#[NoAdminRequired]
	public function reorderNotes(int $commitmentId, array $ids = []): JSONResponse {
		return $this->handle(function () use ($commitmentId, $ids) {
			$this->notes->reorder($this->uid(), $commitmentId, $ids);
			return ['ok' => true];
		});
	}

	// --- reports ------------------------------------------------------------

	#[NoAdminRequired]
	public function blocks(?int $from = null, ?int $to = null): JSONResponse {
		return $this->handle(function () use ($from, $to) {
			[$from, $to] = $this->range($from, $to);
			$blocks = $this->commitments->blocks($this->uid(), $from, $to);
			return ['blocks' => $blocks, 'overlaps' => CommitmentService::findOverlaps($blocks)];
		});
	}

	#[NoAdminRequired]
	public function done(?int $from = null, ?int $to = null): JSONResponse {
		return $this->handle(function () use ($from, $to) {
			[$from, $to] = $this->range($from, $to);
			return $this->tasks->done($this->uid(), $from, $to);
		});
	}

	// --- time tracking ------------------------------------------------------

	#[NoAdminRequired]
	public function sessions(?int $from = null, ?int $to = null): JSONResponse {
		return $this->handle(function () use ($from, $to) {
			[$from, $to] = $this->range($from, $to);
			return $this->sessions->list($this->uid(), $from, $to);
		});
	}

	#[NoAdminRequired]
	public function startSession(?int $commitmentId = null, ?bool $pomodoro = null): JSONResponse {
		return $this->handle(fn () => $this->sessions->start($this->uid(), $commitmentId, $pomodoro));
	}

	#[NoAdminRequired]
	public function stopSession(?int $at = null, bool $longBreak = false): JSONResponse {
		return $this->handle(fn () => ['session' => $this->sessions->stop($this->uid(), $at, $longBreak), 'longBreakUntil' => $this->settings->getLongBreakUntil($this->uid())]);
	}

	#[NoAdminRequired]
	public function deleteSession(int $id): JSONResponse {
		return $this->handle(function () use ($id) {
			$this->sessions->delete($this->uid(), $id);
			return ['ok' => true];
		});
	}
}
