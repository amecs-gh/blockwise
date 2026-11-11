/*
 * window.trackerApp for the Android app: the same interface the Mac app's
 * preload gives its windows (so setup.js and nextcloud-shim.js are shared),
 * implemented over the app's Java bridge (window.TrackerAndroid).
 *
 * Blockwise runs here, on the phone (local-first): the interface's API requests
 * go to the engine (web/engine.js), which keeps your data on the phone
 * (encrypted by the app), reads blocks from the phone's calendars, and syncs
 * with Nextcloud whenever it can.
 *
 * Every call goes through TrackerAndroid.call(id, channel, argsJson); the app
 * answers with window.__trackerAndroid.resolve(id, envelopeJson), where the
 * envelope is {"data": ...} or {"error": "...", "status": n}.
 */
;(function () {
	'use strict'
	const native = window.TrackerAndroid
	const pending = new Map()
	const listeners = { state: [], changed: [] }
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
		root.classList.toggle('m3-dark', !!theme.dark)
		for (const [k, v] of Object.entries(theme.insets || {})) {
			if (typeof v === 'number' && isFinite(v)) root.style.setProperty('--inset-' + k, Math.max(0, Math.round(v)) + 'px')
		}
	}
	document.documentElement.classList.add('m3')
	if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.classList.add('m3-dark')

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
	let serverCals = null
	const calendar = {
		/** The phone's Nextcloud calendars (offline too), plus the server's others when online */
		async calendars() {
			phoneCals = (await call('calendars').catch(() => [])) || []
			try {
				serverCals = ((await remote('GET', 'state')).calendars || []).map((c) => ({ id: c.id, url: c.url, name: c.name, color: c.color }))
			} catch (e) { /* offline */ }
			const out = phoneCals.map((c) => ({ url: serverForm(c.url), name: c.name, color: c.color })).filter((c) => c.url)
			for (const c of serverCals || []) if (!out.some((p) => samePath(p.url, c.url))) out.push({ url: c.url, name: c.name, color: c.color })
			return out
		},
		/** Blocks from the phone's calendars; for calendars the phone doesn't have, the server's (online only) */
		async events(from, to, urls) {
			const onPhone = urls.filter((u) => phoneCals.some((p) => samePath(p.url, u)))
			const rest = urls.filter((u) => !onPhone.includes(u))
			let incomplete = false
			const out = onPhone.length ? ((await call('events', from, to, onPhone).catch(() => { incomplete = true; return [] })) || []) : []
			if (rest.length && !serverCals) incomplete = true
			if (rest.length && serverCals) {
				try {
					const { blocks } = await remote('GET', `blocks?from=${Math.floor(from)}&to=${Math.ceil(to)}`)
					for (const b of blocks || []) {
						const cal = serverCals.find((c) => c.id === b.calendarId)
						const url = cal && rest.find((u) => samePath(u, cal.url))
						if (url) out.push({ uid: b.uid, title: b.title, start: b.start, end: b.end, url })
					}
				} catch (e) { incomplete = true /* offline: the phone's calendars only */ }
			}
			// Some blocks may be missing: the engine shows what it has, but doesn't count blocks as ended
			if (incomplete) out.incomplete = true
			return out
		},
		/** A new block in the commitment's calendar on the phone (DAVx5 uploads it) */
		createEvent: (ev) => call('createEvent', ev),
	}

	let enginePromise = null
	let snapshotTimer = null
	let syncTimer = null
	let syncing = null
	function engine() {
		if (!enginePromise) {
			enginePromise = window.TrackerEngine.createEngine({
				storage: {
					load: async () => { const t = await call('dbLoad'); return t ? JSON.parse(t) : null },
					save: (db) => call('dbSave', JSON.stringify(db)),
				},
				remote: {
					pull: (since, limit) => remote('GET', `sync?since=${since}&limit=${limit}`),
					push: (records) => remote('POST', 'sync', { records }),
				},
				calendar,
				// A change here: send it soon. After a sync: only update the notification.
				onChange: (db, info) => { snapshotSoon(); if (!(info && info.sync)) syncSoon(3000) },
			})
			// Could not open the data (e.g. the Keystore was busy): try again on the next request
			enginePromise.catch(() => { enginePromise = null; firstSync = null })
		}
		return enginePromise
	}
	function snapshotSoon() {
		clearTimeout(snapshotTimer)
		snapshotTimer = setTimeout(async () => { try { await call('snapshot', (await engine()).snapshot()) } catch (e) { /* next change */ } }, 300)
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
				if (e.lastSync()) { syncSoon(500); return }
				return Promise.race([syncNow(false), new Promise((r) => setTimeout(r, 20000))])
			}).catch(() => {})
		}
		return firstSync
	}
	setInterval(() => { if (document.visibilityState === 'visible') syncNow(false) }, 180000)
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden' && enginePromise) enginePromise.then((e) => e.flush()).catch(() => {})
	})
	// Blocks come from the phone's calendars: ask once
	setTimeout(() => {
		let asked = false
		try { asked = localStorage.getItem('askedCalendar') === '1'; localStorage.setItem('askedCalendar', '1') } catch (e) { /* ask */ }
		if (!asked && window.TrackerEngine) call('calendarAccess').then((ok) => { if (ok) syncNow(true) }).catch(() => {})
	}, 1500)

	window.trackerApp = {
		getState: () => call('state'),
		onState: (cb) => listeners.state.push(cb),
		api: async (method, path, body) => {
			await ready()
			return (await engine()).api(method, path, body === undefined ? null : body)
		},
		refresh: () => call('refresh'),
		login: (server) => call('login', server),
		cancelLogin: () => call('cancelLogin'),
		openCalendar: (ts) => call('openCalendar', typeof ts === 'number' ? ts : null),
		onChanged: (cb) => listeners.changed.push(cb),
		account: () => call('account'),
	}
})()
