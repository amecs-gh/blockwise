<?php

declare(strict_types=1);

namespace OCA\Tracker\AppInfo;

use OCA\DAV\Events\CalendarDeletedEvent;
use OCA\DAV\Events\CalendarMovedToTrashEvent;
use OCA\DAV\Events\CalendarUpdatedEvent;
use OCA\Tracker\Listener\CalendarChangeListener;
use OCA\Tracker\Listener\CalendarObjectListener;
use OCA\Tracker\Listener\UserDeletedListener;
use OCA\Tracker\Notification\Notifier;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\User\Events\UserDeletedEvent;
use OCP\Calendar\Events\CalendarObjectCreatedEvent;
use OCP\Calendar\Events\CalendarObjectUpdatedEvent;

class Application extends App implements IBootstrap {
	public const APP_ID = 'tracker';

	public function __construct(array $urlParams = []) {
		parent::__construct(self::APP_ID, $urlParams);
	}

	public function register(IRegistrationContext $context): void {
		// New or moved events in a commitment calendar: check for overlaps
		$context->registerEventListener(CalendarObjectCreatedEvent::class, CalendarObjectListener::class);
		$context->registerEventListener(CalendarObjectUpdatedEvent::class, CalendarObjectListener::class);
		// Calendar renamed/recolored/deleted in the Calendar app: sync back
		$context->registerEventListener(CalendarUpdatedEvent::class, CalendarChangeListener::class);
		$context->registerEventListener(CalendarDeletedEvent::class, CalendarChangeListener::class);
		$context->registerEventListener(CalendarMovedToTrashEvent::class, CalendarChangeListener::class);

		// Account deleted: remove its Tracker data
		$context->registerEventListener(UserDeletedEvent::class, UserDeletedListener::class);

		$context->registerNotifierService(Notifier::class);
	}

	public function boot(IBootContext $context): void {
	}
}
