/**
 * Dropbox and Google Drive as sync folders (see nextcloud/js/filesync.js).
 *
 * - Dropbox: an "App folder" app, so Blockwise only ever sees Apps/Blockwise.
 * - Google Drive: the hidden app data folder (scope drive.appdata), so Blockwise
 *   can't see or change any of your other files, and they can't see its files.
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
function tokens({ fetch, refresh, tokenUrl, params, now = () => Date.now() }) {
	let access = null
	let until = 0
	return {
		async get(force = false) {
			if (!force && access && now() < until - 60000) return access
			const t = await tokenRequest(fetch, tokenUrl, { ...params, grant_type: 'refresh_token', refresh_token: refresh })
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
			client_id: clientId, response_type: 'code', scope: endpoints.scope, code_challenge: challenge, code_challenge_method: 'S256',
			access_type: 'offline', prompt: 'consent', redirect_uri: redirectUri, state,
		})}`,
	})
	const result = wait.then(async ({ code, redirectUri }) => {
		// Google's "client secret" for desktop apps is not secret (it ships in every copy); PKCE protects the code
		const t = await tokenRequest(fetch, endpoints.token, { code, grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret || '', code_verifier: verifier, redirect_uri: redirectUri })
		if (typeof t.refresh_token !== 'string') throw new DriveError('Google did not allow offline access.')
		if (typeof t.scope === 'string' && !t.scope.split(' ').includes(endpoints.scope)) throw new DriveError('Allow Blockwise to use its app data in Google Drive, then try again.')
		return { refreshToken: t.refresh_token, account: null }
	})
	result.cancel = wait.cancel
	return result
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
		async revoke() {
			try {
				// The refresh token itself: that ends the connection (in the body, not in the URL)
				await fetch(endpoints.revoke, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken }).toString() })
			} catch (e) { /* offline: forget it anyway */ }
		},
	}
}

return { connectDropbox, dropboxStore, connectGoogle, googleStore, tokenRequest, dropboxArg, DriveError, DROPBOX, GOOGLE }
})
