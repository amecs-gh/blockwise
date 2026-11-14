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
	const listeners = { state: [], changed: [], loading: [], offline: [] }
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
	// Nextcloud mode, local first. Blocks in the phone's calendars (DAVx5) are read and written
	// there. Blocks in calendars the phone doesn't have come from Nextcloud: kept on the phone
	// (encrypted, last known: a restart while Nextcloud is down still shows them), and planned,
	// moved or deleted here even while it's down; those changes wait in order (`ops`) and are
	// sent when it answers again. A page never waits for Nextcloud: what's missing or old is
	// asked for in the background and the page is drawn again when the answer comes.
	let serverCals = null
	let serverCalsAt = 0
	let serverCalsAsk = null
	let serverTried = false // asked once this run (answered or not): never wait for it again
	const serverBlocks = new Map() // "from-to" -> {at, list} (Nextcloud's answers, as they came)
	const blockAsks = new Map()
	const FRESH = 120000
	// The weeks around today are always kept, so every page has them offline
	const BACK = 42 * 86400
	const AHEAD = 120 * 86400
	// A block's id as the page sees it: Nextcloud's (+SERVER) or one planned here, not sent yet (+PENDING).
	// Smaller numbers are the phone's calendar rows.
	const SERVER = 9e12
	const PENDING = 8e12
	let ops = [] // waiting for Nextcloud: {op: 'create'|'update'|'delete', ...}
	let nextPid = 1
	const sentAs = new Map() // a block planned here and sent since: its id at Nextcloud
	try { localStorage.removeItem('serverCalendarCache') } catch (e) { /* (an earlier version kept it here) */ }
	let cacheLoad = null
	function loadCache() {
		if (!cacheLoad) {
			cacheLoad = call('blockCacheLoad').then((t) => {
				const kept = t ? JSON.parse(t) : null
				if (!kept) return
				if (serverCals === null && Array.isArray(kept.cals)) serverCals = kept.cals
				// (as old: asked again soon, shown meanwhile)
				for (const [k, list] of kept.blocks || []) if (Array.isArray(list) && !serverBlocks.has(k)) serverBlocks.set(k, { at: 0, list })
				if (Array.isArray(kept.ops)) ops = kept.ops.concat(ops)
				if (Number.isFinite(kept.nextPid)) nextPid = Math.max(nextPid, kept.nextPid)
				if (ops.length) flushSoon(1000)
			}).catch(() => { /* nothing kept */ })
		}
		return cacheLoad
	}
	let keepTimer = null
	function keepSoon() {
		clearTimeout(keepTimer)
		keepTimer = setTimeout(() => {
			const blocks = [...serverBlocks].slice(-12).map(([k, v]) => [k, v.list])
			call('blockCacheSave', JSON.stringify({ cals: serverCals || [], blocks, ops, nextPid })).catch(() => { /* next time */ })
		}, 800)
	}
	let asking = 0
	// Nothing is "loading" while Nextcloud is known to be down: the pages show what the phone has
	const loading = () => asking > 0 && !offlineNow
	const asked = (d) => { asking += d; fire('loading', loading()) }
	// Nextcloud didn't answer: say once that the app carries on with what's on the phone
	let offlineSaid = 0
	let offlineNow = false
	const unreachable = () => {
		if (!offlineNow) {
			offlineNow = true
			// Drawn again without placeholders: what's on the phone is all there is for now
			fire('loading', false)
			fire('changed')
		}
		if (Date.now() - offlineSaid < 10 * 60000) return
		offlineSaid = Date.now()
		fire('offline', true)
	}
	/** Nextcloud answered: back online, and what waited is sent */
	const reachable = () => {
		offlineSaid = 0
		offlineNow = false
		if (ops.length) flushSoon(300)
	}
	function askServerCalendars() {
		if (serverCalsAsk) return serverCalsAsk
		asked(1)
		serverTried = true
		serverCalsAsk = remote('GET', 'state').then((st) => {
			const next = (st.calendars || []).map((c) => ({ id: c.id, url: c.url, name: c.name, color: c.color }))
			const changed = serverCals !== null && JSON.stringify(next) !== JSON.stringify(serverCals)
			serverCals = next
			serverCalsAt = Date.now()
			reachable()
			keepSoon()
			if (changed) fire('changed')
		}).catch(() => {
			// Down or unreachable: try again in a minute, not on every page
			serverCalsAt = Date.now() - FRESH + 60000
			unreachable()
		}).finally(() => { serverCalsAsk = null; asked(-1) })
		return serverCalsAsk
	}
	// Ranges on a 6-hour grid: a range ending "now" stays the same request (and the same answer)
	// instead of a new one every second
	const GRID = 6 * 3600
	const gridKey = (from, to) => `${Math.floor(from / GRID) * GRID}-${Math.ceil(to / GRID) * GRID}`
	/** The last known answer covering [from, to), if any: [its range, it] */
	function knownBlocks(from, to) {
		const key = gridKey(from, to)
		if (serverBlocks.has(key)) return [key, serverBlocks.get(key)]
		let best = null
		for (const [k, v] of serverBlocks) {
			const [a, b] = k.split('-').map(Number)
			if (a <= from && b >= to && (!best || v.at > best[1].at)) best = [k, v]
		}
		return best
	}
	function askServerBlocks(key) {
		if (blockAsks.has(key)) return blockAsks.get(key)
		const [gFrom, gTo] = key.split('-').map(Number)
		asked(1)
		const p = remote('GET', `blocks?from=${gFrom}&to=${gTo}`).then(({ blocks }) => {
			const before = serverBlocks.get(key)
			serverBlocks.delete(key)
			serverBlocks.set(key, { at: Date.now(), list: blocks || [] })
			if (serverBlocks.size > 40) serverBlocks.delete(serverBlocks.keys().next().value)
			reachable()
			keepSoon()
			if (!before || JSON.stringify(before.list) !== JSON.stringify(blocks || [])) fire('changed')
		}).catch(() => {
			// Offline: keep what's known, ask again in a minute
			const before = serverBlocks.get(key)
			serverBlocks.set(key, { at: Date.now() - FRESH + 60000, list: before ? before.list : [], failed: !before })
			unreachable()
		}).finally(() => { blockAsks.delete(key); asked(-1) })
		blockAsks.set(key, p)
		return p
	}
	/** The weeks around today, always kept */
	function windowKey() {
		const day = new Date()
		day.setHours(0, 0, 0, 0)
		const t = Math.floor(day / 1000)
		return gridKey(t - BACK, t + AHEAD)
	}

	// --- changes made here to Nextcloud's blocks, shown at once and sent when it answers ---
	const DAY = 86400
	/** A block planned here: its occurrences in [from, to) (the planner's repeats) */
	function occurrencesOf(o, from, to) {
		const len = o.end - o.start
		const out = []
		const until = o.until || Infinity
		const at = new Date(o.start * 1000)
		for (let i = 0; i < 800; i++) {
			const s = Math.floor(at / 1000)
			if (s >= to || s > until) break
			const weekday = at.getDay()
			if (s + len > from && !(o.repeat === 'weekdays' && (weekday === 0 || weekday === 6))) out.push(s)
			if (!o.repeat) break
			if (o.repeat === 'daily' || o.repeat === 'weekdays') at.setDate(at.getDate() + 1)
			else if (o.repeat === 'weekly') at.setDate(at.getDate() + 7)
			else if (o.repeat === 'biweekly') at.setDate(at.getDate() + 14)
			else if (o.repeat === 'monthly') at.setMonth(at.getMonth() + 1)
			else break
		}
		return out.map((s) => ({ uid: `pending-${o.pid}#${s}`, title: o.title, start: s, end: s + len, calendarId: o.calendarId, pid: o.pid, occurrence: s, repeat: o.repeat || '', until: o.until || null }))
	}
	const touches = (b, o) => b.series === o.series && b.pid === undefined
		&& (!b.repeat || o.scope === 'all' || !o.scope || (o.scope === 'this' ? b.occurrence === o.occurrence : b.occurrence >= o.occurrence))
	/** Nextcloud's blocks with the changes waiting on top */
	function withChanges(list, from, to) {
		let out = list.slice()
		for (const o of ops) {
			if (o.op === 'create') out.push(...occurrencesOf(o, from - DAY, to + DAY))
			else if (o.op === 'delete') out = out.filter((b) => !touches(b, o))
			else {
				const ch = o.ch
				const delta = ch.start !== undefined ? ch.start - o.occurrence : 0
				out = out.map((b) => {
					if (!touches(b, o)) return b
					const start = b.start + delta
					const len = ch.start !== undefined && ch.end !== undefined ? ch.end - ch.start : ch.end !== undefined && b.occurrence === o.occurrence ? ch.end - b.start : b.end - b.start
					return { ...b, start, end: start + len, title: ch.title !== undefined ? ch.title : b.title, calendarId: ch.calendarId !== undefined ? ch.calendarId : b.calendarId }
				})
			}
		}
		return out.filter((b) => b.end > from && b.start < to)
	}
	let flushTimer = null
	let flushing = null
	function flushSoon(ms) {
		clearTimeout(flushTimer)
		flushTimer = setTimeout(flush, ms)
	}
	/** Sends the waiting changes, oldest first; stops at the first that can't reach Nextcloud */
	function flush() {
		if (flushing || !ops.length || mode !== 'nextcloud') return flushing
		flushing = (async () => {
			let sent = 0
			const refused = []
			while (ops.length) {
				const o = ops[0]
				try {
					if (o.op === 'create') {
						const r = await remote('POST', 'blocks', { calendarId: o.calendarId, title: o.title, start: o.start, end: o.end, repeat: o.repeat || '', until: o.until || null, tz: o.tz || undefined })
						if (r && Number.isFinite(r.series)) sentAs.set(o.pid, r.series)
					} else if (o.op === 'update') {
						await remote('PUT', `blocks/${o.series}/${o.occurrence}`, o.ch)
					} else {
						await remote('DELETE', `blocks/${o.series}/${o.occurrence}?scope=${['this', 'future', 'all'].includes(o.scope) ? o.scope : 'all'}`, undefined)
					}
				} catch (e) {
					// Not reachable (or not logged in): it stays, in order, for next time
					if (!e.status || e.status >= 500 || e.status === 401) { unreachable(); break }
					// Refused (the block is gone, the calendar too…): dropped, and said
					refused.push(e.message)
				}
				ops.shift()
				sent++
				keepSoon()
			}
			if (refused.length) {
				const it = /^it\b/i.test(navigator.language || '')
				try { window.OC.Notification.showTemporary((it ? 'Alcune modifiche ai blocchi non sono state accettate da Nextcloud: ' : 'Nextcloud didn\'t take some changes to blocks: ') + [...new Set(refused)].join(' · '), { type: 'error' }) } catch (x) { /* no page */ }
			}
			if (sent) {
				// What Nextcloud has now: asked again
				for (const v of serverBlocks.values()) v.at = 0
				fire('changed')
			}
		})().finally(() => { flushing = null })
		return flushing
	}
	function calendarIdOf(url) {
		const cal = (serverCals || []).find((c) => samePath(c.url, url))
		if (!cal) throw new Error('This commitment\'s calendar is not known yet. Try again when Nextcloud is reachable.')
		return cal.id
	}
	const queue = (o) => { ops.push(o); keepSoon(); flushSoon(300) }

	const calendar = {
		/** The phone's Nextcloud calendars (offline too), plus the server's others as last known */
		async calendars() {
			await loadCache()
			phoneCals = (await call('calendars').catch(() => [])) || []
			// Nothing known yet and nothing on the phone either (first start): wait for the server, briefly
			if (serverCals === null && !phoneCals.length && !serverTried) await Promise.race([askServerCalendars(), new Promise((r) => setTimeout(r, 4000))])
			// (old, or never answered: asked again, but after a failure only once a minute)
			else if (Date.now() - serverCalsAt > FRESH) askServerCalendars()
			// The weeks around today, for every page (and for when Nextcloud is down)
			const w = windowKey()
			const kept = serverBlocks.get(w)
			if (!kept || Date.now() - kept.at > FRESH) askServerBlocks(w)
			const out = phoneCals.map((c) => ({ url: serverForm(c.url), name: c.name, color: c.color })).filter((c) => c.url)
			for (const c of serverCals || []) if (!out.some((p) => samePath(p.url, c.url))) out.push({ url: c.url, name: c.name, color: c.color })
			return out
		},
		/** Blocks from the phone's calendars; for calendars the phone doesn't have, Nextcloud's as last known (with the changes made here) */
		async events(from, to, urls) {
			const onPhone = urls.filter((u) => phoneCals.some((p) => samePath(p.url, u)))
			const rest = urls.filter((u) => !onPhone.includes(u))
			let incomplete = false
			const out = onPhone.length ? ((await call('events', from, to, onPhone).catch(() => { incomplete = true; return [] })) || []) : []
			if (rest.length) {
				const known = knownBlocks(from, to)
				if (!known) askServerBlocks(gridKey(from, to))
				else if (Date.now() - known[1].at > FRESH) askServerBlocks(known[0])
				if (!known || !serverCals || known[1].failed) incomplete = true
				for (const b of withChanges((known && known[1].list) || [], from, to)) {
					const cal = (serverCals || []).find((c) => c.id === b.calendarId)
					const url = cal && rest.find((u) => samePath(u, cal.url))
					if (!url) continue
					const ev = { uid: b.uid, title: b.title, start: b.start, end: b.end, url }
					if (b.pid !== undefined) Object.assign(ev, { series: PENDING + b.pid, occurrence: b.occurrence, repeat: b.repeat, until: b.until })
					else if (Number.isFinite(b.series)) Object.assign(ev, { series: SERVER + b.series, occurrence: b.occurrence, repeat: b.repeat || '', until: b.until || null })
					out.push(ev)
				}
			}
			// Some blocks may be missing: the engine shows what it has, but doesn't count blocks as ended
			if (incomplete) out.incomplete = true
			return out
		},
		/** A new block: in the commitment's calendar on the phone (DAVx5 uploads it), else for Nextcloud (sent when it answers) */
		async createEvent(ev) {
			await loadCache()
			if (phoneCals.some((p) => samePath(p.url, ev.url))) return call('createEvent', ev)
			const pid = nextPid++
			queue({ op: 'create', pid, calendarId: calendarIdOf(ev.url), title: ev.title, start: ev.start, end: ev.end, repeat: ev.repeat || '', until: ev.until || null, tz: ev.tz })
			return { uid: `pending-${pid}#${ev.start}` }
		},
		/** Move or change one (this / future / all; `url`: another commitment's calendar) */
		async updateEvent(series, occurrence, ch) {
			await loadCache()
			if (series < PENDING) return call('updateEvent', series, occurrence, ch)
			const calendarId = ch.url !== undefined ? calendarIdOf(ch.url) : undefined
			if (series < SERVER) {
				const pid = series - PENDING
				const o = ops.find((x) => x.op === 'create' && x.pid === pid)
				if (!o) {
					// Sent meanwhile: change it at Nextcloud
					if (!sentAs.has(pid)) throw new Error('This block is gone. Pull to refresh.')
					return calendar.updateEvent(SERVER + sentAs.get(pid), occurrence, ch)
				}
				const len = o.end - o.start
				if (ch.start !== undefined) o.start = o.start + (ch.start - occurrence)
				o.end = ch.end !== undefined && ch.start !== undefined ? o.start + (ch.end - ch.start) : o.start + len
				if (ch.title !== undefined) o.title = ch.title
				if (calendarId !== undefined) o.calendarId = calendarId
				if (ch.repeat !== undefined && ch.repeat !== 'custom') o.repeat = ch.repeat
				if (ch.until !== undefined) o.until = ch.until
				keepSoon()
				flushSoon(300)
				return { ok: true, series, occurrence: o.start }
			}
			const change = {}
			for (const k of ['start', 'end', 'title', 'repeat', 'until', 'scope', 'tz']) if (ch[k] !== undefined) change[k] = ch[k]
			if (calendarId !== undefined) change.calendarId = calendarId
			queue({ op: 'update', series: series - SERVER, occurrence, scope: change.scope || 'all', ch: change })
			return { ok: true, series, occurrence: ch.start !== undefined ? ch.start : occurrence }
		},
		async deleteEvent(series, occurrence, scope) {
			await loadCache()
			if (series < PENDING) return call('deleteEvent', series, occurrence, scope)
			if (series < SERVER) {
				const pid = series - PENDING
				const i = ops.findIndex((x) => x.op === 'create' && x.pid === pid)
				if (i < 0) {
					if (!sentAs.has(pid)) return { ok: true }
					return calendar.deleteEvent(SERVER + sentAs.get(pid), occurrence, scope)
				}
				ops.splice(i, 1)
				keepSoon()
				return { ok: true }
			}
			queue({ op: 'delete', series: series - SERVER, occurrence, scope: scope || 'all' })
			return { ok: true }
		},
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
				reachable()
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
			} catch (err) {
				// Offline or the server is down: the changes wait on the phone
				if (mode === 'nextcloud') unreachable()
			}
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
				// The very first sync on this phone (nothing to show before it): at most 12 s
				return Promise.race([syncNow(false), new Promise((r) => setTimeout(r, 12000))])
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
		loading,
		onLoading: (cb) => listeners.loading.push(cb),
		/** Nextcloud didn't answer (said at most every 10 minutes) */
		onOffline: (cb) => {
			listeners.offline.push(cb)
			// (said before the page listened: say it now)
			if (offlineNow) setTimeout(() => cb(true), 0)
		},
		account: () => call('account'),
		// The phone's file picker (the web app, a page in a browser, downloads instead)
		saveFile: window.__trackerWeb ? undefined : (name, text) => call('saveFile', name, text),
		openFile: window.__trackerWeb ? undefined : () => call('openFile'),
	}
})()
