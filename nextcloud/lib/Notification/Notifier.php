<?php

declare(strict_types=1);

namespace OCA\Tracker\Notification;

use OCA\Tracker\AppInfo\Application;
use OCP\IDateTimeFormatter;
use OCP\IURLGenerator;
use OCP\L10N\IFactory;
use OCP\Notification\INotification;
use OCP\Notification\INotifier;
use OCP\Notification\UnknownNotificationException;

class Notifier implements INotifier {
	public function __construct(
		private IFactory $l10nFactory,
		private IURLGenerator $url,
		private IDateTimeFormatter $formatter,
	) {
	}

	public function getID(): string {
		return Application::APP_ID;
	}

	public function getName(): string {
		return $this->l10nFactory->get(Application::APP_ID)->t('Blockwise');
	}

	public function prepare(INotification $notification, string $languageCode): INotification {
		if ($notification->getApp() !== Application::APP_ID) {
			throw new UnknownNotificationException();
		}
		$l = $this->l10nFactory->get(Application::APP_ID, $languageCode);
		$p = $notification->getSubjectParameters();
		$link = $this->url->linkToRouteAbsolute('tracker.page.index');

		switch ($notification->getSubject()) {
			case 'overlap':
				$notification->setParsedSubject($l->t('Overlapping blocks: %1$s and %2$s', [$p['a'] ?? '', $p['b'] ?? '']))
					->setParsedMessage($l->t('Blocks of different commitments overlap on %s. Open Blockwise to see them.', [$this->formatter->formatDateTime((int)($p['start'] ?? 0), 'medium', 'short', null, $l)]));
				break;
			case 'block_ending':
				$notification->setParsedSubject($l->n(
					'%2$s: block ends in %1$s minute',
					'%2$s: block ends in %1$s minutes',
					(int)($p['minutes'] ?? 0),
					[(int)($p['minutes'] ?? 0), $p['commitment'] ?? '']
				))->setParsedMessage($l->t('Unchecked subtasks will move to the next block.'));
				break;
			case 'long_break':
				$notification->setParsedSubject($l->t('Time for a long break'))
					->setParsedMessage($l->n('Tracking stopped. Back to work in %n minute.', 'Tracking stopped. Back to work in %n minutes.', (int)($p['minutes'] ?? 0)));
				break;
			case 'back_to_work':
				$notification->setParsedSubject($l->t('Break is over'))
					->setParsedMessage($l->t('Press play to start the next focus session.'));
				break;
			default:
				throw new UnknownNotificationException();
		}

		$notification->setLink($link)
			->setIcon($this->url->getAbsoluteURL($this->url->imagePath(Application::APP_ID, 'app-dark.svg')));
		return $notification;
	}
}
