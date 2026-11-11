'use strict'
/**
 * Blockwise for Mac: Blockwise's interface in a Mac window, a menu bar item with the
 * running timer and quick actions, notifications.
 *
 * Local-first: Blockwise runs here (the engine, nextcloud/js/engine.js, in this
 * process), keeps your data encrypted on this Mac and syncs it, when it can, with
 * Nextcloud, Dropbox or Google Drive (end-to-end encrypted there), or not at all.
 * Blocks come from Nextcloud's calendars, or from Apple Calendar.
 */
const {
	app, BrowserWindow, Tray, Menu, nativeImage, Notification,
	ipcMain, safeStorage, session, shell, net, screen, powerMonitor, dialog, nativeTheme,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { execFile } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const nc = require('./nextcloud')
const { createEngine } = require('../renderer/web/engine.js')
const FileSync = require('../renderer/web/filesync.js')
const drives = require('./drives')
const cal = require('./calendar')
const { createVault } = require('./vault')
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
/**
 * { provider: nextcloud | dropbox | gdrive | local, notifications,
 *   nextcloud: server, loginName, appPassword (encrypted), encrypted, format,
 *   drives: driveToken (encrypted refresh token), driveAccount, syncKey (encrypted) }
 */
let config = null
let client = null // Nextcloud
let engine = null // Blockwise on this Mac
let remote = null // where it syncs (null: this Mac only)
let driveStoreNow = null // the drive, to revoke the token when you disconnect
let vault = null
let syncTimer = null
let syncError = null
let refreshSoonTimer = null
let pendingDrive = null // a drive being connected (setup)
const PROVIDER_NAMES = { nextcloud: 'Nextcloud', dropbox: 'Dropbox', gdrive: 'Google Drive', local: 'This Mac' }
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
	app.on('second-instance', () => (engine ? showMain() : showSetup()))
}

// --- config ---------------------------------------------------------------------------

const configPath = () => path.join(app.getPath('userData'), 'config.json')

function loadConfig() {
	try {
		const c = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
		if (!c.provider && c.server) c.provider = 'nextcloud' // earlier versions
		if (c.provider === 'nextcloud') return c.server && c.loginName && c.appPassword ? c : null
		if (c.provider === 'dropbox' || c.provider === 'gdrive') return c.driveToken && c.syncKey ? c : null
		return c.provider === 'local' ? c : null
	} catch (e) {
		return null
	}
}

/** Whose data is on this Mac: another account starts empty (from "this Mac only" it moves along) */
const ownerPath = () => path.join(app.getPath('userData'), 'owner')
const readOwner = () => { try { return fs.readFileSync(ownerPath(), 'utf8') } catch (e) { return null } }
const writeOwner = (o) => fs.writeFileSync(ownerPath(), o, { mode: 0o600 })

/** App keys for Dropbox and Google (not secret: PKCE protects the login), from the build */
let providerKeys = {}
// App keys for Dropbox and Google: built in (config/providers.json) or pasted
// once on the first-run screen (kept in your Blockwise folder). Not secrets: the
// logins use PKCE; they only say which registered app is asking.
const KEY_FORMAT = {
	dropboxAppKey: /^[a-z0-9]{8,32}$/,
	googleClientId: /^[0-9]{6,30}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/,
	googleClientSecret: /^[A-Za-z0-9_-]{10,80}$/,
}
const userKeysFile = () => path.join(app.getPath('userData'), 'providers.json')
function readKeys(file) {
	try {
		const k = JSON.parse(fs.readFileSync(file, 'utf8'))
		const out = {}
		for (const [name, re] of Object.entries(KEY_FORMAT)) if (typeof k[name] === 'string' && re.test(k[name])) out[name] = k[name]
		return out
	} catch (e) {
		return {}
	}
}
function loadProviderKeys() {
	const built = readKeys(path.join(__dirname, '..', 'config', 'providers.json'))
	const own = readKeys(userKeysFile())
	const google = built.googleClientId ? built : own
	providerKeys = {
		dropboxAppKey: built.dropboxAppKey || own.dropboxAppKey || '',
		googleClientId: google.googleClientId || '',
		googleClientSecret: google.googleClientSecret || '',
	}
}
/** Keys pasted on the first-run screen; checked against the providers' formats */
function saveProviderKeys(provider, keys) {
	const k = keys && typeof keys === 'object' ? keys : {}
	const own = readKeys(userKeysFile())
	if (provider === 'dropbox') {
		const v = String(k.dropboxAppKey || '').trim()
		if (!KEY_FORMAT.dropboxAppKey.test(v)) throw new Error('That is not a Dropbox app key (letters and digits, from the app\'s Settings page).')
		own.dropboxAppKey = v
	} else if (provider === 'gdrive') {
		const id = String(k.googleClientId || '').trim()
		const secret = String(k.googleClientSecret || '').trim()
		if (!KEY_FORMAT.googleClientId.test(id)) throw new Error('That is not a Google client ID (it ends in .apps.googleusercontent.com).')
		if (!KEY_FORMAT.googleClientSecret.test(secret)) throw new Error('That is not a Google client secret.')
		own.googleClientId = id
		own.googleClientSecret = secret
	} else {
		throw new Error('Invalid request.')
	}
	fs.mkdirSync(app.getPath('userData'), { recursive: true })
	fs.writeFileSync(userKeysFile(), JSON.stringify(own, null, 1), { mode: 0o600 })
	loadProviderKeys()
}
const providersReady = () => ({ dropbox: !!providerKeys.dropboxAppKey, gdrive: !!(providerKeys.googleClientId && providerKeys.googleClientSecret) })

const appearancePath = () => path.join(app.getPath('userData'), 'appearance')
function setAppearance(mode) {
	if (!['system', 'light', 'dark'].includes(mode)) throw new Error('Invalid request.')
	nativeTheme.themeSource = mode
	fs.mkdirSync(app.getPath('userData'), { recursive: true })
	fs.writeFileSync(appearancePath(), mode, { mode: 0o600 })
	return mode
}
function loadAppearance() {
	try {
		const mode = fs.readFileSync(appearancePath(), 'utf8').trim()
		if (['system', 'light', 'dark'].includes(mode)) nativeTheme.themeSource = mode
	} catch (e) { /* not chosen yet: like macOS */ }
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

function driveStore(provider, refreshToken) {
	return provider === 'dropbox'
		? drives.dropboxStore({ appKey: providerKeys.dropboxAppKey, refreshToken, fetch: apiFetch })
		: drives.googleStore({ clientId: providerKeys.googleClientId, clientSecret: providerKeys.googleClientSecret, refreshToken, fetch: apiFetch })
}

/** The Apple Calendar helper inside the app (mac/helper) */
function helperPath() {
	const p = app.isPackaged ? path.join(process.resourcesPath, 'blockwise-calendar') : path.join(__dirname, '..', 'helper', 'build', 'blockwise-calendar')
	return fs.existsSync(p) ? p : null
}

/** @param {{fresh?: boolean}} o fresh: a new login, so data the Keychain can't open is set aside (never on start) */
async function connect({ fresh = false } = {}) {
	vault = createVault({ safeStorage, dir: app.getPath('userData') })
	client = config.provider === 'nextcloud'
		? nc.createClient({ server: config.server, loginName: config.loginName, appPassword: await openPassword(config), fetch: apiFetch })
		: null
	const helper = helperPath()
	// Without Nextcloud: Blockwise's built-in calendar, or Apple Calendar when you chose it (Settings → Calendar)
	const calendar = client ? cal.nextcloudCalendar({ api: client.api }) : helper && calendarMode() === 'apple' ? cal.appleCalendar({ helperPath: helper }) : { kind: 'builtin' }

	let inner = null
	if (client) inner = { pull: (since, limit) => client.api('GET', `sync?since=${since}&limit=${limit}`), push: (records) => client.api('POST', 'sync', { records }) }
	const lazy = { pull: (since, limit) => inner.pull(since, limit), push: (records) => inner.push(records) }
	// Nextcloud has real calendars: built-in blocks stay on this Mac (until you switch to a drive)
	if (client) lazy.localTypes = ['block']
	// A Keychain that can't open the data throws here: nothing is started empty over it.
	// Only right after you log in again: the old file is set aside and your data comes again from the sync.
	let stored
	try {
		stored = await vault.read('data')
	} catch (e) {
		if (!fresh) throw e
		vault.setAside('data')
		vault.setAside('drivestate')
		stored = null
		unreadableData = true
	}
	engine = await createEngine({
		storage: { load: async () => (stored ? JSON.parse(stored) : null), save: (db) => vault.write('data', JSON.stringify(db)) },
		remote: config.provider === 'local' ? null : lazy,
		calendar,
		onChange: (db, info) => {
			if (!(info && info.sync)) syncSoon(2500)
			refreshSoon()
		},
	})
	if (config.provider === 'dropbox' || config.provider === 'gdrive') {
		const refreshToken = await vault.unseal(config.driveToken)
		const key = Buffer.from(await vault.unseal(config.syncKey), 'base64')
		driveStoreNow = driveStore(config.provider, refreshToken)
		inner = await FileSync.createRemote({
			store: driveStoreNow,
			key: new Uint8Array(key),
			node: engine.node(),
			state: { load: async () => JSON.parse((await vault.read('drivestate')) || 'null'), save: (st) => vault.write('drivestate', JSON.stringify(st)) },
		})
	}
	remote = config.provider === 'local' ? null : lazy
}

/** After switching from the menu bar: tell what happened */
const changedToast = (r) => { if (r && r.changed && r.message && Notification.isSupported()) new Notification({ title: 'Blockwise', body: r.message, silent: true }).show() }

/** 'builtin' (default) or 'apple'; older versions saved a yes/no */
const calendarMode = () => (config && (config.calendar === 'apple' || (config.calendar === undefined && config.appleCalendar)) ? 'apple' : 'builtin')

const DAY = 86400
/** "apple:<event id>": a built-in block copied to (or from) Apple Calendar */
const baseUid = (uid) => String(uid).replace(/#\d+$/, '')

/**
 * Switch where blocks live (Settings → Calendar). To Apple Calendar: each
 * commitment gets a calendar (or keeps its own) and the built-in blocks are
 * copied there, repeats included. Back to built in: the events of the
 * commitments' calendars (3 months back to a year ahead) are copied in. The
 * built-in blocks are not deleted (your other Macs may use them).
 * @return {{changed: boolean, message?: string}}
 */
async function setCalendarMode(mode) {
	if (!engine || config.provider === 'nextcloud' || (mode !== 'apple' && mode !== 'builtin') || mode === calendarMode()) return { changed: false }
	const helper = helperPath()
	if (mode === 'apple' && !helper) {
		await dialog.showMessageBox({ type: 'info', buttons: [t('OK')], message: t('Apple Calendar is not part of this build.'), detail: t('Build the app with Xcode\'s command line tools installed (npm run build).') })
		return { changed: false }
	}
	const apple = helper ? cal.appleCalendar({ helperPath: helper }) : null
	const snap = engine.snapshot()
	const byUuid = new Map(snap.commitments.map((c) => [c.uuid, c]))
	if (mode === 'apple') {
		const blocks = engine.builtinBlocks()
		const { response } = await dialog.showMessageBox({
			type: 'question',
			buttons: [t('Continue'), t('Cancel')],
			defaultId: 0,
			cancelId: 1,
			message: t('Use Apple Calendar for your blocks?'),
			detail: t('Blockwise reads the events in the calendars of your commitments: they are your planned blocks. It adds the blocks you plan, and a calendar for each commitment. Calendar data stays on your Mac.\n\nYour {n} built-in blocks are copied to Apple Calendar. macOS only offers full access to calendars, so it asks you next.', { n: blocks.length }),
		})
		if (response !== 0) return { changed: false }
		let granted = false
		try { granted = (await apple.access()).granted === true } catch (e) { granted = false }
		if (!granted) {
			await dialog.showMessageBox({ type: 'info', buttons: [t('OK')], message: t('Blockwise may not use your calendars.'), detail: t('You can allow it in System Settings → Privacy & Security → Calendars, then switch again. The built-in calendar stays.') })
			return { changed: false }
		}
		// A calendar for each commitment (the one linked before, if it is still there)
		const cals = await apple.calendars()
		const urlOf = new Map()
		for (const c of snap.commitments) {
			const own = cals.find((x) => x.url === c.calendarUrl && x.writable)
			let url = own ? own.url : null
			if (!url) {
				try { url = await apple.createCalendar({ name: c.name, color: c.color }) } catch (e) { url = null }
				if (url) engine.linkCalendar(c.uuid, url)
			}
			if (url) urlOf.set(c.uuid, url)
		}
		// What is in Apple Calendar now: a block copied (or taken) from there and not changed since is not copied again
		const from = Math.floor(Date.now() / 1000) - 90 * DAY
		const to = Math.floor(Date.now() / 1000) + 365 * DAY
		let there = []
		try { there = await apple.events(from, to, [...new Set(urlOf.values())]) } catch (e) { there = [] }
		const byBase = new Map()
		for (const e of there) {
			const k = baseUid(e.uid)
			if (!byBase.has(k)) byBase.set(k, [])
			byBase.get(k).push(e)
		}
		const sig = (list) => list.map((x) => `${x.start}-${x.end}-${x.title || ''}`).sort().join()
		let copied = 0
		let failed = 0
		for (const b of blocks) {
			const url = urlOf.get(b.commitment)
			if (!url) { failed++; continue }
			const title = b.title || (byUuid.get(b.commitment) || {}).name || ''
			const key = b.origin && b.origin.startsWith('apple:') ? b.origin.slice(6) : null
			if (key) {
				const one = /#(\d+)$/.exec(key)
				const evs = byBase.get(baseUid(key)) || []
				const theirs = one ? evs.filter((e) => e.uid === key) : evs
				const mine = engine.occurrencesOf(b.uuid, from, to).map((st) => ({ start: st, end: st + (b.end - b.start), title }))
				if (theirs.length && sig(theirs) === sig(mine)) continue // the same there
				// Changed here since: its old copy in Apple Calendar is replaced
				if (theirs.length) {
					// Only where it was found: in this commitment's calendar
					const where = theirs[0].url
					try { await apple.removeCopy(one ? { url: where, uid: baseUid(key), start: Number(one[1]) } : { url: where, uid: baseUid(key) }) } catch (e) { failed++; continue }
				}
			}
			try {
				const r = await apple.createEvent({ url, title, start: b.start, end: b.end, repeat: b.repeat, until: b.until, skip: b.skip })
				engine.markBlock(b.uuid, `apple:${r.eventUid}`)
				copied++
			} catch (e) { failed++ }
		}
		config.calendar = 'apple'
		delete config.appleCalendar
		saveConfig(config)
		await engine.flush().catch(() => {})
		await connect()
		refresh()
		notifyChanged()
		return { changed: true, message: failed ? t('{n} blocks copied to Apple Calendar; {m} could not be copied (they stay in the built-in calendar).', { n: copied, m: failed }) : t('{n} blocks copied to Apple Calendar.', { n: copied }) }
	}

	// Back to the built-in calendar
	const { response } = await dialog.showMessageBox({
		type: 'question',
		buttons: [t('Continue'), t('Cancel')],
		defaultId: 0,
		cancelId: 1,
		message: t('Use the built-in calendar?'),
		detail: t('Blocks will live in Blockwise and sync with your data. The events of your commitments\' calendars, from 3 months ago to a year ahead, are copied in. Apple Calendar stays as it is.'),
	})
	if (response !== 0) return { changed: false }
	let imported = 0
	let note = ''
	try {
		const linked = snap.commitments.filter((c) => c.calendarUrl && c.calendarUrl.startsWith('apple:'))
		const commitmentOfUrl = new Map(linked.map((c) => [c.calendarUrl, c.uuid]))
		const from = Math.floor(Date.now() / 1000) - 90 * DAY
		const to = Math.floor(Date.now() / 1000) + 365 * DAY
		const events = linked.length ? await apple.events(from, to, linked.map((c) => c.calendarUrl)) : []
		const groups = new Map()
		for (const e of events) {
			const k = baseUid(e.uid)
			if (!groups.has(k)) groups.set(k, [])
			groups.get(k).push(e)
		}
		const blocks = engine.builtinBlocks()
		const current = new Set(events.map((e) => `apple:${e.uid}`))
		const drop = []
		const keep = new Set()
		for (const b of blocks) {
			if (!b.origin || !b.origin.startsWith('apple:')) continue
			const key = b.origin.slice(6)
			if (/#\d+$/.test(key)) {
				// Copied in before as one event: gone or moved in Apple Calendar since
				if (groups.has(baseUid(key)) && !current.has(b.origin)) drop.push(b.uuid)
				continue
			}
			// Copied to Apple Calendar as a series: unchanged there, it stays as it is
			const evs = groups.get(key)
			if (!evs) continue
			const mine = engine.occurrencesOf(b.uuid, from, to).map((st) => `${st}-${st + (b.end - b.start)}`).sort().join()
			const theirs = evs.map((e) => `${e.start}-${e.end}`).sort().join()
			if (mine === theirs && evs.every((e) => (e.title || '') === (b.title || e.title || ''))) keep.add(key)
			else drop.push(b.uuid)
		}
		if (drop.length) engine.removeBlocks(drop)
		const fresh = []
		for (const [k, evs] of groups) {
			if (keep.has(k)) continue
			for (const e of evs) fresh.push({ commitment: commitmentOfUrl.get(e.url), title: e.title, start: e.start, end: e.end, origin: `apple:${e.uid}` })
		}
		imported = engine.importBlocks(fresh)
	} catch (e) {
		note = t('Apple Calendar could not be read, so nothing was copied in.')
	}
	config.calendar = 'builtin'
	delete config.appleCalendar
	saveConfig(config)
	await engine.flush().catch(() => {})
	await connect()
	refresh()
	notifyChanged()
	return { changed: true, message: note || t('{n} events copied into the built-in calendar.', { n: imported }) }
}

/**
 * Log out / disconnect. `keepData`: the data on this Mac stays (Nextcloud
 * refused the app password: changes not synced yet are not lost).
 */
async function disconnect({ revoke, keepData = false, carry = false }) {
	if (carry) keepData = true
	clearInterval(refreshTimer)
	clearTimeout(syncTimer)
	if (revoke && client) await client.revoke()
	if (revoke && driveStoreNow) await driveStoreNow.revoke()
	if (engine) await engine.flush().catch(() => {})
	if (!keepData && vault) {
		vault.remove('data')
		vault.remove('drivestate')
		try { fs.unlinkSync(ownerPath()) } catch (e) { /* none */ }
	}
	if (carry) {
		// Like "this Mac only" until you choose: the next sync gets everything
		if (vault) vault.remove('drivestate')
		writeOwner('local')
	}
	client = null
	engine = null
	remote = null
	driveStoreNow = null
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
	setAppMenu()
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
	if (!engine) return
	try {
		const [from, to] = weekBounds()
		const [d, sessions] = await Promise.all([engine.api('GET', 'dashboard'), engine.api('GET', `sessions?from=${from}&to=${to}`)])
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
	}
	broadcast()
}

function refreshSoon() {
	clearTimeout(refreshSoonTimer)
	refreshSoonTimer = setTimeout(refresh, 150)
}

// --- sync -------------------------------------------------------------------------------------

function syncSoon(ms) {
	clearTimeout(syncTimer)
	syncTimer = setTimeout(syncNow, ms)
}

/** Sends this Mac's changes and gets the others'; then again in a while (sooner while tracking). */
async function syncNow() {
	clearTimeout(syncTimer)
	if (!engine || !remote) return
	try {
		const r = await engine.sync()
		syncError = null
		if (r && (r.pulled || (r.refused && r.refused.length))) notifyChanged()
		if (r && r.refused && r.refused.length) {
			const reasons = [...new Set(r.refused.map((x) => x.reason))].join(' · ')
			notify(t('Some changes could not be synced'), /too far ahead/.test(reasons) ? t('Check the date and time of this Mac.') : reasons)
		}
	} catch (e) {
		if (e.status === 401 || e.revoked) {
			if (config && config.provider === 'nextcloud') {
				notify(t('Log in again'), t('Nextcloud rejected the app password. Log in again.'))
				disconnect({ revoke: false, keepData: true })
			} else {
				syncError = t('{drive} no longer accepts Blockwise. Disconnect and connect it again.', { drive: PROVIDER_NAMES[config.provider] })
			}
			return
		}
		// Offline: the changes wait; anything else is shown in the menu
		syncError = e.offline || e.status === 0 ? null : t(e.message)
	}
	refresh()
	if (engine) syncTimer = setTimeout(syncNow, dash && dash.running ? 30000 : 120000)
}

function publicState() {
	const provider = config ? config.provider : null
	return {
		dash,
		error: dashError || syncError,
		now: Math.floor(Date.now() / 1000),
		provider,
		providers: ['nextcloud', 'local', 'gdrive', 'dropbox'],
		providersReady: providersReady(),
		server: config && config.server,
		host: provider === 'nextcloud' ? new URL(config.server).host : provider ? t(PROVIDER_NAMES[provider]) : null,
		loginName: config && config.loginName,
		sync: engine ? { pending: engine.pending(), lastSync: engine.lastSync(), error: syncError } : null,
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
	if (!dash || !engine) return
	const a = checkAlerts(dash, now, seenAlerts, t)
	a.notifications.forEach((n) => notify(n.title, n.body))
	if (a.stopAt) {
		// Pomodoro long break: stop exactly at its start (another device may do the same; that's harmless)
		try { await engine.api('POST', 'sessions/stop', { at: a.stopAt, longBreak: true }) } catch (e) { /* retried on next tick */ }
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
		...(config.provider !== 'nextcloud' ? [{ label: t('Calendar'), submenu: [
			{ label: t('Built-in calendar'), type: 'radio', checked: calendarMode() === 'builtin', click: () => setCalendarMode('builtin').then(changedToast) },
			{ label: t('Apple Calendar'), type: 'radio', checked: calendarMode() === 'apple', click: () => setCalendarMode('apple').then(changedToast) },
		] }] : []),
		{ type: 'separator' },
		config.provider === 'nextcloud'
			? { label: t('Logged in as {user} on {host}', { user: config.loginName, host: new URL(config.server).host }), enabled: false }
			: config.provider === 'local'
				? { label: t('Your data is on this Mac only'), enabled: false }
				: { label: t('Syncing with {drive}, end-to-end encrypted', { drive: PROVIDER_NAMES[config.provider] }), enabled: false },
		...(remote ? [{ label: syncError ? t('Sync now (last try failed)') : t('Sync now'), click: () => syncNow() }] : []),
		{ label: syncMenuLabel(), click: confirmLogout },
		{ label: t('Quit Blockwise'), role: 'quit' },
	])
}

const syncMenuLabel = () => (config.provider === 'local' ? t('Sync with Nextcloud or a drive…') : t('Log out or switch sync…'))

/** The menu at the top of the screen (while a Blockwise window is in front) */
function setAppMenu() {
	const connected = !!(config && engine)
	Menu.setApplicationMenu(Menu.buildFromTemplate([
		{ label: 'Blockwise', submenu: [
			{ role: 'about', label: t('About Blockwise') },
			{ type: 'separator' },
			{ label: t('Settings…'), accelerator: 'Cmd+,', enabled: connected, click: () => showMain('settings') },
			...(connected && remote ? [{ label: t('Sync now'), accelerator: 'Cmd+R', click: () => syncNow() }] : []),
			...(connected ? [{ label: syncMenuLabel(), click: confirmLogout }] : []),
			{ type: 'separator' },
			{ role: 'hide', label: t('Hide Blockwise') }, { role: 'hideOthers' }, { role: 'unhide' },
			{ type: 'separator' },
			{ role: 'quit', label: t('Quit Blockwise') },
		] },
		// Copy, paste and undo in text fields
		{ role: 'editMenu' },
		{ role: 'windowMenu' },
	]))
}

const syncName = () => (config.provider === 'nextcloud' ? new URL(config.server).host : t(PROVIDER_NAMES[config.provider]))

/**
 * Change where your data lives. "Switch" takes your data on this Mac along to
 * the sync you choose next (a drive, Nextcloud or this Mac only); "remove"
 * leaves it only where it is synced now.
 */
async function confirmLogout() {
	if (config.provider === 'local') {
		// Your data comes along to the sync you choose
		await disconnect({ revoke: false, keepData: true })
		return
	}
	const pending = engine ? engine.pending() : 0
	const isNc = config.provider === 'nextcloud'
	const { response } = await dialog.showMessageBox({
		type: 'question',
		buttons: [t('Switch and take my data'), isNc ? t('Log out and remove it from this Mac') : t('Disconnect and remove it from this Mac'), t('Cancel')],
		defaultId: 0,
		cancelId: 2,
		message: isNc ? t('Stop syncing with {host}?', { host: syncName() }) : t('Stop syncing with {drive}?', { drive: syncName() }),
		detail: [
			isNc ? t('The app password is removed from Nextcloud.') : t('Blockwise forgets the drive and your passphrase on this Mac. Your encrypted data on the drive stays.'),
			t('"Switch" keeps your data on this Mac and takes it to the sync you choose next (Nextcloud, Dropbox, Google Drive or this Mac only).'),
			pending ? t('Some changes on this Mac are not synced yet: "Switch" keeps them, "remove" loses them.') : '',
		].filter(Boolean).join('\n\n'),
	})
	if (response === 0) disconnect({ revoke: true, carry: true })
	else if (response === 1) disconnect({ revoke: true })
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
	syncSoon(300)
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
	if (!engine) return showSetup()
	if (page === 'calendar') return openCalendar()
	const hash = PAGES.includes(page) ? `#${page}` : /^calendar\/\d{8}$/.test(page || '') ? `#${page}` : ''
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
		trafficLightPosition: { x: 20, y: 29 },
		backgroundColor: nativeTheme.shouldUseDarkColors ? '#14121d' : '#f6f5fb',
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
	// Blockwise's calendar page (built in, or Nextcloud's calendars): in Blockwise's window, on that day
	if (engine && (config.provider === 'nextcloud' || calendarMode() === 'builtin')) {
		const d = Number.isFinite(ts) ? new Date(ts * 1000) : new Date()
		return showMain(`calendar/${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`)
	}
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
		height: 640,
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
		config = { provider: 'nextcloud', server, loginName: cred.loginName, appPassword: sealed ? sealed.appPassword : '-', encrypted: !!sealed, format: sealed && sealed.format, notifications: true }
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
	await finishSetup(`nextcloud:${server}\n${config.loginName}`)
}

/**
 * After choosing where to sync: another account's data on this Mac is removed;
 * coming from "this Mac only", your data moves along to the new sync.
 */
async function finishSetup(owner) {
	const before = readOwner()
	const fromLocal = before === 'local' && owner !== 'local'
	if (before !== owner && !fromLocal) {
		const v = createVault({ safeStorage, dir: app.getPath('userData') })
		v.remove('data')
		v.remove('drivestate')
	}
	writeOwner(owner)
	unreadableData = false
	await connect({ fresh: true })
	if (fromLocal && !unreadableData) await engine.resendAll()
	startApp()
	syncNow()
	if (setupWin) setupWin.close()
	showMain('now')
	if (unreadableData) {
		dialog.showMessageBox({
			type: 'info',
			buttons: [t('OK')],
			message: t('Blockwise could not open its data on this Mac'),
			detail: owner === 'local'
				? t('It was encrypted with a Keychain key that is no longer there (deleted, or the Keychain was reset). The old file was set aside in Blockwise\'s folder; Blockwise starts empty.')
				: t('It was encrypted with a Keychain key that is no longer there (deleted, or the Keychain was reset). The old file was set aside in Blockwise\'s folder; your data comes again from your sync. Changes that were not synced yet are in the old file only.'),
		})
	}
}
let unreadableData = false

/** Connect a drive: you allow Blockwise in your browser. @return {{exists: boolean}} a Blockwise folder is there already */
async function connectDrive(provider) {
	if (provider !== 'dropbox' && provider !== 'gdrive') throw new Error('Invalid request.')
	if (!providersReady()[provider]) throw new Error('Set up {drive} first.')
	if (pendingDrive && pendingDrive.cancel) pendingDrive.cancel()
	const opts = { fetch: apiFetch, openBrowser: (u) => openLink(u) }
	const flow = provider === 'dropbox'
		? drives.connectDropbox({ appKey: providerKeys.dropboxAppKey, ...opts })
		: drives.connectGoogle({ clientId: providerKeys.googleClientId, clientSecret: providerKeys.googleClientSecret, ...opts })
	pendingDrive = { provider, cancel: flow.cancel }
	const r = await flow
	const store = driveStore(provider, r.refreshToken)
	const account = r.account || (store.account ? await store.account().catch(() => null) : null)
	const exists = !!(await store.read('blockwise.json'))
	pendingDrive = { provider, refreshToken: r.refreshToken, account, store }
	return { exists }
}

/** The passphrase: sets up the folder, or opens the one other devices made. */
async function unlockDrive(passphrase) {
	if (!pendingDrive || !pendingDrive.store) throw new Error('Connect a drive first.')
	const key = await FileSync.unlock(pendingDrive.store, String(passphrase || ''))
	const v = createVault({ safeStorage, dir: app.getPath('userData') })
	const driveToken = await v.seal(pendingDrive.refreshToken)
	const syncKey = await v.seal(Buffer.from(key).toString('base64'))
	if (!driveToken || !syncKey) throw new Error(t('Blockwise needs its own Keychain entry ("Blockwise Safe Storage") to keep the connection; it can\'t see your other passwords. Quit Blockwise, open it again, connect, and click Always Allow when macOS asks.'))
	const { provider, account } = pendingDrive
	config = { provider, driveToken, syncKey, driveAccount: account, notifications: true }
	saveConfig(config)
	pendingDrive = null
	await finishSetup(`${provider}:${account || ''}`)
}

async function useThisMac() {
	config = { provider: 'local', notifications: true }
	saveConfig(config)
	await finishSetup('local')
}

// --- IPC from the windows ------------------------------------------------------------------------

/** Only the app's own pages (file:// in renderer/) may talk to the main process. */
function fromApp(e) {
	const url = (e && e.senderFrame && e.senderFrame.url) || ''
	return url.startsWith(RENDERER_URL)
}

function handle(channel, fn, onlyPage) {
	ipcMain.handle(channel, async (e, ...args) => {
		try {
			if (!fromApp(e)) throw new Error('Not allowed.')
			if (onlyPage && e.senderFrame.url.slice(RENDERER_URL.length).split(/[?#]/)[0] !== onlyPage) throw new Error('Not allowed.')
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
const API_PATH = /^[a-z][a-z-]*(\/\d+(\/([a-z][a-z-]*|\d+))?|\/(start|stop))?(\?[a-zA-Z]+=[a-zA-Z0-9_-]*(&[a-zA-Z]+=[a-zA-Z0-9_-]*)*)?$/
const isPlainBody = (b) => b === undefined || (b !== null && typeof b === 'object' && Object.getPrototypeOf(b) === Object.prototype)

ipcMain.handle('api', async (e, method, apiPath, body) => {
	try {
		if (!fromApp(e)) throw new Error('Not allowed.')
		if (!engine) throw new Error('Not logged in.')
		if (!API_METHODS.has(method) || typeof apiPath !== 'string' || !API_PATH.test(apiPath) || !isPlainBody(body)) throw new Error('Invalid request.')
		// Answered here, from your data on this Mac
		const result = await engine.api(method, apiPath, body)
		if (method !== 'GET') {
			refreshSoon()
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
handle('calendarMode', () => ({ mode: calendarMode(), available: !!config && config.provider !== 'nextcloud' }))
// Only from the main window; asks you before anything changes
handle('setCalendarMode', (mode) => setCalendarMode(String(mode || '')), 'app.html')
// Light, dark or like macOS: for every window (and the menus), kept on this Mac
handle('appearance', () => nativeTheme.themeSource)
handle('setAppearance', (mode) => setAppearance(String(mode || '')), 'app.html')
// Choosing where your data lives: only from the first-run screen, and only while
// nothing is connected (no other window can switch your sync or wipe your data)
const setupOnly = (fn) => (...args) => {
	if (engine) throw new Error('Not allowed.')
	return fn(...args)
}
handle('login', setupOnly((server) => login(String(server || ''))), 'setup.html')
handle('cancelLogin', () => {
	if (loginFlow) loginFlow.cancel()
	if (loginWin) loginWin.close()
	if (pendingDrive && pendingDrive.cancel) pendingDrive.cancel()
	// Connected but no passphrase given: the token is not kept, so it is ended at the provider
	if (pendingDrive && pendingDrive.store) pendingDrive.store.revoke().catch(() => {})
	pendingDrive = null
})
handle('connectDrive', setupOnly((provider) => connectDrive(String(provider || ''))), 'setup.html')
handle('unlockDrive', setupOnly((passphrase) => unlockDrive(typeof passphrase === 'string' ? passphrase : '')), 'setup.html')
handle('useThisMac', setupOnly(() => useThisMac()), 'setup.html')
handle('saveProviderKeys', setupOnly((provider, keys) => saveProviderKeys(String(provider || ''), keys)), 'setup.html')
handle('syncNow', () => syncNow())
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
	setAppMenu()
	if (!tray) createTray()
	refresh()
	clearInterval(refreshTimer)
	// The current block and the timer move on with the clock
	refreshTimer = setInterval(refresh, 30000)
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
	if (engine) engine.flush().catch(() => {})
})

app.whenReady().then(async () => {
	for (const p of [LOGIN_PARTITION, API_PARTITION]) lockDownSession(session.fromPartition(p))
	lockDownSession(session.defaultSession)
	// Earlier versions kept Nextcloud cookies on disk (login page, API requests): remove them
	session.fromPartition('persist:tracker').clearStorageData().catch(() => {})
	session.defaultSession.clearStorageData({ storages: ['cookies'] }).catch(() => {})
	t = i18n.make(app.getLocale())
	loadProviderKeys()
	loadAppearance()
	setAppMenu()
	config = loadConfig()
	if (config) {
		try {
			await connect()
		} catch (e) {
			// Keychain entry unreadable: log in again (the data file stays, for the same account)
			config = null
			engine = null
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
	powerMonitor.on('resume', () => { refresh(); syncSoon(2000) })
	if (engine) syncSoon(1000)
})

app.on('activate', () => (engine ? showMain() : showSetup()))
// Keep running in the menu bar when windows are closed
app.on('window-all-closed', () => {})
