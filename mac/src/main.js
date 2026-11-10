'use strict'
/**
 * Blockwise for Mac: Blockwise's interface in a Mac window, a menu bar item with the
 * running timer and quick actions, and Apple Calendar for the calendar.
 */
const {
	app, BrowserWindow, Tray, Menu, nativeImage, Notification,
	ipcMain, safeStorage, session, shell, net, screen, powerMonitor, dialog,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { execFile } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const nc = require('./nextcloud')
const { checkAlerts, trayTitle } = require('./alerts')
const i18n = require('../renderer/i18n.js')

// Both in memory only: no Nextcloud cookies are ever written to disk
const LOGIN_PARTITION = 'tracker-login' // the Nextcloud login page
const API_PARTITION = 'tracker-api' // requests with the app password
const RENDERER_URL = pathToFileURL(path.join(__dirname, '..', 'renderer') + path.sep).href
const API_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE'])
const POPOVER_WIDTH = 360
const PAGES = ['now', 'tasks', 'done', 'time', 'settings']

let t = (s) => s
let config = null // { server, loginName, appPassword (encrypted, base64), encrypted, notifications }
let client = null
let tray = null
let popover = null
let popoverHiddenAt = 0
let mainWin = null
let setupWin = null
let loginWin = null
let loginFlow = null
let loginOrigin = null
let dash = null // last /api/dashboard, plus weekTracked
let dashError = null
let refreshTimer = null
const seenAlerts = new Set()

app.setName('Blockwise')
// The folder of earlier versions (called Tracker): settings stay where they were.
// The Keychain entry is per name, so after the rename you log in once more.
app.setPath('userData', path.join(app.getPath('appData'), 'Tracker'))
if (!app.requestSingleInstanceLock()) {
	app.quit()
} else {
	app.on('second-instance', () => (client ? showMain() : showSetup()))
}

// --- config ---------------------------------------------------------------------------

const configPath = () => path.join(app.getPath('userData'), 'config.json')

function loadConfig() {
	try {
		const c = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
		return c.server && c.loginName && c.appPassword ? c : null
	} catch (e) {
		return null
	}
}

function saveConfig(c) {
	fs.mkdirSync(path.dirname(configPath()), { recursive: true })
	fs.writeFileSync(configPath(), JSON.stringify(c, null, '\t'), { mode: 0o600 })
}

/**
 * The app password is encrypted with a key kept in the macOS Keychain (safeStorage).
 * It is never written to disk unencrypted: without the Keychain it stays in memory
 * for this run only (and is revoked on quit).
 */
async function sealPassword(pw) {
	try {
		if (await safeStorage.isAsyncEncryptionAvailable()) {
			return { appPassword: (await safeStorage.encryptStringAsync(pw)).toString('base64'), encrypted: true, format: 'async' }
		}
	} catch (e) {
		// Keychain refused (access denied, item deleted while running…): don't store anything
	}
	return null
}

let memoryPassword = null // only when the Keychain is unavailable

async function openPassword(c) {
	if (memoryPassword) return memoryPassword
	const buf = Buffer.from(c.appPassword, 'base64')
	if (!c.encrypted) {
		// Stored unencrypted by an early version: encrypt it now, or forget it
		const pw = buf.toString('utf8')
		const sealed = await sealPassword(pw)
		if (!sealed) throw new Error('No Keychain')
		Object.assign(c, sealed)
		saveConfig(c)
		return pw
	}
	if (c.format !== 'async' && typeof safeStorage.decryptString === 'function') {
		// Stored by the first version of the app: read it once, store it the new way
		const pw = safeStorage.decryptString(buf)
		const sealed = await sealPassword(pw)
		if (sealed) { Object.assign(c, sealed); saveConfig(c) }
		return pw
	}
	const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(buf)
	if (shouldReEncrypt) {
		const sealed = await sealPassword(result)
		if (sealed) { Object.assign(c, sealed); saveConfig(c) }
	}
	return result
}

// --- connection --------------------------------------------------------------------------

/** fetch without the default session, so cookies Nextcloud sets stay in memory */
const apiFetch = (u, o) => session.fromPartition(API_PARTITION).fetch(u, o)

async function connect() {
	client = nc.createClient({ server: config.server, loginName: config.loginName, appPassword: await openPassword(config), fetch: apiFetch })
}

async function disconnect({ revoke }) {
	clearInterval(refreshTimer)
	if (revoke && client) await client.revoke()
	client = null
	config = null
	memoryPassword = null
	dash = null
	try { fs.unlinkSync(configPath()) } catch (e) { /* already gone */ }
	await session.fromPartition(LOGIN_PARTITION).clearStorageData()
	await session.fromPartition(API_PARTITION).clearStorageData()
	if (mainWin) mainWin.destroy()
	if (popover) popover.destroy()
	popover = null
	if (tray) tray.destroy()
	tray = null
	showSetup()
}

// --- data ------------------------------------------------------------------------------------

function weekBounds() {
	const d = new Date()
	d.setHours(0, 0, 0, 0)
	d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
	const start = Math.floor(d / 1000)
	d.setDate(d.getDate() + 7)
	return [start, Math.floor(d / 1000)]
}

async function refresh() {
	if (!client) return
	try {
		const [from, to] = weekBounds()
		const [d, sessions] = await Promise.all([client.api('GET', 'dashboard'), client.api('GET', `sessions?from=${from}&to=${to}`)])
		const now = Math.floor(Date.now() / 1000)
		d.weekTracked = {}
		for (const s of sessions) {
			const sec = Math.max(0, Math.min(s.end ?? now, to) - Math.max(s.start, from))
			d.weekTracked[s.commitmentId] = (d.weekTracked[s.commitmentId] || 0) + sec
		}
		dash = d
		dashError = null
	} catch (e) {
		dashError = e.message
		if (e.status === 401) {
			notify(t('Log in again'), t('Nextcloud rejected the app password. Log in again.'))
			disconnect({ revoke: false })
			return
		}
	}
	broadcast()
	scheduleRefresh()
}

function scheduleRefresh() {
	clearTimeout(refreshTimer)
	// More often while tracking, so changes made in the browser show up soon
	refreshTimer = setTimeout(refresh, dash && dash.running ? 15000 : 45000)
}

function publicState() {
	return {
		dash,
		error: dashError,
		now: Math.floor(Date.now() / 1000),
		server: config && config.server,
		host: config && new URL(config.server).host,
		loginName: config && config.loginName,
		locale: app.getLocale(),
		notifications: !config || config.notifications !== false,
		openAtLogin: app.getLoginItemSettings().openAtLogin,
	}
}

function broadcast() {
	const s = publicState()
	for (const w of [popover, mainWin]) {
		if (w && !w.isDestroyed()) w.webContents.send('state', s)
	}
}

// --- notifications, menu bar text, Pomodoro ------------------------------------------------

function notify(title, body) {
	if (config && config.notifications === false) return
	if (!Notification.isSupported()) return
	const n = new Notification({ title, body, silent: false })
	n.on('click', () => showMain('now'))
	n.show()
}

async function tick() {
	const now = Math.floor(Date.now() / 1000)
	if (tray) tray.setTitle(trayTitle(dash, now), { fontType: 'monospacedDigit' })
	if (!dash || !client) return
	const a = checkAlerts(dash, now, seenAlerts, t)
	a.notifications.forEach((n) => notify(n.title, n.body))
	if (a.stopAt) {
		// Pomodoro long break: stop exactly at its start (the web page may do the same; that's harmless)
		try { await client.api('POST', 'sessions/stop', { at: a.stopAt, longBreak: true }) } catch (e) { /* retried on next refresh */ }
		refresh()
		notifyChanged()
	} else if (a.clearLongBreak) {
		refresh()
	}
}

// --- menu bar -----------------------------------------------------------------------------------

function createTray() {
	const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'trayTemplate.png'))
	icon.setTemplateImage(true)
	tray = new Tray(icon)
	tray.setToolTip('Blockwise')
	tray.on('click', togglePopover)
	tray.on('right-click', () => tray.popUpContextMenu(contextMenu()))
}

function contextMenu() {
	return Menu.buildFromTemplate([
		{ label: t('Open Blockwise'), click: () => showMain('now') },
		{ label: t('Open Calendar'), click: () => openCalendar() },
		{ type: 'separator' },
		{ label: t('Open at login'), type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
		{ label: t('Desktop notifications'), type: 'checkbox', checked: config.notifications !== false, click: (i) => { config.notifications = i.checked; saveConfig(config); broadcast() } },
		{ type: 'separator' },
		{ label: t('Logged in as {user} on {host}', { user: config.loginName, host: new URL(config.server).host }), enabled: false },
		{ label: t('Log out'), click: confirmLogout },
		{ label: t('Quit Blockwise'), role: 'quit' },
	])
}

async function confirmLogout() {
	const host = new URL(config.server).host
	const { response } = await dialog.showMessageBox({
		type: 'question',
		buttons: [t('Log out'), t('Cancel')],
		defaultId: 1,
		message: t('Log out of {host}? The app password is removed from Nextcloud.', { host }),
	})
	if (response === 0) disconnect({ revoke: true })
}

function createPopover() {
	popover = new BrowserWindow({
		width: POPOVER_WIDTH,
		height: 480,
		show: false,
		frame: false,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		roundedCorners: true,
		vibrancy: 'popover',
		visualEffectState: 'active',
		backgroundColor: '#00000000',
		webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
	})
	popover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
	popover.loadFile(path.join(__dirname, '..', 'renderer', 'popover.html'))
	popover.on('blur', () => {
		if (popover.webContents.isDevToolsOpened()) return
		popover.hide()
		popoverHiddenAt = Date.now()
	})
}

function togglePopover() {
	if (!popover || popover.isDestroyed()) createPopover()
	if (popover.isVisible()) { popover.hide(); return }
	// Clicking the icon while open first blurs (hides) the popover: don't reopen it
	if (Date.now() - popoverHiddenAt < 250) return
	positionPopover()
	popover.show()
	popover.focus()
	refresh()
}

function positionPopover() {
	const b = tray.getBounds()
	const area = screen.getDisplayMatching(b).workArea
	const [w, h] = popover.getSize()
	const x = Math.min(Math.max(area.x + 8, Math.round(b.x + b.width / 2 - w / 2)), area.x + area.width - w - 8)
	const y = b.y < area.y + area.height / 2 ? Math.round(b.y + b.height + 6) : Math.round(b.y - h - 6)
	popover.setPosition(x, y, false)
}

// --- main window: Blockwise's interface ---------------------------------------------------

/** @param {string|null} page now|tasks|done|time|settings, or "calendar" for Apple Calendar */
function showMain(page = null) {
	if (!client) return showSetup()
	if (page === 'calendar') return openCalendar()
	const hash = PAGES.includes(page) ? `#${page}` : ''
	if (!mainWin || mainWin.isDestroyed()) {
		createMain(hash)
	} else if (hash) {
		mainWin.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {}) // hash is from PAGES
	}
	if (process.platform === 'darwin' && app.dock) app.dock.show()
	mainWin.show()
	mainWin.focus()
	if (popover && popover.isVisible()) popover.hide()
}

function createMain(hash) {
	mainWin = new BrowserWindow({
		width: 1240,
		height: 820,
		// Small enough to sit next to other windows; the layout adapts
		minWidth: 420,
		minHeight: 360,
		title: 'Blockwise',
		titleBarStyle: 'hiddenInset',
		trafficLightPosition: { x: 18, y: 18 },
		vibrancy: 'sidebar',
		visualEffectState: 'followWindow',
		backgroundColor: '#00000000',
		show: false,
		webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
	})
	mainWin.loadFile(path.join(__dirname, '..', 'renderer', 'app.html'), { hash: (hash || '#now').slice(1) })
	mainWin.once('ready-to-show', () => mainWin.show())
	mainWin.on('closed', () => {
		mainWin = null
		// Back to a pure menu bar app
		if (process.platform === 'darwin' && app.dock) app.dock.hide()
	})
}

/** Tell the window to reload its data (something changed in the menu bar or by Pomodoro). */
function notifyChanged(except) {
	if (mainWin && !mainWin.isDestroyed() && mainWin.webContents !== except) mainWin.webContents.send('changed')
}

// --- Apple Calendar ----------------------------------------------------------------------

/** Opens Apple Calendar, on the day of `ts` (unix seconds) if given. */
function openCalendar(ts) {
	const fallback = () => shell.openPath('/System/Applications/Calendar.app').then((err) => { if (err) shell.openExternal('ical://') })
	if (process.platform !== 'darwin' || !Number.isFinite(ts)) return fallback()
	const day = (x) => { const d = new Date(x); d.setHours(12, 0, 0, 0); return d }
	// A whole number of days (at most ~10 years away) is all that goes into the script
	const offset = Math.max(-4000, Math.min(4000, Math.round((day(ts * 1000) - day(Date.now())) / 86400000)))
	if (!Number.isInteger(offset)) return fallback()
	// Relative to today, so it works with any date format the Mac uses
	const script = [
		'tell application "Calendar"',
		'activate',
		'switch view to day view',
		`view calendar at ((current date) + (${offset} * days))`,
		'end tell',
	].join('\n')
	execFile('osascript', ['-e', script], (err) => { if (err) fallback() })
}

// --- first run: log in -----------------------------------------------------------------------

function showSetup() {
	if (setupWin && !setupWin.isDestroyed()) { setupWin.show(); setupWin.focus(); return }
	if (process.platform === 'darwin' && app.dock) app.dock.show()
	setupWin = new BrowserWindow({
		width: 480,
		height: 560,
		resizable: false,
		title: 'Blockwise',
		titleBarStyle: 'hiddenInset',
		webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
	})
	setupWin.loadFile(path.join(__dirname, '..', 'renderer', 'setup.html'))
	setupWin.on('closed', () => { setupWin = null })
}

async function login(serverInput) {
	const server = nc.normalizeServer(serverInput)
	if (loginFlow) loginFlow.cancel()
	loginFlow = await nc.startLoginFlow(server, apiFetch)
	loginOrigin = new URL(server).origin
	loginWin = new BrowserWindow({
		width: 520,
		height: 760,
		parent: setupWin || undefined,
		title: new URL(server).host,
		// No preload: the Nextcloud page gets no access to the app
		webPreferences: { partition: LOGIN_PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
	})
	loginWin.on('closed', () => { loginWin = null; if (loginFlow) loginFlow.cancel() })
	loginWin.loadURL(loginFlow.loginUrl)
	try {
		const cred = await loginFlow.poll()
		// Use the address you entered: the one Nextcloud reports can be an internal name
		const sealed = await sealPassword(cred.appPassword)
		config = { server, loginName: cred.loginName, appPassword: sealed ? sealed.appPassword : '-', encrypted: !!sealed, format: sealed && sealed.format, notifications: true }
		if (sealed) saveConfig(config)
		else {
			memoryPassword = cred.appPassword
			dialog.showMessageBox({
				type: 'warning',
				message: t('Blockwise could not use your Keychain'),
				detail: t('You stay logged in until you quit Blockwise; the password is not saved. To fix it, quit Blockwise and open it again.'),
			})
		}
	} finally {
		loginFlow = null
		if (loginWin) loginWin.close()
		// The browser login session isn't needed any more: only the app password is
		await session.fromPartition(LOGIN_PARTITION).clearStorageData().catch(() => {})
	}
	await connect()
	startApp()
	if (setupWin) setupWin.close()
	showMain('now')
}

// --- IPC from the windows ------------------------------------------------------------------------

/** Only the app's own pages (file:// in renderer/) may talk to the main process. */
function fromApp(e) {
	const url = (e && e.senderFrame && e.senderFrame.url) || ''
	return url.startsWith(RENDERER_URL)
}

function handle(channel, fn) {
	ipcMain.handle(channel, async (e, ...args) => {
		try {
			if (!fromApp(e)) throw new Error('Not allowed.')
			return { data: await fn(...args) }
		} catch (err) {
			return { error: err.message || String(err), status: err.status }
		}
	})
}

handle('state', () => publicState())
/**
 * Blockwise API paths only, e.g. "tasks/12" or "blocks?from=1&to=2": no "..", no
 * other Nextcloud endpoints (the app password could reach your files).
 */
const API_PATH = /^[a-z][a-z-]*(\/\d+(\/[a-z][a-z-]*)?|\/(start|stop))?(\?[a-zA-Z]+=[a-zA-Z0-9_-]*(&[a-zA-Z]+=[a-zA-Z0-9_-]*)*)?$/
const isPlainBody = (b) => b === undefined || (b !== null && typeof b === 'object' && Object.getPrototypeOf(b) === Object.prototype)

ipcMain.handle('api', async (e, method, apiPath, body) => {
	try {
		if (!fromApp(e)) throw new Error('Not allowed.')
		if (!client) throw new Error('Not logged in.')
		if (!API_METHODS.has(method) || typeof apiPath !== 'string' || !API_PATH.test(apiPath) || !isPlainBody(body)) throw new Error('Invalid request.')
		const result = await client.api(method, apiPath, body)
		if (method !== 'GET') {
			refresh()
			// The window reloads its data when the change came from elsewhere (menu bar)
			notifyChanged(e.sender)
		}
		return { data: result }
	} catch (err) {
		return { error: err.message || String(err), status: err.status }
	}
})
handle('open', (page) => showMain(typeof page === 'string' ? page : null))
handle('openCalendar', (ts) => openCalendar(typeof ts === 'number' ? ts : undefined))
handle('login', (server) => login(String(server || '')))
handle('cancelLogin', () => { if (loginFlow) loginFlow.cancel(); if (loginWin) loginWin.close() })
handle('menu', () => tray && tray.popUpContextMenu(contextMenu()))
handle('refresh', () => refresh())
ipcMain.on('popover:height', (e, h) => {
	if (!fromApp(e) || !popover || popover.isDestroyed() || !Number.isFinite(h)) return
	const area = screen.getDisplayMatching(tray.getBounds()).workArea
	popover.setSize(POPOVER_WIDTH, Math.max(200, Math.min(Math.ceil(h), area.height - 40)))
	if (popover.isVisible()) positionPopover()
})

// --- start ------------------------------------------------------------------------------------------

function startApp() {
	if (!tray) createTray()
	refresh()
}

// --- hardening for every window -------------------------------------------------------------

/** Only web links ever leave the app (never file:, custom schemes or apps). */
function openLink(url) {
	try {
		const u = new URL(url)
		if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.href)
	} catch (e) { /* not a URL */ }
}

app.on('web-contents-created', (_e, contents) => {
	// No new windows: web links open in the browser
	contents.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' } })
	contents.on('will-attach-webview', (e) => e.preventDefault())
	contents.on('will-navigate', (e, url) => {
		const isLogin = loginWin && !loginWin.isDestroyed() && contents === loginWin.webContents
		if (isLogin) {
			// The login page may go through a sign-in provider: https only, or your
			// own server's address (plain http is allowed only for local/Tailscale ones)
			if (!/^https:\/\//i.test(url) && !(loginOrigin && url.startsWith(loginOrigin + '/'))) e.preventDefault()
			return
		}
		// The app's own pages never navigate away
		if (!url.startsWith(RENDERER_URL)) { e.preventDefault(); openLink(url) }
	})
})

function lockDownSession(ses) {
	// No camera, microphone, location, notifications etc. for web content
	ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
	ses.setPermissionCheckHandler(() => false)
}

app.on('before-quit', () => {
	// An app password that only lived in memory would otherwise stay valid on the server
	if (memoryPassword && client) client.revoke()
})

app.whenReady().then(async () => {
	for (const p of [LOGIN_PARTITION, API_PARTITION]) lockDownSession(session.fromPartition(p))
	lockDownSession(session.defaultSession)
	// Earlier versions kept Nextcloud cookies on disk (login page, API requests): remove them
	session.fromPartition('persist:tracker').clearStorageData().catch(() => {})
	session.defaultSession.clearStorageData({ storages: ['cookies'] }).catch(() => {})
	t = i18n.make(app.getLocale())
	config = loadConfig()
	if (config) {
		try {
			await connect()
		} catch (e) {
			config = null // Keychain entry unreadable: log in again
		}
	}
	if (config) {
		startApp()
		// Started at login: stay in the menu bar; started by hand: open the window
		if (!app.getLoginItemSettings().wasOpenedAtLogin) showMain('now')
		else if (app.dock) app.dock.hide()
	} else {
		showSetup()
	}
	setInterval(tick, 1000)
	powerMonitor.on('resume', () => refresh())
})

app.on('activate', () => (client ? showMain() : showSetup()))
// Keep running in the menu bar when windows are closed
app.on('window-all-closed', () => {})
