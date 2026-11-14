/*
 * Blockwise in the browser: what the phone app's Java side does, done by the
 * page itself, so the same interface (android-bridge.js, setup.js, tracker.js)
 * runs here unchanged. There is no Blockwise server: the data stays in this
 * browser, and syncs only through your own Dropbox, end to end
 * encrypted unless you chose otherwise (filesync.js).
 *
 * - Storage: IndexedDB, every value encrypted with AES-GCM under a key the
 *   browser generated and keeps non-extractable (a script can use it, never
 *   read it out). Clearing the site's data in the browser removes everything.
 * - Dropbox: you log in on Dropbox's page (OAuth with PKCE, no app secret);
 *   Dropbox sends you back here with a one-time code, checked against a random
 *   state kept for this tab only. Only the refresh token is kept, encrypted as
 *   above. (Google Drive needs an app secret, or a new login every hour, in a
 *   page with no server: the browser offers Dropbox; the Mac and phone apps both.)
 * - Requests go only to the providers' fixed addresses (the page's Content
 *   Security Policy allows nothing else).
 *
 * Answers go back the way the Java side answers: window.__trackerAndroid.resolve(id, envelopeJson).
 */
;(function () {
	'use strict'
	window.__trackerWeb = true
	const P = window.__blockwiseProviders || {}
	const D = () => window.BlockwiseDrives
	const APP = new URL('./', location.href)
	const REDIRECT = new URL('setup.html', APP).href
	// Which page an address is. Hosts with "pretty URLs" (Cloudflare Pages, Netlify)
	// serve setup.html at /app/setup and redirect setup.html there: both are the setup page.
	const pageOf = (pathname) => (/\/setup(\.html)?$/.test(pathname) ? 'setup' : 'app')
	const ON_SETUP = pageOf(location.pathname) === 'setup'
	const NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$/
	const enc = new TextEncoder()
	const dec = new TextDecoder()
	const b64 = (u8) => { let x = ''; for (let i = 0; i < u8.length; i += 0x8000) x += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(x) }
	const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
	const b64url = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
	const it = (navigator.language || 'en').toLowerCase().startsWith('it')
	const T = (en, itText) => (it ? itText : en)

	// --- storage: IndexedDB, encrypted --------------------------------------------------------

	let dbp = null
	function idb() {
		if (!dbp) {
			dbp = new Promise((resolve, reject) => {
				const req = indexedDB.open('blockwise', 1)
				req.onupgradeneeded = () => req.result.createObjectStore('kv')
				req.onsuccess = () => resolve(req.result)
				req.onerror = () => reject(new Error(T('This browser does not let Blockwise store data (private window?).', 'Questo browser non permette a Blockwise di salvare dati (finestra privata?).')))
			})
		}
		return dbp
	}
	async function tx(mode, fn) {
		const db = await idb()
		return new Promise((resolve, reject) => {
			const t = db.transaction('kv', mode)
			const r = fn(t.objectStore('kv'))
			t.oncomplete = () => resolve(r && r.result)
			t.onerror = t.onabort = () => reject(t.error || new Error('Storage error'))
		})
	}
	const rawGet = (k) => tx('readonly', (s) => s.get(k))
	const rawSet = (k, v) => tx('readwrite', (s) => (v === undefined || v === null ? s.delete(k) : s.put(v, k)))
	let keyp = null
	function key() {
		if (!keyp) {
			keyp = (async () => {
				let k = await rawGet('key')
				if (!k) {
					k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
					await rawSet('key', k)
				}
				return k
			})()
			keyp.catch(() => { keyp = null })
		}
		return keyp
	}
	async function put(name, text) {
		if (text === null || text === undefined) return rawSet('v:' + name, null)
		const iv = crypto.getRandomValues(new Uint8Array(12))
		const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(name) }, await key(), enc.encode(String(text)))
		return rawSet('v:' + name, { iv, data })
	}
	async function get(name) {
		const v = await rawGet('v:' + name)
		if (!v) return null
		try {
			return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: v.iv, additionalData: enc.encode(name) }, await key(), v.data))
		} catch (e) {
			return null // the key is gone (site data partly cleared): as if empty
		}
	}
	const plainGet = (k) => rawGet('p:' + k)
	const plainSet = (k, v) => rawSet('p:' + k, v)
	async function wipe() {
		for (const n of ['db', 'drivestate', 'driveToken', 'syncKey']) await put(n, null)
		for (const k of ['mode', 'owner', 'resend', 'account']) await plainSet(k, null)
	}

	// One tab at a time: two would each keep their own copy and overwrite each other's changes
	let lockp = null
	function onlyTab() {
		if (!lockp) {
			lockp = new Promise((resolve) => {
				if (!navigator.locks) { resolve(); return }
				navigator.locks.request('blockwise', { ifAvailable: true }, (lock) => {
					if (!lock) { otherTab(); return } // never resolves: this tab stays out of the data
					resolve()
					return new Promise(() => {}) // held while this tab is open
				})
			})
		}
		return lockp
	}
	function otherTab() {
		const show = () => {
			document.body.replaceChildren(el('main', { class: 'w-other' },
				el('h1', null, T('Blockwise is open in another tab', 'Blockwise è aperto in un\'altra scheda')),
				el('p', null, T('Use that tab, or close it and reload this one.', 'Usa quella scheda, oppure chiudila e ricarica questa.')),
				el('button', { type: 'button', class: 'w-btn w-btn--accent', onclick: () => location.reload() }, T('Reload', 'Ricarica'))))
		}
		if (document.body) show()
		else document.addEventListener('DOMContentLoaded', show)
	}

	// --- Dropbox ---------------------------------------------------------------

	const available = (p) => p === 'dropbox' && /^[a-z0-9]{8,32}$/.test(P.dropboxAppKey || '')
	const folderOf = (refreshToken) => D().dropboxStore({ appKey: P.dropboxAppKey, refreshToken, fetch: (u, o) => fetch(u, o) })
	let pending = null // { provider, refreshToken, account, folder } after the login, before the passphrase
	let saved = null
	async function folder() {
		if (pending) return pending.folder
		const mode = await plainGet('mode')
		if (mode !== 'dropbox') return null
		if (!saved) {
			const tok = await get('driveToken')
			if (!tok) return null
			saved = { mode, folder: folderOf(tok) }
		}
		return saved.folder
	}

	/** To Dropbox: the page leaves; it comes back to setup.html with a code */
	async function startLogin(provider) {
		if (!available(provider)) throw new Error(T('This copy of Blockwise can\'t connect to that drive.', 'Questa copia di Blockwise non può collegarsi a quel drive.'))
		const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
		const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))))
		const state = b64url(crypto.getRandomValues(new Uint8Array(24)))
		// For this tab only, and only until it comes back
		sessionStorage.setItem('blockwise.login', JSON.stringify({ provider, verifier, state, at: Date.now() }))
		const q = { client_id: P.dropboxAppKey, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline', redirect_uri: REDIRECT, state }
		location.assign(`${D().DROPBOX.authorize}?${new URLSearchParams(q)}`)
		return new Promise(() => {}) // the page is leaving
	}

	/** Back from the provider (setup.html?code=…&state=…): the code for a refresh token */
	let loginDone = null
	function finishLogin() {
		if (loginDone) return loginDone
		loginDone = (async () => {
			const url = new URL(location.href)
			const code = url.searchParams.get('code')
			const state = url.searchParams.get('state')
			const error = url.searchParams.get('error')
			if (!code && !error) return null
			// The code and state leave the address bar (and the history) at once
			history.replaceState(null, '', url.pathname + (url.hash || ''))
			let saved = null
			try { saved = JSON.parse(sessionStorage.getItem('blockwise.login') || 'null') } catch (e) { /* none */ }
			sessionStorage.removeItem('blockwise.login')
			if (!saved || !state || state !== saved.state || Date.now() - saved.at > 15 * 60000) return { error: T('That login was not started here. Try again.', 'Quell\'accesso non è partito da qui. Riprova.') }
			if (error) return { error: T('The connection was not allowed.', 'Il collegamento non è stato autorizzato.') }
			if (saved.provider !== 'dropbox' || !available('dropbox')) return { error: T('That login was not started here. Try again.', 'Quell\'accesso non è partito da qui. Riprova.') }
			const t = await D().tokenRequest((u, o) => fetch(u, o), D().DROPBOX.token, { code, grant_type: 'authorization_code', client_id: P.dropboxAppKey, code_verifier: saved.verifier, redirect_uri: REDIRECT })
			if (typeof t.refresh_token !== 'string') return { error: T('Dropbox did not allow offline access.', 'Dropbox non ha consentito l\'accesso offline.') }
			const account = typeof t.account_id === 'string' ? t.account_id.replace(/[^\w:-]/g, '').slice(0, 64) : null
			pending = { provider: 'dropbox', refreshToken: t.refresh_token, account, folder: folderOf(t.refresh_token) }
			return { provider: 'dropbox' }
		})().catch((e) => ({ error: e.message }))
		return loginDone
	}

	// --- the channels (what the phone's Java side answers) -------------------------------------

	/** To another page; to this one again: reloaded (the bridge reads the mode once) */
	const go = (path) => {
		const u = new URL(path, APP)
		if (pageOf(u.pathname) === pageOf(location.pathname)) { history.replaceState(null, '', location.pathname + u.hash); location.reload() } else location.assign(u.href)
		return new Promise(() => {})
	}
	const handlers = {
		async state() {
			const mode = (await plainGet('mode')) || null
			const login = ON_SETUP ? await finishLogin() : null
			return {
				platform: 'web',
				locale: navigator.language || 'en',
				mode,
				connecting: location.hash === '#connect',
				nextcloud: false,
				drives: { dropbox: available('dropbox'), gdrive: false, onedrive: false },
				pendingDrive: login && login.provider ? login.provider : null,
				driveError: login && login.error ? login.error : null,
			}
		},
		dbLoad: async () => { await onlyTab(); return get('db') },
		dbSave: async (json) => { await onlyTab(); return put('db', json) },
		snapshot: () => null,
		outbox: () => [],
		outboxDone: () => null,
		refresh: () => null,
		calendarAccess: () => false,
		calendars: () => [],
		events: () => [],
		async takeResend() {
			const r = !!(await plainGet('resend'))
			if (r) await plainSet('resend', null)
			return r
		},
		async useLocal() {
			await plainSet('mode', 'local')
			if (!(await plainGet('owner'))) await plainSet('owner', 'local')
			return go('./#now')
		},
		connect: () => go('setup.html#connect'),
		backToApp: () => go('./#now'),
		connectDrive: (provider) => startLogin(String(provider)),
		async cancelDrive() {
			const p = pending
			pending = null
			if (p) await p.folder.revoke().catch(() => {})
			return null
		},
		async saveDrive(keyB64) {
			if (!pending) throw new Error(T('Connect a drive first.', 'Collega prima un drive.'))
			if (!/^[A-Za-z0-9+/]{43}=$/.test(keyB64)) throw new Error('Invalid request.')
			const who = `${pending.provider}:${pending.account || ''}`
			const owner = await plainGet('owner')
			// From "only in this browser" the data comes along; another account starts empty
			const carry = owner === 'local'
			if (owner && owner !== who && !carry) await wipe()
			await put('driveToken', pending.refreshToken)
			await put('syncKey', keyB64)
			await put('drivestate', null)
			await plainSet('mode', pending.provider)
			await plainSet('owner', who)
			await plainSet('resend', carry)
			pending = null
			return go('./#now')
		},
		async drive(op, name, data, create) {
			const f = await folder()
			if (!f) throw new Error(T('Connect a drive first.', 'Collega prima un drive.'))
			if (op === 'list') return f.list()
			if (!NAME_RE.test(name || '')) throw new Error('Invalid file name')
			if (op === 'read') { const bytes = await f.read(name); return bytes ? b64(bytes) : null }
			if (op === 'write') {
				try { await f.write(name, unb64(String(data || '')), { create: !!create }) } catch (e) { if (e.exists) throw Object.assign(new Error('exists'), { status: 409 }); throw e }
				return null
			}
			if (op === 'remove') { await f.remove(name); return null }
			throw new Error('Invalid request.')
		},
		async driveWatch(op, cursor, seconds) {
			const f = await folder()
			if (!f) throw new Error(T('Connect a drive first.', 'Collega prima un drive.'))
			if (op === 'cursor') return f.changeCursor()
			try {
				// Dropbox: waits for a change; Google Drive: one look now (the page waits between looks)
				return await f.waitForChanges(String(cursor), { timeout: Math.max(30, Number(seconds) || 90), interval: 0, sleep: () => Promise.resolve() })
			} catch (e) {
				if (e.reset) throw Object.assign(new Error(e.message), { status: 409 })
				throw e
			}
		},
		async driveKey() { return (await plainGet('mode')) === 'dropbox' ? get('syncKey') : null },
		driveStateLoad: () => get('drivestate'),
		async driveStateSave(json) {
			if (typeof json !== 'string' || json.length > 1024 * 1024 || json[0] !== '{') throw new Error('Invalid request.')
			return put('drivestate', json)
		},
		account: () => { accountSheet(); return null },
		login: () => { throw new Error(T('Nextcloud is not available in the browser: use Blockwise inside your Nextcloud.', 'Nextcloud non è disponibile nel browser: usa Blockwise dentro il tuo Nextcloud.')) },
		cancelLogin: () => null,
		openCalendar: () => null,
		createEvent: () => { throw new Error('Not available.') },
		remote: () => { throw new Error('Not available.') },
	}

	window.TrackerAndroid = {
		call(id, channel, argsJson) {
			const h = Object.prototype.hasOwnProperty.call(handlers, channel) ? handlers[channel] : null
			let args = []
			try { args = JSON.parse(argsJson) || [] } catch (e) { /* none */ }
			Promise.resolve()
				.then(() => { if (!h) throw new Error('Not available.'); return h(...args) })
				.then((data) => ({ data: data === undefined ? null : data }), (e) => ({ error: (e && e.message) || 'Error', status: (e && e.status) || 0 }))
				.then((env) => { if (window.__trackerAndroid) window.__trackerAndroid.resolve(id, JSON.stringify(env)) })
		},
	}

	// --- the account sheet (the phone app's native dialog, as a page dialog) -------------------

	function el(tag, attrs, ...kids) {
		const e = document.createElement(tag)
		for (const [k, v] of Object.entries(attrs || {})) {
			if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
			else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v)
		}
		for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c)
		return e
	}

	async function accountSheet() {
		const mode = await plainGet('mode')
		const name = mode === 'dropbox' ? 'Dropbox' : null
		const dlg = el('dialog', { class: 'w-sheet', 'aria-labelledby': 'w-sheet-title' })
		const close = () => { dlg.close(); dlg.remove() }
		const confirmThen = (text, label, fn) => {
			body.replaceChildren(el('p', null, text),
				el('div', { class: 'w-sheet__row' },
					el('button', { type: 'button', class: 'w-btn', onclick: close }, T('Cancel', 'Annulla')),
					el('button', { type: 'button', class: 'w-btn w-btn--danger', onclick: fn }, label)))
		}
		// Backups are made in Settings → Your data, the same file on every platform
		const backup = () => { close(); location.hash = '#settings'; setTimeout(() => { const s = document.querySelector('.imp-backup'); if (s) s.scrollIntoView({ block: 'start' }) }, 300) }
		const stopSync = async (keep) => {
			const f = await folder().catch(() => null)
			if (f) await f.revoke().catch(() => {})
			saved = null
			await put('driveToken', null); await put('syncKey', null); await put('drivestate', null)
			if (keep) { await plainSet('mode', 'local'); await plainSet('owner', 'local'); go('./#now') }
			else { await wipe(); go('setup.html') }
		}
		const body = el('div', { class: 'w-sheet__body' },
			el('p', { class: 'w-muted' }, name
				? T(`Synced with ${name}. Your data is also kept in this browser.`, `Sincronizzato con ${name}. I tuoi dati restano anche in questo browser.`)
				: available('dropbox')
					? T('Nothing is synced. Clearing this site\'s data in the browser deletes it, so make a backup now and then, or set up a sync.', 'Niente è sincronizzato. Cancellare i dati di questo sito nel browser li elimina: fai un backup ogni tanto, o attiva una sincronizzazione.')
					: T('Nothing is synced. Clearing this site\'s data in the browser deletes it, so make a backup now and then.', 'Niente è sincronizzato. Cancellare i dati di questo sito nel browser li elimina: fai un backup ogni tanto.')),
			el('div', { class: 'w-sheet__list' },
				name || !available('dropbox') ? null : el('button', { type: 'button', class: 'w-btn w-btn--accent', onclick: () => go('setup.html#connect') }, T('Set up sync', 'Attiva la sincronizzazione')),
				el('button', { type: 'button', class: 'w-btn', onclick: backup }, T('Back up or import your data', 'Backup o importazione dei dati')),
				name ? el('button', { type: 'button', class: 'w-btn', onclick: () => confirmThen(T(`Stop syncing with ${name}? This browser forgets the drive and your passphrase; the encrypted data on the drive stays.`, `Interrompere la sincronizzazione con ${name}? Questo browser dimentica il drive e la passphrase; i dati cifrati sul drive restano.`), T('Stop, keep my data here', 'Interrompi, tieni i dati qui'), () => stopSync(true)) }, T('Stop syncing', 'Interrompi la sincronizzazione')) : null,
				el('button', { type: 'button', class: 'w-btn w-btn--danger', onclick: () => confirmThen(name
					? T(`Remove everything from this browser? It stays in ${name}.`, `Rimuovere tutto da questo browser? Resta su ${name}.`)
					: T('Remove everything from this browser? This can\'t be undone.', 'Rimuovere tutto da questo browser? Non si può annullare.'), T('Remove', 'Rimuovi'), () => stopSync(false)) }, T('Remove from this browser', 'Rimuovi da questo browser'))))
		dlg.append(el('header', { class: 'w-sheet__head' },
			el('h2', { id: 'w-sheet-title' }, name ? T(`Synced with ${name}`, `Sincronizzato con ${name}`) : T('Only in this browser', 'Solo in questo browser')),
			el('button', { type: 'button', class: 'w-close', 'aria-label': T('Close', 'Chiudi'), onclick: close }, '×')), body)
		dlg.addEventListener('cancel', (e) => { e.preventDefault(); close() })
		document.body.append(dlg)
		dlg.showModal()
	}

	// Before the first start: to the setup page
	if (!ON_SETUP) {
		plainGet('mode').then((m) => { if (!m) location.replace(new URL('setup.html', APP).href) }).catch(() => {})
	}
})()
