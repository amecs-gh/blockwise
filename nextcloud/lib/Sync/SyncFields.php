<?php

declare(strict_types=1);

namespace OCA\Tracker\Sync;

/**
 * Which fields of each record sync between devices, by their name on the wire
 * => the entity property. Everything else (calendar id, reminder bookkeeping…)
 * stays on the server.
 */
final class SyncFields {
	public const TYPES = ['commitment', 'task', 'subtask', 'note', 'session'];

	public const MAP = [
		'commitment' => [
			'name' => 'name',
			'color' => 'color',
			'goal' => 'weeklyGoal',
			'position' => 'position',
			'calendarUrl' => 'calendarUrl',
			'created' => 'created',
		],
		'task' => [
			'commitment' => 'commitmentId',
			'title' => 'title',
			'note' => 'note',
			'position' => 'position',
			'done' => 'done',
			'doneAt' => 'doneAt',
			'created' => 'created',
			'carriedBlocks' => 'carriedKeys',
		],
		'subtask' => [
			'task' => 'taskId',
			'title' => 'title',
			'position' => 'position',
			'done' => 'done',
			'doneAt' => 'doneAt',
			'estimate' => 'estimate',
			'created' => 'created',
		],
		'note' => [
			'commitment' => 'commitmentId',
			'text' => 'text',
			'position' => 'position',
			'done' => 'done',
			'doneAt' => 'doneAt',
			'created' => 'created',
		],
		'session' => [
			'commitment' => 'commitmentId',
			'start' => 'start',
			'end' => 'end',
			'blockUid' => 'blockUid',
			'pomodoro' => 'pomodoro',
		],
	];

	/** Settings sync as one record per user; its fields are these keys. */
	public const SETTINGS = ['focusMinutes', 'shortBreakMinutes', 'longBreakMinutes', 'sessionsBeforeLongBreak', 'reminderMinutes', 'defaultEstimate', 'pomodoro', 'showCalendar', 'longBreakUntil'];

	/** Fields that hold another record (as its uuid on the wire) => its type */
	public const REFS = [
		'task' => ['commitment' => 'commitment'],
		'subtask' => ['task' => 'task'],
		'note' => ['commitment' => 'commitment'],
		'session' => ['commitment' => 'commitment'],
	];

	/** Wire names of the given entity properties. */
	public static function wireNames(string $type, array $properties): array {
		$flip = array_flip(self::MAP[$type]);
		$out = [];
		foreach ($properties as $p) {
			if (isset($flip[$p])) {
				$out[] = $flip[$p];
			}
		}
		return $out;
	}
}
