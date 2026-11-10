// A stand-in for the `electron` module, so src/main.js runs in plain Node for tests.
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const EventEmitter = require('node:events')

const log = []
const record = (...a) => log.push(a.join(' '))
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-mac-'))
const handlers = {}
const listeners = {}
const sent = []

class WebContents extends EventEmitter {
	constructor(owner) { super(); this.owner = owner; this.url = ''; this.history = []; this.navigationHistory = { canGoBack: () => this.history.length > 1, goBack: () => { this.history.pop(); record('goBack') } } }
	send(channel, payload) { sent.push({ win: this.owner.name, channel, payload }) }
	getURL() { return this.url }
	loadURL(u) { this.url = u; this.history.push(u); record('loadURL', this.owner.name, u); setImmediate(() => { this.emit('did-navigate'); this.emit('did-finish-load') }) }
	isLoading() { return false }
	isDevToolsOpened() { return false }
	executeJavaScript() { return Promise.resolve() }
	setWindowOpenHandler(fn) { this.openHandler = fn }
	reload() { record('reload') }
}
let winCount = 0
class BrowserWindow extends EventEmitter {
	constructor(opts = {}) {
		super(); this.opts = opts; this.name = `win${++winCount}`; this.destroyed = false; this.visible = false
		this.size = [opts.width || 800, opts.height || 600]
		this.webContents = new WebContents(this)
		setImmediate(() => app.emit('web-contents-created', {}, this.webContents))
		this.contentView = { children: [], addChildView: (v) => this.contentView.children.push(v) }
		BrowserWindow.all.push(this)
	}
	loadFile(f) { this.file = path.basename(f); record('loadFile', this.name, this.file); setImmediate(() => { this.emit('ready-to-show'); this.webContents.emit('did-finish-load') }) }
	loadURL(u) { return this.webContents.loadURL(u) }
	show() { this.visible = true } hide() { this.visible = false } focus() {}
	isVisible() { return this.visible } isDestroyed() { return this.destroyed }
	destroy() { this.destroyed = true; this.emit('closed') } close() { this.destroy() }
	getContentSize() { return this.size } getSize() { return this.size } setSize(w, h) { this.size = [w, h]; record('setSize', this.name, w, h) }
	setPosition(x, y) { this.pos = [x, y] } setTitle(t) { this.title = t } setVisibleOnAllWorkspaces() {}
}
BrowserWindow.all = []
class WebContentsView { constructor(opts) { this.opts = opts; this.name = 'view'; this.webContents = new WebContents(this) } setBounds(b) { this.bounds = b } }
class Tray extends EventEmitter { constructor() { super(); Tray.last = this; this.title = '' } setTitle(t) { this.title = t } setToolTip() {} getBounds() { return { x: 1000, y: 0, width: 24, height: 24 } } popUpContextMenu(m) { record('contextMenu', m.items.map((i) => i.label || '-').join('|')) } destroy() { record('tray destroyed') } }
class Notification extends EventEmitter { constructor(o) { super(); this.o = o } show() { record('NOTIFY', this.o.title, '|', this.o.body) } static isSupported() { return true } }

let readyResolve
const ready = new Promise((r) => { readyResolve = r })
const app = new EventEmitter()
Object.assign(app, {
	setName() {}, getName: () => 'Tracker', requestSingleInstanceLock: () => true, quit: () => record('quit'),
	getPath: () => userData, setPath: (name, p) => record('setPath', name, require('node:path').basename(p)), getLocale: () => process.env.TEST_LOCALE || 'en-US', whenReady: () => ready,
	loginItems: { openAtLogin: false, wasOpenedAtLogin: false },
	getLoginItemSettings() { return this.loginItems }, setLoginItemSettings(s) { Object.assign(this.loginItems, s) },
	dock: { show: () => record('dock show'), hide: () => record('dock hide') },
})

const sessions = {}
const session = {
	fromPartition(p) {
		return (sessions[p] ||= {
			ua: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/142.0 Electron/39.0.0 Safari/537.36',
			webRequest: { onBeforeSendHeaders(filter, fn) { sessions[p].headerHook = fn } },
			setPermissionRequestHandler(fn) { sessions[p].permReq = fn }, setPermissionCheckHandler(fn) { sessions[p].permCheck = fn },
			getUserAgent() { return this.ua }, setUserAgent(u) { this.ua = u }, clearStorageData: async () => record('clearStorageData', p),
			fetch: (u, o) => { record('fetch', p, String(u).replace(/\?.*/, '')); return fetch(u, o) },
		})
	},
}
Object.defineProperty(session, 'defaultSession', { get: () => session.fromPartition('(default)') })

module.exports = {
	app, BrowserWindow, WebContentsView, Tray, Notification, session,
	Menu: { buildFromTemplate: (items) => ({ items }), setApplicationMenu: (m) => { module.exports.__test.appMenu = m } },
	nativeImage: { createFromPath: (p) => ({ path: p, setTemplateImage() {} }) },
	ipcMain: { handle: (c, fn) => { handlers[c] = fn }, on: (c, fn) => { listeners[c] = fn } },
	// Electron 45: only the async API (the sync one is deprecated)
	safeStorage: {
		isAsyncEncryptionAvailable: async () => true,
		encryptStringAsync: async (s) => { if (process.env.TEST_KEYCHAIN_FAIL) throw new Error('Error while encrypting the text provided to safeStorage.encryptStringAsync.'); return Buffer.from('enc:' + [...s].reverse().join('')) },
		decryptStringAsync: async (b) => ({ result: [...b.toString().slice(4)].reverse().join(''), shouldReEncrypt: false }),
	},
	shell: { openExternal: (u) => record('openExternal', u), openPath: async (p) => { record('openPath', p); return '' } },
	net: { fetch: (u, o) => fetch(u, o) },
	screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 25, width: 1440, height: 875 } }) },
	powerMonitor: { on() {} },
	dialog: { response: 0, showMessageBox: async (o) => { record('dialog', o.message); return { response: module.exports.dialog.response } } },
	// test helpers
	__test: { log, handlers, listeners, sent, sessions, userData, ready: () => readyResolve(), BrowserWindow, Tray },
}
