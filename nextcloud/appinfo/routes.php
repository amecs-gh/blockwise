<?php

declare(strict_types=1);

return [
	'routes' => [
		['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],

		['name' => 'api#state', 'url' => '/api/state', 'verb' => 'GET'],
		['name' => 'api#dashboard', 'url' => '/api/dashboard', 'verb' => 'GET'],
		['name' => 'api#updateSettings', 'url' => '/api/settings', 'verb' => 'PUT'],

		['name' => 'api#createCommitment', 'url' => '/api/commitments', 'verb' => 'POST'],
		['name' => 'api#updateCommitment', 'url' => '/api/commitments/{id}', 'verb' => 'PUT'],
		['name' => 'api#deleteCommitment', 'url' => '/api/commitments/{id}', 'verb' => 'DELETE'],
		['name' => 'api#reorderCommitments', 'url' => '/api/commitments-order', 'verb' => 'POST'],

		['name' => 'api#tasks', 'url' => '/api/tasks', 'verb' => 'GET'],
		['name' => 'api#createTask', 'url' => '/api/tasks', 'verb' => 'POST'],
		['name' => 'api#updateTask', 'url' => '/api/tasks/{id}', 'verb' => 'PUT'],
		['name' => 'api#deleteTask', 'url' => '/api/tasks/{id}', 'verb' => 'DELETE'],
		['name' => 'api#reorderTasks', 'url' => '/api/tasks-order', 'verb' => 'POST'],

		['name' => 'api#createSubtask', 'url' => '/api/tasks/{taskId}/subtasks', 'verb' => 'POST'],
		['name' => 'api#reorderSubtasks', 'url' => '/api/tasks/{taskId}/subtasks-order', 'verb' => 'POST'],
		['name' => 'api#updateSubtask', 'url' => '/api/subtasks/{id}', 'verb' => 'PUT'],
		['name' => 'api#deleteSubtask', 'url' => '/api/subtasks/{id}', 'verb' => 'DELETE'],

		['name' => 'api#notes', 'url' => '/api/notes', 'verb' => 'GET'],
		['name' => 'api#createNote', 'url' => '/api/notes', 'verb' => 'POST'],
		['name' => 'api#updateNote', 'url' => '/api/notes/{id}', 'verb' => 'PUT'],
		['name' => 'api#deleteNote', 'url' => '/api/notes/{id}', 'verb' => 'DELETE'],
		['name' => 'api#reorderNotes', 'url' => '/api/notes-order', 'verb' => 'POST'],

		['name' => 'api#blocks', 'url' => '/api/blocks', 'verb' => 'GET'],
		['name' => 'api#done', 'url' => '/api/done', 'verb' => 'GET'],

		['name' => 'api#sessions', 'url' => '/api/sessions', 'verb' => 'GET'],
		['name' => 'api#startSession', 'url' => '/api/sessions/start', 'verb' => 'POST'],
		['name' => 'api#stopSession', 'url' => '/api/sessions/stop', 'verb' => 'POST'],
		['name' => 'api#deleteSession', 'url' => '/api/sessions/{id}', 'verb' => 'DELETE'],

		// Sync for local-first apps (see Sync\SyncService)
		['name' => 'api#syncPull', 'url' => '/api/sync', 'verb' => 'GET'],
		['name' => 'api#syncPush', 'url' => '/api/sync', 'verb' => 'POST'],
	],
];
