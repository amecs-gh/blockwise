/*
 * window.trackerApp for the Android app: the same interface the Mac app's
 * preload gives its windows (so setup.js and nextcloud-shim.js are shared),
 * implemented over the app's Java bridge (window.TrackerAndroid).
 *
 * Blockwise runs here, on the phone (local-first): the interface's API requests
 * go to the engine (web/engine.js), which keeps your data on the phone
 * (encrypted by the app). On this phone only, blocks live in the built-in
 * calendar and nothing is synced; with Nextcloud, blocks come from the phone's
 * calendars and the data syncs whenever it can.
 *
 * Every call goes through TrackerAndroid.call(id, channel, argsJson); the app
 * answers with window.__trackerAndroid.resolve(id, envelopeJson), where the
 * envelope is {"data": ...} or {"error": "...", "status": n}.
 */
;(function () {
	'use strict'
	const native = window.TrackerAndroid
	// In the background sync (sync.html): no watching, no prompts, no timers
	const background = window.__trackerBackground === true
	const pending = new Map()
	const listeners = { state: [], changed: [], loading: [] }
	let next = 1

	function call(channel, ...args) {
		return new Promise((resolve, reject) => {
			if (!native) { reject(new Error('Not available.')); return }
			const id = String(next++)
			pending.set(id, { resolve, reject })
			try {
				native.call(id, channel, JSON.stringify(args))
			} catch (e) {
				pending.delete(id)
				reject(e)
			}
		})
	}

	window.__trackerAndroid = {
		resolve(id, envelopeJson) {
			const p = pending.get(id)
			if (!p) return
			pending.delete(id)
			let env
			try { env = JSON.parse(envelopeJson) } catch (e) { p.reject(new Error('Invalid answer.')); return }
			if (env && env.error) {
				const err = new Error(env.error)
				err.status = env.status
				p.reject(err)
			} else {
				p.resolve(env ? env.data : undefined)
			}
		},
		emit(channel, payloadJson) {
			let payload
			try { payload = payloadJson ? JSON.parse(payloadJson) : undefined } catch (e) { return }
			// Back in the app, Stop in the notification, a change on another device: sync first
			if (channel === 'changed') { syncNow(true); return }
			fire(channel, payload)
		},
	}

	/*
	 * Called by the app when the page has loaded (and when something changes):
	 * light/dark and the space taken by the status bar, notch and gesture bar, in CSS pixels.
	 */
	window.__trackerAndroidTheme = function (theme) {
		const root = document.documentElement
		root.classList.add('m3')
		// Light or dark as chosen in Settings, else the phone's
		let pick = 'system'
		try { pick = localStorage.getItem('tracker.theme') || 'system' } catch (e) { /* no storage */ }
		root.classList.toggle('m3-dark', pick === 'dark' || (pick !== 'light' && !!theme.dark))
		for (const [k, v] of Object.entries(theme.insets || {})) {
			if (typeof v === 'number' && isFinite(v)) root.style.setProperty('--inset-' + k, Math.max(0, Math.round(v)) + 'px')
		}
	}
	document.documentElement.classList.add('m3')
	let pick = 'system'
	try { pick = localStorage.getItem('tracker.theme') || 'system' } catch (e) { /* no storage */ }
	if (pick === 'dark' || (pick !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('m3-dark')

	function fire(channel, payload) {
		for (const cb of listeners[channel] || []) {
			try { cb(payload) } catch (e) { console.error(e) }
		}
	}

	// --- the engine ------------------------------------------------------------------------

	const remote = (method, path, body) => call('remote', method, path, body === undefined ? null : body)
	const DAV = '/remote.php/dav/calendars/'
	/** "/remote.php/dav/calendars/<user>/<calendar>/", decoded: to compare addresses */
	const calPath = (u) => {
		const at = typeof u === 'string' ? u.indexOf(DAV) : -1
		if (at < 0) return null
		const parts = u.slice(at + DAV.length).replace(/\/$/, '').split('/')
		if (parts.length !== 2) return null
		try { return parts.map(decodeURIComponent).join('/') } catch (e) { return null }
	}
	const samePath = (a, b) => calPath(a) !== null && calPath(a) === calPath(b)
	// Same as PHP's rawurlencode: how the server writes calendar addresses
	const rawurlencode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
	const serverForm = (u) => { const p = calPath(u); return p === null ? null : DAV + p.split('/').map(rawurlencode).join('/') + '/' }

	let phoneCals = []
	// The server's calendars and blocks, kept from the last answer: a page never waits for
	// Nextcloud (it can be slow). What is missing or old is asked for in the background; the
	// page shows placeholders meanwhile (loading()) and is drawn again when the answer comes.
	let serverCals = null
	let serverCalsAt = 0
	let serverCalsAsk = null
	const serverBlocks = new Map() // "from-to" -> {at, list}
	const blockAsks = new Map()
	const FRESH = 120000
	let asking = 0
	const asked = (d) => { asking += d; fire('loading', asking > 0) }
	function askServerCalendars() {
		if (serverCalsAsk) return serverCalsAsk
		asked(1)
		serverCalsAsk = remote('GET', 'state').then((st) => {
			const next = (st.calendars || []).map((c) => ({ id: c.id, url: c.url, name: c.name, color: c.color }))
			const changed = serverCals !== null && JSON.stringify(next) !== JSON.stringify(serverCals)
			serverCals = next
			serverCalsAt = Date.now()
			if (changed) fire('changed')
		}).catch(() => { /* offline */ }).finally(() => { serverCalsAsk = null; asked(-1) })
		return serverCalsAsk
	}
	function askServerBlocks(from, to) {
		const key = `${Math.floor(from)}-${Math.ceil(to)}`
		if (blockAsks.has(key)) return blockAsks.get(key)
		asked(1)
		const p = remote('GET', `blocks?from=${Math.floor(from)}&to=${Math.ceil(to)}`).then(({ blocks }) => {
			const before = serverBlocks.get(key)
			serverBlocks.set(key, { at: Date.now(), list: blocks || [] })
			if (serverBlocks.size > 40) serverBlocks.delete(serverBlocks.keys().next().value)
			if (!before || JSON.stringify(before.list) !== JSON.stringify(blocks || [])) fire('changed')
		}).catch(() => { /* offline */ }).finally(() => { blockAsks.delete(key); asked(-1) })
		blockAsks.set(key, p)
		return p
	}
	const calendar = {
		/** The phone's Nextcloud calendars (offline too), plus the server's others as last known */
		async calendars() {
			phoneCals = (await call('calendars').catch(() => [])) || []
			// Nothing known yet and nothing on the phone either (first start): wait for the server, briefly
			if (serverCals === null && !phoneCals.length) await Promise.race([askServerCalendars(), new Promise((r) => setTimeout(r, 4000))])
			else if (serverCals === null) askServerCalendars()
			else if (Date.now() - serverCalsAt > FRESH) askServerCalendars()
			const out = phoneCals.map((c) => ({ url: serverForm(c.url), name: c.name, color: c.color })).filter((c) => c.url)
			for (const c of serverCals || []) if (!out.some((p) => samePath(p.url, c.url))) out.push({ url: c.url, name: c.name, color: c.color })
			return out
		},
		/** Blocks from the phone's calendars; for calendars the phone doesn't have, the server's as last known */
		async events(from, to, urls) {
			const onPhone = urls.filter((u) => phoneCals.some((p) => samePath(p.url, u)))
			const rest = urls.filter((u) => !onPhone.includes(u))
			let incomplete = false
			const out = onPhone.length ? ((await call('events', from, to, onPhone).catch(() => { incomplete = true; return [] })) || []) : []
			if (rest.length) {
				const known = serverBlocks.get(`${Math.floor(from)}-${Math.ceil(to)}`)
				if (!known || Date.now() - known.at > FRESH) askServerBlocks(from, to)
				if (!known || !serverCals) incomplete = true
				for (const b of (known && known.list) || []) {
					const cal = (serverCals || []).find((c) => c.id === b.calendarId)
					const url = cal && rest.find((u) => samePath(u, cal.url))
					if (url) out.push({ uid: b.uid, title: b.title, start: b.start, end: b.end, url })
				}
			}
			// Some blocks may be missing: the engine shows what it has, but doesn't count blocks as ended
			if (incomplete) out.incomplete = true
			return out
		},
		/** A new block in the commitment's calendar on the phone (DAVx5 uploads it) */
		createEvent: (ev) => call('createEvent', ev),
		/** Move or change one in the phone's calendar (this / future / all; `url`: another commitment's calendar) */
		updateEvent: (series, occurrence, ch) => call('updateEvent', series, occurrence, ch),
		deleteEvent: (series, occurrence, scope) => call('deleteEvent', series, occurrence, scope),
	}

	/** The drive's folder through the app (it holds the login); bytes as base64 over the bridge */
	const b64 = (u8) => { let x = ''; for (let i = 0; i < u8.length; i += 0x8000) x += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(x) }
	const driveStore = {
		list: () => call('drive', 'list', '', '', false),
		read: async (name) => { const d = await call('drive', 'read', name, '', false); return d ? Uint8Array.from(atob(d), (c) => c.charCodeAt(0)) : null },
		write: async (name, bytes, opts = {}) => {
			try {
				await call('drive', 'write', name, b64(bytes), !!opts.create)
			} catch (e) {
				if (e.status === 409) throw Object.assign(new Error('exists'), { exists: true })
				throw e
			}
		},
		remove: (name) => call('drive', 'remove', name, '', false),
		// Watching for other devices' changes (FileSync.watch)
		changeCursor: () => call('driveWatch', 'cursor'),
		async waitForChanges(cursor, { interval, sleep }) {
			// Google Drive: a look every interval; Dropbox: the app waits for Dropbox's answer
			if (mode !== 'dropbox') await sleep(interval)
			try {
				return await call('driveWatch', 'changes', cursor, 90)
			} catch (e) {
				if (e.status === 409) throw Object.assign(new Error(e.message), { reset: true })
				throw e
			}
		},
	}
	let watcher = null
	/** While the app is in front: sync as soon as another device writes to the drive */
	function watchDrive() {
		if (background || watcher || (mode !== 'dropbox' && mode !== 'gdrive') || document.visibilityState !== 'visible') return
		watcher = window.BlockwiseFileSync.watch(driveStore, () => syncNow(false), { interval: () => 20000 })
	}
	function unwatchDrive() {
		if (watcher) watcher.stop()
		watcher = null
	}

	let enginePromise = null
	let mode = null // 'local' (on this phone only), 'nextcloud', 'dropbox' or 'gdrive'
	let local = false // no Nextcloud: the built-in calendar (on this phone only, or a drive)
	let driveSync = null // the drive's file sync (web/filesync.js), once opened
	let snapshotTimer = null
	let syncTimer = null
	let syncing = null
	function engine() {
		if (!enginePromise) {
			enginePromise = call('state').then((st) => {
				mode = st.mode
				local = mode !== 'nextcloud'
				return create()
			})
			// Could not open the data (e.g. the Keystore was busy): try again on the next request
			enginePromise.catch(() => { enginePromise = null; firstSync = null })
		}
		return enginePromise
	}
	async function create() {
		const e = await window.TrackerEngine.createEngine({
			storage: {
				load: async () => { const t = await call('dbLoad'); return t ? JSON.parse(t) : null },
				save: (db) => call('dbSave', JSON.stringify(db)),
			},
			remote: mode === 'nextcloud' ? {
				pull: (since, limit) => remote('GET', `sync?since=${since}&limit=${limit}`),
				push: (records) => remote('POST', 'sync', { records }),
				// Blocks planned on this phone only stay here (Nextcloud has real calendars)
				localTypes: ['block'],
			} : mode === 'local' ? null : {
				// Dropbox / Google Drive: end-to-end encrypted files (opened below)
				pull: async (since, limit) => (await openDrive()).pull(since, limit),
				push: async (records) => (await openDrive()).push(records),
			},
			calendar: local ? { kind: 'builtin' } : calendar,
			// A change here: send it soon. After a sync: only update the notification.
			onChange: (db, info) => { snapshotSoon(); if (mode !== 'local' && !(info && info.sync)) syncSoon(3000) },
		})
		engineNode = e.node()
		setTimeout(watchDrive, 0)
		// Just connected a sync after using the phone only: everything goes up
		if (mode !== 'local' && await call('takeResend').catch(() => false)) await e.resendAll()
		return e
	}
	let engineNode = null
	/** The drive's file sync, with the key kept (encrypted) by the app */
	function openDrive() {
		if (!driveSync) {
			driveSync = (async () => {
				const key = await call('driveKey')
				if (!key) throw new Error('Connect a drive first.')
				return window.BlockwiseFileSync.createRemote({
					store: driveStore,
					key: Uint8Array.from(atob(key), (c) => c.charCodeAt(0)),
					node: engineNode,
					state: {
						load: async () => JSON.parse((await call('driveStateLoad')) || 'null'),
						save: (st) => call('driveStateSave', JSON.stringify(st)),
					},
				})
			})()
			driveSync.catch(() => { driveSync = null })
		}
		return driveSync
	}
	function snapshotSoon() {
		clearTimeout(snapshotTimer)
		snapshotTimer = setTimeout(async () => {
			try {
				const e = await engine()
				const snap = e.snapshot()
				if (local) {
					// The notification's blocks: the built-in calendar's, from yesterday to two weeks ahead
					const now = Math.floor(Date.now() / 1000)
					const { blocks } = await e.api('GET', `blocks?from=${now - 86400}&to=${now + 14 * 86400}`)
					snap.blocks = (blocks || []).slice(0, 2000).map((b) => ({ uid: b.uid, title: b.title || '', start: b.start, end: b.end, commitmentId: b.commitmentId }))
				}
				await call('snapshot', snap)
			} catch (e) { /* next change */ }
		}, 300)
	}
	function syncSoon(ms) {
		clearTimeout(syncTimer)
		syncTimer = setTimeout(() => syncNow(false), ms)
	}
	/** Changes made from the notification, then push and pull. `always`: tell the page even if nothing came in. */
	function syncNow(always) {
		if (syncing) return syncing
		syncing = (async () => {
			let pulled = 0
			try {
				const e = await engine()
				const box = await call('outbox').catch(() => [])
				if (box && box.length) { e.importLocal(box); await call('outboxDone', box); always = true }
				if (mode === 'local') { snapshotSoon(); if (always) fire('changed'); return }
				const r = await e.sync()
				pulled = r.pulled || 0
				if (r.refused && r.refused.length) {
					// Changes the server refused were undone here: say so (once per sync)
					const reasons = [...new Set(r.refused.map((x) => x.reason))].join(' · ')
					const it = /^it\b/i.test(navigator.language || '')
					const msg = /clock is too far ahead/.test(reasons)
						? (it ? 'Data e ora del telefono sembrano sbagliate: alcune modifiche non sono state sincronizzate. Controlla le impostazioni di data e ora.' : 'Your phone\'s date and time look wrong, so some changes could not be synced. Check the date and time settings.')
						: (it ? 'Alcune modifiche non sono state sincronizzate e sono state annullate: ' : 'Some changes could not be synced and were undone: ') + reasons
					try { window.OC.Notification.showTemporary(msg, { type: 'error' }) } catch (x) { /* no page */ }
					always = true
				}
			} catch (err) { /* offline: the changes wait */ }
			snapshotSoon()
			if (always || pulled) fire('changed')
		})().finally(() => { syncing = null })
		return syncing
	}
	// Before the first sync on this phone there is nothing to show: wait for it (briefly)
	let firstSync = null
	function ready() {
		if (!firstSync) {
			firstSync = engine().then((e) => {
				if (mode === 'local') { snapshotSoon(); return }
				if (e.lastSync()) { syncSoon(500); return }
				return Promise.race([syncNow(false), new Promise((r) => setTimeout(r, 20000))])
			}).catch(() => {})
		}
		return firstSync
	}
	if (!background) setInterval(() => { if (document.visibilityState === 'visible') syncNow(false) }, 180000)
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') {
			unwatchDrive()
			if (enginePromise) enginePromise.then((e) => e.flush()).catch(() => {})
		} else if (enginePromise) {
			enginePromise.then(watchDrive).catch(() => {})
		}
	})
	// Blocks come from the phone's calendars: ask once
	setTimeout(() => {
		let asked = false
		try { asked = localStorage.getItem('askedCalendar') === '1'; localStorage.setItem('askedCalendar', '1') } catch (e) { /* ask */ }
		if (!asked && !background && window.TrackerEngine) engine().then(() => (mode === 'nextcloud' ? call('calendarAccess') : false)).then((ok) => { if (ok) syncNow(true) }).catch(() => {})
	}, 1500)

	window.trackerApp = {
		// The phone's layout (bottom bar, account sheet); the web app (web-native.js) has the desktop one
		phone: window.__trackerWeb !== true,
		getState: () => call('state'),
		onState: (cb) => listeners.state.push(cb),
		api: async (method, path, body) => {
			await ready()
			return (await engine()).api(method, path, body === undefined ? null : body)
		},
		refresh: () => call('refresh'),
		login: (server) => call('login', server),
		useLocal: () => call('useLocal'),
		connectDrive: (provider) => call('connectDrive', provider),
		cancelDrive: () => call('cancelDrive'),
		/** The passphrase: sets up the drive's folder or opens it; then the app keeps the key */
		unlockDrive: async (passphrase, encrypt = true) => {
			const key = await window.BlockwiseFileSync.unlock(driveStore, String(passphrase || ''), { encrypt: encrypt !== false })
			await call('saveDrive', b64(key))
		},
		/** Is Blockwise set up in the drive already, and encrypted? */
		inspectDrive: () => window.BlockwiseFileSync.inspect(driveStore),
		/** The background sync: pull and push once, save, update the notification, done */
		backgroundSync: async () => {
			// The app's window reloads its page after a background sync (it may hold an older copy)
			let changed = false
			try {
				const e = await engine()
				changed = true
				await syncNow(false)
				await e.flush()
				clearTimeout(snapshotTimer)
				const snap = e.snapshot()
				const now = Math.floor(Date.now() / 1000)
				const { blocks } = await e.api('GET', `blocks?from=${now - 86400}&to=${now + 14 * 86400}`)
				snap.blocks = (blocks || []).slice(0, 2000).map((b) => ({ uid: b.uid, title: b.title || '', start: b.start, end: b.end, commitmentId: b.commitmentId }))
				await call('snapshot', snap)
			} catch (err) { /* offline: next time */ }
			await call('bgDone', changed).catch(() => {})
		},
		backToApp: () => call('backToApp'),
		cancelLogin: () => call('cancelLogin'),
		openCalendar: (ts) => call('openCalendar', typeof ts === 'number' ? ts : null),
		/** Your other calendars on this phone (not the commitments'), shown as grey busy time in Calendar */
		otherCalendars: async (mine, ask) => {
			if (ask && !(await call('calendarAccess'))) return null
			return call('otherCalendars', (mine || []).filter((u) => typeof u === 'string'))
		},
		busy: (from, to, ids) => call('busy', from, to, ids),
		onChanged: (cb) => listeners.changed.push(cb),
		/** Waiting for Nextcloud (calendars, blocks): the page shows placeholders */
		loading: () => asking > 0,
		onLoading: (cb) => listeners.loading.push(cb),
		account: () => call('account'),
		// The phone's file picker (the web app, a page in a browser, downloads instead)
		saveFile: window.__trackerWeb ? undefined : (name, text) => call('saveFile', name, text),
		openFile: window.__trackerWeb ? undefined : () => call('openFile'),
	}
})()
