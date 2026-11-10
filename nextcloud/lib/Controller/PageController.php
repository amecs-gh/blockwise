<?php

declare(strict_types=1);

namespace OCA\Tracker\Controller;

use OCA\Tracker\AppInfo\Application;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IRequest;
use OCP\Util;

class PageController extends Controller {
	public function __construct(IRequest $request) {
		parent::__construct(Application::APP_ID, $request);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function index(): TemplateResponse {
		Util::addStyle(Application::APP_ID, 'tracker');
		// Markdown for notes, before the app that uses it
		Util::addScript(Application::APP_ID, 'markdown');
		Util::addScript(Application::APP_ID, 'tracker');
		Util::addTranslations(Application::APP_ID);
		return new TemplateResponse(Application::APP_ID, 'main');
	}
}
