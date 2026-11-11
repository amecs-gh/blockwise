<?php

declare(strict_types=1);

namespace OCA\Tracker\Service;

use OCA\Tracker\AppInfo\Application;
use OCA\Tracker\Sync\SyncClock;
use OCP\Config\IUserConfig;

class SettingsService {
	/** key => [default, min, max]; minutes unless noted */
	public const INTS = [
		'focusMinutes' => [25, 5, 180],
		'shortBreakMinutes' => [5, 1, 60],
		'longBreakMinutes' => [15, 1, 120],
		'sessionsBeforeLongBreak' => [4, 1, 12],
		'reminderMinutes' => [15, 0, 120],
		// minutes for a subtask without an estimate
		'defaultEstimate' => [15, 5, 600],
	];
	public const BOOLS = [
		'pomodoro' => false,
		// the Calendar page in the apps (blocks keep working without it)
		'showCalendar' => true,
	];

	public function __construct(
		private IUserConfig $config,
		private SyncClock $sync,
	) {
	}

	/** @return array<string, int|bool> */
	public function get(string $userId): array {
		$out = [];
		foreach (self::INTS as $key => [$default]) {
			$out[$key] = $this->config->getValueInt($userId, Application::APP_ID, $key, $default);
		}
		foreach (self::BOOLS as $key => $default) {
			$out[$key] = $this->config->getValueBool($userId, Application::APP_ID, $key, $default);
		}
		return $out;
	}

	/** @param array<string, mixed> $values unknown keys are ignored, numbers are clamped */
	public function set(string $userId, array $values, ?array $clocks = null): array {
		$before = $this->get($userId);
		$changed = [];
		foreach (self::INTS as $key => [, $min, $max]) {
			if (array_key_exists($key, $values) && is_numeric($values[$key])) {
				$v = max($min, min($max, (int)$values[$key]));
				$this->config->setValueInt($userId, Application::APP_ID, $key, $v);
				if ($v !== $before[$key] || $clocks !== null) {
					$changed[] = $key;
				}
			}
		}
		foreach (self::BOOLS as $key => $default) {
			if (array_key_exists($key, $values)) {
				$v = (bool)$values[$key];
				$this->config->setValueBool($userId, Application::APP_ID, $key, $v);
				if ($v !== $before[$key] || $clocks !== null) {
					$changed[] = $key;
				}
			}
		}
		// Sync: these settings changed (with the device's clocks when they came from one)
		$this->sync->settingsChanged($userId, $changed, $clocks);
		return $this->get($userId);
	}

	/**
	 * End of the tracked part of a Pomodoro cycle that started at $start:
	 * n focus periods with n-1 short breaks (short breaks count as tracked).
	 */
	public static function pomodoroLongBreakAt(int $start, array $s): int {
		$n = (int)$s['sessionsBeforeLongBreak'];
		return $start + ($n * (int)$s['focusMinutes'] + ($n - 1) * (int)$s['shortBreakMinutes']) * 60;
	}

	public function setLongBreakUntil(string $userId, ?int $until, ?string $clock = null): void {
		$changed = $until !== $this->getLongBreakUntil($userId) || $clock !== null;
		// The value first, then its clock (a device pulling in between must not get the old value with the new clock)
		if ($until === null) {
			$this->config->deleteUserConfig($userId, Application::APP_ID, 'longBreakUntil');
		} else {
			$this->config->setValueInt($userId, Application::APP_ID, 'longBreakUntil', $until);
		}
		if ($changed) {
			$this->sync->settingsChanged($userId, ['longBreakUntil'], $clock !== null ? ['longBreakUntil' => $clock] : null);
		}
	}

	public function getLongBreakUntil(string $userId): ?int {
		$v = $this->config->getValueInt($userId, Application::APP_ID, 'longBreakUntil', 0);
		return $v > 0 ? $v : null;
	}

	/** @return array<string, int> userId => timestamp */
	public function allLongBreaks(): array {
		$out = [];
		foreach ($this->config->getValuesByUsers(Application::APP_ID, 'longBreakUntil', \OCP\Config\ValueType::INT) as $uid => $v) {
			if ((int)$v > 0) {
				$out[(string)$uid] = (int)$v;
			}
		}
		return $out;
	}
}
