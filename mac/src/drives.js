/**
 * Dropbox, Google Drive and OneDrive as sync folders (see nextcloud/js/filesync.js),
 * and the calendar that comes with the account (js/cloudcal.js).
 *
 * - Dropbox: an "App folder" app, so Blockwise only ever sees Apps/Blockwise.
 * - Google Drive: the hidden app data folder (scope drive.appdata), so Blockwise
 *   can't see or change any of your other files, and they can't see its files.
 *   Google Calendar (calendar.app.created): only calendars Blockwise makes.
 * - OneDrive: the app's folder (Apps/Blockwise, Files.ReadWrite.AppFolder).
 *   Outlook (Calendars.ReadWrite), asked for only when you switch it on: Microsoft
 *   can't limit it to Blockwise's calendars, so `guard` and the store do (only
 *   marked calendars Blockwise made, only a title, times and a repeat in events).
 *
 * Only the refresh token is kept (encrypted by the caller: the Keychain on the
 * Mac, the browser's own key in the web app); access tokens live in memory for
 * an hour at most. Every request goes to the provider's fixed https address;
 * nothing from an answer is used as a URL.
 *
 * Runs in Node (the Mac app; tested with stand-in servers) and in the browser
 * (the web app: window.BlockwiseDrives). Logging in from the Mac (a browser
 * window and a server on 127.0.0.1) needs Node; the web app logs in by redirect.
 */
;(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory(() => require('./oauth'))
	else root.BlockwiseDrives = factory(null)
})(typeof self !== 'undefined' ? self : this, function (nodeOAuth) {
'use strict'
const oauth = () => {
	if (!nodeOAuth) throw new Error('Not available here.')
	return nodeOAuth()
}
const enc = new TextEncoder()

/** POST application/x-www-form-urlencoded, JSON back; errors without secrets in them. */
async function tokenRequest(fetch, url, params) {
	let res
	try {
		res = await fetch(url, {
			method: 'POST',
			redirect: 'error',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
			body: new URLSearchParams(params).toString(),
		})
	} catch (e) {
		throw Object.assign(new Error('No connection. Try again when you are online.'), { offline: true })
	}
	let data = null
	try { data = await res.json() } catch (e) { /* not JSON */ }
	if (!res.ok || !data || typeof data.access_token !== 'string') {
		const code = data && typeof data.error === 'string' ? data.error : `HTTP ${res.status}`
		throw Object.assign(new Error(`The login was refused (${code.replace(/[^\w .-]/g, '').slice(0, 60)}).`), { status: res.status, revoked: code === 'invalid_grant' })
	}
	return data
}

const NAME_RE = /^[A-Za-z0-9._-]{1,80}$/
const checkName = (name) => {
	if (!NAME_RE.test(name) || name.startsWith('.')) throw new Error('Invalid file name')
	return name
}
const MAX_FILE = 32 * 1024 * 1024

class DriveError extends Error {
	constructor(message, extra = {}) {
		super(message)
		Object.assign(this, extra)
	}
}

/** Access token from the refresh token, renewed a minute before it ends. */
function tokens({ fetch, refresh, tokenUrl, params, now = () => Date.now(), onRotate }) {
	let access = null
	let until = 0
	return {
		async get(force = false) {
			if (!force && access && now() < until - 60000) return access
			const t = await tokenRequest(fetch, tokenUrl, { ...(typeof params === 'function' ? params() : params), grant_type: 'refresh_token', refresh_token: refresh })
			// Microsoft: a new refresh token with each access token, kept by the caller
			if (onRotate && typeof t.refresh_token === 'string' && t.refresh_token && t.refresh_token !== refresh && t.refresh_token.length < 8192) {
				refresh = t.refresh_token
				try { onRotate(refresh) } catch (e) { /* the old one still works for a while */ }
			}
			access = t.access_token
			until = now() + Math.min(Number(t.expires_in) || 3600, 4 * 3600) * 1000
			return access
		},
		forget() { access = null },
	}
}

/** fetch with the access token; one retry after a 401 (token ended early). */
async function authed(fetch, tok, url, init = {}) {
	for (let attempt = 0; attempt < 2; attempt++) {
		const token = await tok.get(attempt > 0)
		let res
		try {
			res = await fetch(url, { ...init, redirect: 'error', headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } })
		} catch (e) {
			throw new DriveError('No connection to the drive.', { offline: true })
		}
		if (res.status === 401 && attempt === 0) { tok.forget(); continue }
		if (res.status === 401) throw new DriveError('The drive no longer accepts Blockwise. Connect it again.', { status: 401 })
		if (res.status === 429 || res.status >= 500) throw new DriveError('The drive is busy. Blockwise tries again later.', { offline: true, status: res.status })
		return res
	}
	throw new DriveError('Unexpected answer from the drive.')
}

const bytesOf = async (res) => {
	const len = Number(res.headers.get('content-length') || 0)
	if (len > MAX_FILE) throw new DriveError('A sync file is too large.')
	const buf = new Uint8Array(await res.arrayBuffer())
	if (buf.length > MAX_FILE) throw new DriveError('A sync file is too large.')
	return buf
}

// --- Dropbox ------------------------------------------------------------------------------

const DROPBOX = {
	authorize: 'https://www.dropbox.com/oauth2/authorize',
	token: 'https://api.dropboxapi.com/oauth2/token',
	api: 'https://api.dropboxapi.com/2',
	content: 'https://content.dropboxapi.com/2',
	// Waiting for changes: no token is sent there, only the folder's cursor
	notify: 'https://notify.dropboxapi.com/2',
	// Registered in the Dropbox app's settings as a redirect URI
	port: 53682,
	path: '/dropbox',
}

/** Dropbox-API-Arg must be ASCII: everything else escaped */
const dropboxArg = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))

/** Opens Dropbox in the browser; you allow Blockwise; returns the refresh token. */
function connectDropbox({ appKey, fetch, openBrowser, endpoints = DROPBOX }) {
	if (!appKey) throw new DriveError('This build of Blockwise has no Dropbox app key (mac/config/providers.json).')
	const { verifier, challenge } = oauth().pkce()
	const wait = oauth().waitForCode({
		port: endpoints.port,
		path: endpoints.path,
		openBrowser,
		authorizeUrl: (redirectUri, state) => `${endpoints.authorize}?${new URLSearchParams({
			client_id: appKey, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
			token_access_type: 'offline', redirect_uri: redirectUri, state,
		})}`,
	})
	const result = wait.then(async ({ code, redirectUri }) => {
		const t = await tokenRequest(fetch, endpoints.token, { code, grant_type: 'authorization_code', client_id: appKey, code_verifier: verifier, redirect_uri: redirectUri })
		if (typeof t.refresh_token !== 'string') throw new DriveError('Dropbox did not allow offline access.')
		return { refreshToken: t.refresh_token, account: typeof t.account_id === 'string' ? t.account_id.slice(0, 64) : null }
	})
	result.cancel = wait.cancel
	return result
}

/** The app folder (Apps/Blockwise) as a sync store. */
function dropboxStore({ appKey, refreshToken, fetch, endpoints = DROPBOX }) {
	const tok = tokens({ fetch, refresh: refreshToken, tokenUrl: endpoints.token, params: { client_id: appKey } })
	const rpc = async (route, body) => {
		const res = await authed(fetch, tok, `${endpoints.api}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
		const data = await res.json().catch(() => null)
		return { res, data }
	}
	return {
		kind: 'dropbox',
		async list() {
			const names = []
			let { res, data } = await rpc('files/list_folder', { path: '', limit: 2000 })
			for (let page = 0; page < 200; page++) {
				if (!res.ok || !data || !Array.isArray(data.entries)) throw new DriveError(`Dropbox could not list the folder (HTTP ${res.status}).`)
				for (const e of data.entries) if (e['.tag'] === 'file' && typeof e.name === 'string') names.push(e.name)
				if (!data.has_more) break
				;({ res, data } = await rpc('files/list_folder/continue', { cursor: data.cursor }))
			}
			return names
		},
		async read(name) {
			const res = await authed(fetch, tok, `${endpoints.content}/files/download`, { method: 'POST', headers: { 'Dropbox-API-Arg': dropboxArg({ path: '/' + checkName(name) }) } })
			if (res.status === 409) return null // not found
			if (!res.ok) throw new DriveError(`Dropbox could not read a file (HTTP ${res.status}).`)
			return bytesOf(res)
		},
		async write(name, bytes, opts = {}) {
			const res = await authed(fetch, tok, `${endpoints.content}/files/upload`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': dropboxArg({ path: '/' + checkName(name), mode: opts.create ? 'add' : 'overwrite', autorename: false, mute: true }) },
				body: bytes,
			})
			if (res.status === 409 && opts.create) throw new DriveError('exists', { exists: true })
			if (!res.ok) throw new DriveError(`Dropbox could not save a file (HTTP ${res.status}).`)
		},
		async remove(name) {
			const { res } = await rpc('files/delete_v2', { path: '/' + checkName(name) })
			if (!res.ok && res.status !== 409) throw new DriveError(`Dropbox could not remove a file (HTTP ${res.status}).`)
		},
		/** Log out: the token stops working */
		async revoke() {
			try { await authed(fetch, tok, `${endpoints.api}/auth/token/revoke`, { method: 'POST' }) } catch (e) { /* offline: forget it anyway */ }
		},
		/** Where the folder is now, to wait for changes from there */
		async changeCursor() {
			const { res, data } = await rpc('files/list_folder/get_latest_cursor', { path: '' })
			if (!res.ok || !data || typeof data.cursor !== 'string') throw new DriveError(`Dropbox could not watch the folder (HTTP ${res.status}).`, { status: res.status })
			return data.cursor
		},
		/**
		 * Waits until something in the folder changes (Dropbox answers at once
		 * then), or `timeout` seconds pass. Only the cursor is sent: no token.
		 */
		async waitForChanges(cursor, { timeout = 480, signal } = {}) {
			let res
			try {
				res = await fetch(`${endpoints.notify}/files/list_folder/longpoll`, {
					method: 'POST', redirect: 'error', signal,
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ cursor, timeout: Math.max(30, Math.min(480, Math.round(timeout))) }),
				})
			} catch (e) {
				throw new DriveError('No connection to the drive.', { offline: true, aborted: !!(signal && signal.aborted) })
			}
			const data = await res.json().catch(() => null)
			// An old cursor: start again from the folder as it is now
			if (res.status === 400 || res.status === 409) throw new DriveError('The folder\'s watch cursor expired.', { reset: true, status: res.status })
			if (!res.ok || !data) throw new DriveError('The drive is busy. Blockwise tries again later.', { offline: true, status: res.status })
			const changed = data.changes === true
			return { changed, cursor: changed ? await this.changeCursor() : cursor, retryAfter: Number.isFinite(data.backoff) ? Math.min(data.backoff, 3600) : 0 }
		},
	}
}

// --- Google Drive --------------------------------------------------------------------------

const GOOGLE = {
	authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
	token: 'https://oauth2.googleapis.com/token',
	revoke: 'https://oauth2.googleapis.com/revoke',
	files: 'https://www.googleapis.com/drive/v3/files',
	about: 'https://www.googleapis.com/drive/v3/about',
	changes: 'https://www.googleapis.com/drive/v3/changes',
	upload: 'https://www.googleapis.com/upload/drive/v3/files',
	scope: 'https://www.googleapis.com/auth/drive.appdata',
	calendarScope: 'https://www.googleapis.com/auth/calendar.app.created',
	calendar: 'https://www.googleapis.com/calendar/v3/',
	path: '/google',
}

/** Opens Google in the browser; you allow Blockwise; returns the refresh token. */
function connectGoogle({ clientId, clientSecret, fetch, openBrowser, endpoints = GOOGLE }) {
	if (!clientId) throw new DriveError('This build of Blockwise has no Google client id (mac/config/providers.json).')
	const { verifier, challenge } = oauth().pkce()
	const wait = oauth().waitForCode({
		port: 0, // Google accepts any loopback port for desktop apps
		path: endpoints.path,
		openBrowser,
		authorizeUrl: (redirectUri, state) => `${endpoints.authorize}?${new URLSearchParams({
			// Drive's app data folder, and the calendars Blockwise makes (you can leave that out)
			client_id: clientId, response_type: 'code', scope: `${endpoints.scope} ${endpoints.calendarScope || GOOGLE.calendarScope}`, include_granted_scopes: 'true', code_challenge: challenge, code_challenge_method: 'S256',
			access_type: 'offline', prompt: 'consent', redirect_uri: redirectUri, state,
		})}`,
	})
	const result = wait.then(async ({ code, redirectUri }) => {
		// Google's "client secret" for desktop apps is not secret (it ships in every copy); PKCE protects the code
		const t = await tokenRequest(fetch, endpoints.token, { code, grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret || '', code_verifier: verifier, redirect_uri: redirectUri })
		if (typeof t.refresh_token !== 'string') throw new DriveError('Google did not allow offline access.')
		if (typeof t.scope === 'string' && !t.scope.split(' ').includes(endpoints.scope)) throw new DriveError('Allow Blockwise to use its app data in Google Drive, then try again.')
		return { refreshToken: t.refresh_token, account: null, calendar: typeof t.scope === 'string' && t.scope.split(' ').includes(endpoints.calendarScope || GOOGLE.calendarScope) }
	})
	result.cancel = wait.cancel
	return result
}

/** A request to the account's calendar API, JSON in and out (errors carry the status; 0: not reachable) */
async function calendarCall(fetch, tok, base, method, path, body, name) {
	const res = await authed(fetch, tok, base + path, {
		method,
		headers: body === undefined || body === null ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json; charset=UTF-8' },
		body: body === undefined || body === null ? undefined : JSON.stringify(body),
	}).catch((e) => { throw Object.assign(new Error(e.message), { status: e.offline ? 0 : e.status || 0 }) })
	const text = await res.text()
	let data = null
	try { data = text.trim() ? JSON.parse(text) : null } catch (e) { data = null }
	if (!res.ok) {
		const m = data && data.error && typeof data.error.message === 'string' ? data.error.message.replace(/[\r\n]/g, ' ').slice(0, 200) : `HTTP ${res.status}`
		throw Object.assign(new Error(`${name}: ${m}`), { status: res.status })
	}
	return data
}

/** The hidden app data folder as a sync store. */
function googleStore({ clientId, clientSecret, refreshToken, fetch, endpoints = GOOGLE }) {
	const tok = tokens({ fetch, refresh: refreshToken, tokenUrl: endpoints.token, params: { client_id: clientId, client_secret: clientSecret || '' } })
	/** name -> oldest file with it (Drive allows the same name twice) */
	const ids = async () => {
		const map = new Map()
		let pageToken = ''
		for (let page = 0; page < 200; page++) {
			const q = new URLSearchParams({ spaces: 'appDataFolder', fields: 'nextPageToken,files(id,name,createdTime)', pageSize: '1000', orderBy: 'createdTime' })
			if (pageToken) q.set('pageToken', pageToken)
			const res = await authed(fetch, tok, `${endpoints.files}?${q}`)
			const data = await res.json().catch(() => null)
			if (!res.ok || !data || !Array.isArray(data.files)) throw new DriveError(`Google Drive could not list the folder (HTTP ${res.status}).`)
			for (const f of data.files) {
				if (typeof f.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(f.id) || typeof f.name !== 'string') continue
				if (!map.has(f.name)) map.set(f.name, [])
				map.get(f.name).push(f.id)
			}
			pageToken = data.nextPageToken
			if (!pageToken) break
		}
		return map
	}
	const del = async (id) => {
		const res = await authed(fetch, tok, `${endpoints.files}/${id}`, { method: 'DELETE' })
		if (!res.ok && res.status !== 404) throw new DriveError(`Google Drive could not remove a file (HTTP ${res.status}).`)
	}
	return {
		kind: 'gdrive',
		async list() { return [...(await ids()).keys()] },
		async read(name) {
			checkName(name)
			const found = (await ids()).get(name)
			if (!found) return null
			const res = await authed(fetch, tok, `${endpoints.files}/${found[0]}?alt=media`)
			if (res.status === 404) return null
			if (!res.ok) throw new DriveError(`Google Drive could not read a file (HTTP ${res.status}).`)
			return bytesOf(res)
		},
		async write(name, bytes, opts = {}) {
			checkName(name)
			const existing = (await ids()).get(name)
			if (existing && opts.create) throw new DriveError('exists', { exists: true })
			const boundary = 'blockwise' + Math.random().toString(36).slice(2)
			const meta = JSON.stringify(existing ? { name } : { name, parents: ['appDataFolder'] })
			const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`)
			const tail = enc.encode(`\r\n--${boundary}--`)
			const body = new Uint8Array(head.length + bytes.length + tail.length)
			body.set(head, 0)
			body.set(bytes, head.length)
			body.set(tail, head.length + bytes.length)
			const url = existing ? `${endpoints.upload}/${existing[0]}?uploadType=multipart` : `${endpoints.upload}?uploadType=multipart`
			const res = await authed(fetch, tok, url, { method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })
			if (!res.ok) throw new DriveError(`Google Drive could not save a file (HTTP ${res.status}).`)
			if (opts.create) {
				// Two devices made the same file at the same moment: the oldest one counts
				const now = (await ids()).get(name) || []
				const mine = await res.json().catch(() => null)
				if (now.length > 1 && mine && now[0] !== mine.id) {
					await del(mine.id).catch(() => {})
					throw new DriveError('exists', { exists: true })
				}
			}
		},
		async remove(name) {
			checkName(name)
			for (const id of (await ids()).get(name) || []) await del(id)
		},
		/** Which Google account (an id, no name or e-mail): another account's data is not mixed in */
		async account() {
			const res = await authed(fetch, tok, `${endpoints.about}?fields=user(permissionId)`)
			const data = await res.json().catch(() => null)
			const id = data && data.user && data.user.permissionId
			return typeof id === 'string' ? id.replace(/[^\w-]/g, '').slice(0, 64) : null
		},
		/** Where Drive's change list is now */
		async changeCursor() {
			const res = await authed(fetch, tok, `${endpoints.changes}/startPageToken`)
			const data = await res.json().catch(() => null)
			if (!res.ok || !data || typeof data.startPageToken !== 'string') throw new DriveError(`Google Drive could not watch the folder (HTTP ${res.status}).`, { status: res.status })
			return data.startPageToken
		},
		/**
		 * Google only pushes changes to public web servers: so, after `interval`
		 * ms, one small request for the changes in Blockwise's app data folder.
		 */
		async waitForChanges(cursor, { interval = 20000, sleep, signal } = {}) {
			await (sleep ? sleep(interval) : new Promise((r) => setTimeout(r, interval)))
			if (signal && signal.aborted) throw new DriveError('Stopped.', { aborted: true })
			let token = cursor
			let changed = false
			for (let page = 0; page < 50; page++) {
				const q = new URLSearchParams({ pageToken: token, spaces: 'appDataFolder', pageSize: '100', fields: 'nextPageToken,newStartPageToken,changes(fileId)' })
				const res = await authed(fetch, tok, `${endpoints.changes}?${q}`)
				const data = await res.json().catch(() => null)
				if (res.status === 400 || res.status === 404) throw new DriveError('The folder\'s watch cursor expired.', { reset: true, status: res.status })
				if (!res.ok || !data) throw new DriveError(`Google Drive could not watch the folder (HTTP ${res.status}).`, { status: res.status })
				if (Array.isArray(data.changes) && data.changes.length) changed = true
				if (typeof data.newStartPageToken === 'string') return { changed, cursor: data.newStartPageToken, retryAfter: 0 }
				if (typeof data.nextPageToken !== 'string') break
				token = data.nextPageToken
			}
			return { changed, cursor: token, retryAfter: 0 }
		},
		/** Google Calendar: only the requests js/cloudcal.js makes (guard.google) */
		async calendar(method, path, body) {
			if (!guard.google(method, path) || (body != null && (typeof body !== 'object' || Array.isArray(body)))) throw Object.assign(new Error('Invalid request.'), { status: 400 })
			return calendarCall(fetch, tok, endpoints.calendar, method, path, body, 'Google Calendar')
		},
		async revoke() {
			try {
				// The refresh token itself: that ends the connection (in the body, not in the URL)
				await fetch(endpoints.revoke, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken }).toString() })
			} catch (e) { /* offline: forget it anyway */ }
		},
	}
}

// --- what the page may ask the account's calendar for (as android/core CloudGuard) -------------

const guard = (() => {
	const odd = (m, p) => typeof m !== 'string' || typeof p !== 'string' || p.length > 1500 || /\.\.|%2e%2e|%2f|%5c|\/\//i.test(p)
	const CAL = '[A-Za-z0-9%._-]{1,300}'
	const EVENT = '[A-Za-z0-9_%-]{1,300}'
	const VALUE = '[A-Za-z0-9:._%+-]{0,300}'
	const Q = `(timeMin|timeMax|singleEvents|maxResults|showDeleted|orderBy|pageToken)=${VALUE}`
	const G = {
		GET: new RegExp(`^calendars/${CAL}/events(\\?${Q}(&${Q}){0,7})?$|^calendars/${CAL}/events/${EVENT}$`),
		POST: new RegExp(`^calendars$|^calendars/${CAL}/events$|^calendars/${CAL}/events/${EVENT}/move\\?destination=${CAL}$`),
		PATCH: new RegExp(`^calendars/${CAL}/events/${EVENT}$|^users/me/calendarList/${CAL}\\?colorRgbFormat=true$`),
		DELETE: new RegExp(`^calendars/${CAL}$|^calendars/${CAL}/events/${EVENT}$`),
	}
	const GID = '[A-Za-z0-9%._=-]{1,300}'
	const TIME = '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z'
	const SELECT = '\\$select=[A-Za-z,]{1,200}'
	const RANGE = `startDateTime=${TIME}&endDateTime=${TIME}&\\$top=[0-9]{1,4}&${SELECT}`
	const M = {
		GET: new RegExp(`^me/calendars/${GID}/calendarView\\?${RANGE}(&\\$skip=[0-9]{1,6})?$|^me/calendars/${GID}/events/${GID}\\?${SELECT}$|^me/calendars/${GID}/events/${GID}/instances\\?${RANGE}$`),
		POST: new RegExp(`^me/calendars$|^me/calendars/${GID}/events$`),
		PATCH: new RegExp(`^me/calendars/${GID}/events/${GID}$`),
		DELETE: new RegExp(`^me/calendars/${GID}$|^me/calendars/${GID}/events/${GID}$`),
	}
	const check = (set) => (m, p) => !odd(m, p) && !!set[m] && set[m].test(p)
	/** The calendar a (checked) Graph path is about, decoded; null for making one */
	const graphCalendar = (p) => {
		const m = /^me\/calendars\/([^/?]+)/.exec(p || '')
		if (!m) return null
		try { const id = decodeURIComponent(m[1]); return /^[\x20-\x7e]+$/.test(id) ? id : null } catch (e) { return null }
	}
	return { google: check(G), microsoft: check(M), graphCalendar }
})()

// --- OneDrive and Outlook (Microsoft Graph) ---------------------------------------------------------

const MICROSOFT = {
	authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
	token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
	graph: 'https://graph.microsoft.com/v1.0/',
	files: 'Files.ReadWrite.AppFolder',
	calendar: 'Calendars.ReadWrite',
	// The address registered for the app ("Mobile and desktop": http://localhost, any port)
	host: 'localhost',
	path: '/',
	// The mark on the calendars Blockwise makes
	mark: 'String {5d0c2a3e-8b1f-4f6a-9c47-2e7b3a91d6f4} Name BlockwiseCalendar',
	markValue: 'blockwise',
	// OneDrive hands files out from these hosts (a link that needs no login)
	download: /^https:\/\/[A-Za-z0-9.-]+\.(1drv\.com|sharepoint\.com|onedrive\.com|svc\.ms|live\.net)\/\S*$/,
}
const MS_EVENT_FIELDS = ['subject', 'start', 'end', 'recurrence']

/**
 * Opens Microsoft's login in the browser; you allow Blockwise (OneDrive's app
 * folder; with `calendar`, Outlook too). Returns the refresh token.
 */
function connectMicrosoft({ clientId, fetch, openBrowser, calendar = false, endpoints = MICROSOFT }) {
	if (!clientId) throw new DriveError('This build of Blockwise has no Microsoft client id (mac/config/providers.json).')
	const { verifier, challenge } = oauth().pkce()
	const scope = `offline_access ${endpoints.files}${calendar ? ` ${endpoints.calendar}` : ''}`
	const wait = oauth().waitForCode({
		port: 0,
		host: endpoints.host,
		path: endpoints.path,
		openBrowser,
		authorizeUrl: (redirectUri, state) => `${endpoints.authorize}?${new URLSearchParams({
			client_id: clientId, response_type: 'code', response_mode: 'query', scope, code_challenge: challenge, code_challenge_method: 'S256',
			prompt: 'select_account', redirect_uri: redirectUri, state,
		})}`,
	})
	const result = wait.then(async ({ code, redirectUri }) => {
		const t = await tokenRequest(fetch, endpoints.token, { code, grant_type: 'authorization_code', client_id: clientId, code_verifier: verifier, redirect_uri: redirectUri, scope })
		if (typeof t.refresh_token !== 'string') throw new DriveError('Microsoft did not allow offline access.')
		const granted = ` ${String(t.scope || '').toLowerCase().replace(/https:\/\/graph\.microsoft\.com\//g, '')} `
		if (typeof t.scope === 'string' && !granted.includes(` ${endpoints.files.toLowerCase()} `)) throw new DriveError('Allow Blockwise to use its folder in OneDrive, then try again.')
		return { refreshToken: t.refresh_token, account: null, calendar: calendar && (typeof t.scope !== 'string' || granted.includes(` ${endpoints.calendar.toLowerCase()} `)) }
	})
	result.cancel = wait.cancel
	return result
}

/**
 * OneDrive's app folder as a sync store, and Outlook for the blocks.
 * @param {object} o
 * @param {(token: string) => void} [o.onRotate] keeps the newest refresh token
 * @param {() => boolean} [o.calendar] Outlook was allowed (its tokens ask for it)
 * @param {{has: (id: string) => boolean, add: (id: string) => void, remove: (id: string) => void}} [o.known] calendars known to be Blockwise's
 */
function onedriveStore({ clientId, refreshToken, fetch, onRotate, calendar = () => false, known, endpoints = MICROSOFT }) {
	const tok = tokens({ fetch, refresh: refreshToken, tokenUrl: endpoints.token, onRotate, params: () => ({ client_id: clientId, scope: `offline_access ${endpoints.files}${calendar() ? ` ${endpoints.calendar}` : ''}` }) })
	const root = `${endpoints.graph}me/drive/special/approot`
	const seen = known || (() => { const s = new Set(); return { has: (x) => s.has(x), add: (x) => s.add(x), remove: (x) => s.delete(x) } })()
	const json = async (res) => res.json().catch(() => null)
	/** The folder's files: [{name, eTag}] (the folder is made on first use) */
	async function files() {
		const out = []
		let url = `${root}/children?$select=name,file,eTag&$top=999`
		for (let page = 0; page < 200 && url; page++) {
			const res = await authed(fetch, tok, url)
			const data = await json(res)
			if (!res.ok || !data || !Array.isArray(data.value)) throw new DriveError(`OneDrive could not list the folder (HTTP ${res.status}).`, { status: res.status })
			for (const f of data.value) if (f && f.file && typeof f.name === 'string' && NAME_RE.test(f.name)) out.push({ name: f.name, eTag: String(f.eTag || '') })
			const next = typeof data['@odata.nextLink'] === 'string' ? data['@odata.nextLink'] : ''
			// (the next page: only ever below the folder's fixed address)
			url = next.startsWith(`${root}/children?`) && !next.includes('..') ? next : null
		}
		return out
	}
	async function state() {
		const lines = (await files()).map((f) => `${f.name}\n${f.eTag}`).sort().join('\n\n')
		const g = typeof crypto !== 'undefined' && crypto.subtle ? crypto.subtle : require('node:crypto').webcrypto.subtle
		const h = new Uint8Array(await g.digest('SHA-256', enc.encode(lines)))
		return 'h' + Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('')
	}
	/** Made by Blockwise: known here, or carrying its mark (looked up once) */
	async function blockwise(cal) {
		if (seen.has(cal)) return true
		const q = `$select=id&$expand=${encodeURIComponent(`singleValueExtendedProperties($filter=id eq '${endpoints.mark}')`)}`
		const res = await authed(fetch, tok, `${endpoints.graph}me/calendars/${encodeURIComponent(cal)}?${q}`)
		if (res.status === 404) throw Object.assign(new Error('This calendar is no longer in Outlook.'), { status: 404 })
		const data = await json(res)
		const ok = !!(data && Array.isArray(data.singleValueExtendedProperties) && data.singleValueExtendedProperties.some((p) => p && String(p.id).toLowerCase() === endpoints.mark.toLowerCase() && p.value === endpoints.markValue))
		if (ok) seen.add(cal)
		return ok
	}
	return {
		kind: 'onedrive',
		async list() { return (await files()).map((f) => f.name) },
		async read(name) {
			const res = await authed(fetch, tok, `${root}:/${checkName(name)}?$select=id,@microsoft.graph.downloadUrl`)
			if (res.status === 404) return null
			const data = await json(res)
			const link = data && data['@microsoft.graph.downloadUrl']
			if (!res.ok || typeof link !== 'string' || !endpoints.download.test(link)) throw new DriveError(`OneDrive could not read a file (HTTP ${res.status}).`, { status: res.status })
			// A short-lived link to the file: no login is sent there
			let file
			try { file = await fetch(link, { redirect: 'error' }) } catch (e) { throw new DriveError('No connection to the drive.', { offline: true }) }
			if (file.status === 404) return null
			if (!file.ok) throw new DriveError(`OneDrive could not read a file (HTTP ${file.status}).`, { offline: file.status >= 500, status: file.status })
			return bytesOf(file)
		},
		async write(name, bytes, opts = {}) {
			const res = await authed(fetch, tok, `${root}:/${checkName(name)}:/content?@microsoft.graph.conflictBehavior=${opts.create ? 'fail' : 'replace'}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })
			if (res.status === 409 && opts.create) throw new DriveError('exists', { exists: true })
			if (!res.ok) throw new DriveError(`OneDrive could not save a file (HTTP ${res.status}).`, { status: res.status })
		},
		async remove(name) {
			const res = await authed(fetch, tok, `${root}:/${checkName(name)}`, { method: 'DELETE' })
			if (!res.ok && res.status !== 404) throw new DriveError(`OneDrive could not remove a file (HTTP ${res.status}).`, { status: res.status })
		},
		/** Which OneDrive (its id: no name or e-mail) */
		async account() {
			const res = await authed(fetch, tok, `${endpoints.graph}me/drive?$select=id`)
			const data = await json(res)
			return data && typeof data.id === 'string' ? data.id.replace(/[^\w-]/g, '').slice(0, 64) || null : null
		},
		/** A fingerprint of the folder (names and versions): works for every kind of account */
		changeCursor: () => state(),
		async waitForChanges(cursor, { interval = 20000, sleep, signal } = {}) {
			await (sleep ? sleep(interval) : new Promise((r) => setTimeout(r, interval)))
			if (signal && signal.aborted) throw new DriveError('Stopped.', { aborted: true })
			const now = await state()
			return { changed: now !== cursor, cursor: now, retryAfter: 0 }
		},
		/** (Microsoft has no way to end one app's token: it is forgotten) */
		async revoke() {},
		/** Outlook: only what guard.microsoft allows, only Blockwise's calendars, only a title, times and a repeat */
		async calendar(method, path, body) {
			if (!calendar() || !guard.microsoft(method, path) || (body != null && (typeof body !== 'object' || Array.isArray(body)))) throw Object.assign(new Error('Invalid request.'), { status: 400 })
			const making = method === 'POST' && path === 'me/calendars'
			let out
			if (body != null) {
				out = {}
				for (const f of making ? ['name', 'color'] : MS_EVENT_FIELDS) {
					if (!(f in body)) continue
					const v = body[f]
					if (f === 'start' || f === 'end') { if (v && typeof v === 'object') out[f] = { dateTime: String(v.dateTime || ''), timeZone: String(v.timeZone || '') } } else if (f === 'recurrence') out[f] = v && typeof v === 'object' && !Array.isArray(v) ? v : null
					else if (typeof v === 'string') out[f] = v
				}
				// Blockwise's mark: the calendar can be used from any device
				if (making) out.singleValueExtendedProperties = [{ id: endpoints.mark, value: endpoints.markValue }]
			}
			if (!making) {
				const cal = guard.graphCalendar(path)
				if (!cal || !(await blockwise(cal).catch((e) => { throw Object.assign(new Error(e.message), { status: e.offline ? 0 : e.status || 0 }) }))) throw Object.assign(new Error('Blockwise only uses the calendars it made.'), { status: 403 })
			}
			const data = await calendarCall(fetch, tok, endpoints.graph, method, path, out, 'Outlook')
			if (making && data && typeof data.id === 'string' && data.id.length <= 300) seen.add(data.id)
			if (method === 'DELETE' && /^me\/calendars\/[^/]+$/.test(path)) seen.remove(guard.graphCalendar(path))
			return data
		},
	}
}

return { connectDropbox, dropboxStore, connectGoogle, googleStore, connectMicrosoft, onedriveStore, guard, tokenRequest, dropboxArg, DriveError, DROPBOX, GOOGLE, MICROSOFT }
})
