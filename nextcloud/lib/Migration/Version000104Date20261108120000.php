<?php

declare(strict_types=1);

namespace OCA\Tracker\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * Record ids (uuids) are unique: two devices sending the same new record at
 * the same moment can't create it twice (the second request fails and is
 * sent again, then updates the one record).
 */
class Version000104Date20261108120000 extends SimpleMigrationStep {
	private const TABLES = ['tracker_commitments', 'tracker_tasks', 'tracker_subtasks', 'tracker_sessions'];

	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		foreach (self::TABLES as $name) {
			$t = $schema->getTable($name);
			$short = substr($name, 8, 4);
			if ($t->hasIndex('tracker_' . $short . '_uuid')) {
				$t->dropIndex('tracker_' . $short . '_uuid');
			}
			if (!$t->hasIndex('tracker_' . $short . '_uuidu')) {
				$t->addUniqueIndex(['uuid'], 'tracker_' . $short . '_uuidu');
			}
		}
		return $schema;
	}
}
