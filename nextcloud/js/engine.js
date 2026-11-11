/*
 * Blockwise engine: Blockwise running on the device (local-first).
 *
 * Keeps a copy of your commitments, tasks, subtasks, tracked time and settings,
 * answers the interface's API requests from it (same paths and same answers
 * as the Nextcloud app's API), and syncs with a server when it can:
 * push local changes, pull everyone else's (see lib/Sync/SyncService.php).
 *
 * Conflicts: per field, the later change wins (hybrid logical clocks);
 * "carriedBlocks" is a set (union); deleted stays deleted.
 *
 * Blocks come from a calendar source given by the app (Android's calendar
 * storage, Apple Calendar, or the server) and are matched to commitments by
 * the calendar's address.
 *
 * Usable in browsers/WebViews (window.TrackerEngine) and Node (require).
 */
;(function (root) {
	'use strict'

	// --- small helpers ----------------------------------------------------------------------

	const SETTINGS = {
		focusMinutes: [25, 5, 180],
		shortBreakMinutes: [5, 1, 60],
		longBreakMinutes: [15, 1, 120],
		sessionsBeforeLongBreak: [4, 1, 12],
		reminderMinutes: [15, 0, 120],
		defaultEstimate: [15, 5, 600],
	}
	const SETTINGS_BOOL = { pomodoro: false, showCalendar: true }
	const TYPES = ['commitment', 'task', 'subtask', 'note', 'session', 'block']
	const MAX_SUBTASKS = 200
	const MAX_NOTES = 1000
	// Fields each record type may have (the server's lib/Sync/SyncFields.php); anything else from a server is ignored
	const FIELDS = {
		commitment: ['name', 'color', 'goal', 'position', 'calendarUrl', 'created'],
		task: ['commitment', 'title', 'note', 'position', 'done', 'doneAt', 'created', 'carriedBlocks'],
		subtask: ['task', 'title', 'position', 'done', 'doneAt', 'estimate', 'created'],
		note: ['commitment', 'text', 'position', 'done', 'doneAt', 'created'],
		session: ['commitment', 'start', 'end', 'blockUid', 'pomodoro'],
		// The built-in calendar's blocks (only on devices without Nextcloud; never sent to a Nextcloud server)
		block: ['commitment', 'title', 'start', 'end', 'repeat', 'until', 'skip', 'origin', 'created'],
		settings: [...Object.keys({ focusMinutes: 0, shortBreakMinutes: 0, longBreakMinutes: 0, sessionsBeforeLongBreak: 0, reminderMinutes: 0, defaultEstimate: 0 }), 'pomodoro', 'showCalendar', 'longBreakUntil'],
	}
	const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
	/** "Carried over" marks: a set, at most 500 (the newest), like the server */
	const carriedSet = (list) => [...new Set(list.filter((x) => typeof x === 'string' && x !== '' && x.length <= 600))].slice(-500)
	/** Repeating blocks, like Apple Calendar's simple choices */
	const REPEATS = ['', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly']
	/** Skipped occurrences (start times) of a repeating block: at most 1000, whole numbers */
	const skipList = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => Number.isInteger(x) && x > 0))].sort((a, b) => a - b).slice(-1000) : [])
	const okValue = (v) => v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))

	class ApiError extends Error {
		constructor(message, status = 400) {
			super(message)
			this.status = status
		}
	}

	const uuid4 = () => {
		const b = new Uint8Array(16)
		;(root.crypto || require('node:crypto').webcrypto).getRandomValues(b)
		b[6] = (b[6] & 0x0f) | 0x40
		b[8] = (b[8] & 0x3f) | 0x80
		const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
	}
	const clampInt = (v, min, max) => Math.max(min, Math.min(max, Math.trunc(Number(v))))
	const text = (v, max, required = true) => {
		const s = typeof v === 'string' ? v.trim() : ''
		if (!s) {
			if (required) throw new ApiError('Title is required')
			return null
		}
		return [...s].slice(0, max).join('')
	}
	const shortColor = (c) => {
		if (typeof c !== 'string') return '#0082c9'
		if (/^#[0-9a-fA-F]{8}$/.test(c)) return c.slice(0, 7)
		return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#0082c9'
	}

	/** A note's text (markdown): trimmed, at most 20000 characters (like the server) */
	const noteText = (v) => {
		const s = typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : ''
		if (!s) throw new ApiError('Text is required')
		return [...s].slice(0, 20000).join('')
	}
	/** A note in lists (Done): first line, markdown removed. Same as js/markdown.js plainTitle() and the server. */
	const noteTitle = (text) => {
		let line = String(text || '').replace(/\r\n?/g, '\n').trim().split('\n')[0].trim()
		line = line.replace(/^(#{1,6}\s+|>\s*|```\S*|~~~\S*)/, '').replace(/^([-*+]|\d{1,9}[.)])\s+/, '').replace(/^\[[ xX]\]\s*/, '')
		line = line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(\*\*|__|~~|`)/g, '').replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, '$1$2').trim()
		const chars = [...line]
		return chars.length > 120 ? chars.slice(0, 119).join('').trimEnd() + '…' : line
	}

	/** "Draft 45m", "1h", "1h30", "1.5h", "90min" -> [title, minutes] (same as the server) */
	function parseEstimate(line) {
		line = String(line).trim()
		const m = /^(.*\S)\s+(?:(\d+(?:[.,]\d+)?)\s*h(?:\s*(\d+)\s*(?:m|min)?)?|(\d+)\s*(?:m|min))$/i.exec(line)
		if (!m) return [line, null]
		const minutes = m[4] ? Number(m[4]) : Math.round(Number(m[2].replace(',', '.')) * 60) + (m[3] ? Number(m[3]) : 0)
		return [m[1], minutes > 0 ? minutes : null]
	}

	// Hybrid logical clock values: "<ms, 13 digits>-<counter, 4 hex>-<node>", ordered as strings
	const fmtClock = (ms, counter, node) => `${String(ms).padStart(13, '0')}-${Math.min(counter, 0xffff).toString(16).padStart(4, '0')}-${node}`
	const parseClock = (c) => {
		const m = /^(\d{13})-([0-9a-f]{4})-/.exec(c || '')
		return m ? [Number(m[1]), parseInt(m[2], 16)] : [0, 0]
	}
	const CLOCK_RE = /^\d{13}-[0-9a-f]{4}-[A-Za-z0-9_-]{1,32}$/

	// --- the engine ---------------------------------------------------------------------------

	/**
	 * @param {object} o
	 * @param {{load(): Promise<object|null>, save(db: object): Promise<void>}} o.storage
	 * @param {{pull(since: number, limit: number): Promise<object>, push(records: object[]): Promise<object>}|null} o.remote
	 * @param {{calendars(): Promise<object[]>, events(from: number, to: number, urls: string[]): Promise<object[]>}} o.calendar
	 *   calendars: [{url, name, color}]; events: [{uid, title, start, end, url}] (url = the calendar's)
	 * @param {() => number} [o.now] unix seconds
	 * @param {() => number} [o.nowMs]
	 * @param {(db: object) => void} [o.onChange] after local changes (to schedule a sync, update notifications…)
	 */
	async function createEngine(o) {
		const nowMs = o.nowMs || (() => Date.now())
		const now = o.now || (() => Math.floor(nowMs() / 1000))
		let db = (await o.storage.load()) || null
		if (!db || db.version !== 1) {
			db = {
				version: 1,
				node: 'd' + uuid4().replace(/-/g, '').slice(0, 10),
				hlc: null,
				cursor: 0,
				nextId: 1,
				ids: {}, // uuid (or "cal:" + url) -> local number
				records: { commitment: {}, task: {}, subtask: {}, note: {}, session: {}, block: {} },
				settings: { f: {}, c: {} },
				deleted: {}, // uuid -> type
				dirty: {}, // "type:uuid" -> {field: true} or {deleted: true}
				checked: {}, // commitment uuid -> blocks processed until (carry-over, this device)
				lastSync: null,
			}
		}
		// Data saved by an older version: record types added since (notes)
		for (const type of TYPES) if (!db.records[type]) db.records[type] = {}
		let saveTimer = null
		let syncing = null

		const persist = () => {
			clearTimeout(saveTimer)
			saveTimer = setTimeout(() => { o.storage.save(db).catch(() => {}) }, 150)
		}
		const changed = () => {
			persist()
			if (o.onChange) {
				try { o.onChange(db) } catch (e) { /* ignore */ }
			}
		}

		// --- ids and clocks ---

		const lid = (key) => {
			if (key === null || key === undefined) return null
			if (!db.ids[key]) db.ids[key] = db.nextId++
			return db.ids[key]
		}
		const byLid = (type, id) => {
			id = Number(id)
			for (const [u, r] of Object.entries(db.records[type])) {
				if (db.ids[u] === id) return [u, r]
			}
			throw new ApiError('Not found', 404)
		}
		const tick = () => {
			const [ms, c] = parseClock(db.hlc)
			const n = nowMs()
			db.hlc = n > ms ? fmtClock(n, 0, db.node) : fmtClock(ms, c + 1, db.node)
			return db.hlc
		}
		const observe = (clock) => {
			if (clock && clock > (db.hlc || '')) {
				const [ms, c] = parseClock(clock)
				// A clock far in the future would make every later change of ours lose or be refused
				if (ms > nowMs() + 86400000) return
				db.hlc = fmtClock(ms, c, db.node)
			}
		}

		/** Local change of some fields of a record (creates it if new). */
		const write = (type, u, fields) => {
			const rec = db.records[type][u] || (db.records[type][u] = { f: {}, c: {} })
			const key = type + ':' + u
			const d = db.dirty[key] || (db.dirty[key] = {})
			for (const [k, v] of Object.entries(fields)) {
				rec.f[k] = v
				rec.c[k] = tick()
				d[k] = true
			}
			return rec
		}
		const remove = (type, u) => {
			if (!db.records[type][u]) return
			delete db.records[type][u]
			db.deleted[u] = type
			db.dirty[type + ':' + u] = { deleted: true }
		}
		const writeSettings = (fields) => {
			const d = db.dirty['settings:settings'] || (db.dirty['settings:settings'] = {})
			for (const [k, v] of Object.entries(fields)) {
				db.settings.f[k] = v
				db.settings.c[k] = tick()
				d[k] = true
			}
		}

		// --- reading the local data the way the API answers ---

		const settings = () => {
			const s = {}
			for (const [k, [def, min, max]] of Object.entries(SETTINGS)) {
				const v = db.settings.f[k]
				s[k] = typeof v === 'number' ? clampInt(v, min, max) : def
			}
			for (const [k, def] of Object.entries(SETTINGS_BOOL)) {
				s[k] = typeof db.settings.f[k] === 'boolean' ? db.settings.f[k] : def
			}
			return s
		}
		const longBreakUntil = () => {
			const v = db.settings.f.longBreakUntil
			return typeof v === 'number' && v > 0 ? v : null
		}

		let calendarList = []
		const calLid = (url) => (url ? lid('cal:' + url) : null)

		// --- the built-in calendar: one calendar per commitment, blocks stored (and synced) as records ---
		const BUILTIN = 'blockwise:'
		const builtin = !!(o.calendar && o.calendar.kind === 'builtin')
		/** The calendar a commitment's blocks come from. Built in: its own (the Apple/Nextcloud link is kept for later). */
		const calUrlOf = (u, r) => (builtin ? BUILTIN + u : r.f.calendarUrl)
		const localTypes = new Set(o.remote && Array.isArray(o.remote.localTypes) ? o.remote.localTypes : [])
		const pendingCount = () => Object.keys(db.dirty).filter((k) => !localTypes.has(k.split(':')[0])).length

		/** Start times of a block's occurrences in [from, to) (repeats follow local time, across DST). */
		const occurrences = (f, from, to) => {
			const dur = f.end - f.start
			if (!(dur > 0)) return []
			const rep = REPEATS.includes(f.repeat) ? f.repeat : ''
			if (!rep) return f.start + dur > from && f.start < to ? [f.start] : []
			const until = Number.isFinite(f.until) && f.until > 0 ? f.until : Infinity
			const skip = new Set(skipList(f.skip))
			const base = new Date(f.start * 1000)
			const days = rep === 'weekly' ? 7 : rep === 'biweekly' ? 14 : 1
			const at = (k) => {
				const d = new Date(base.getTime())
				if (rep === 'monthly') {
					d.setMonth(base.getMonth() + k)
					if (d.getDate() !== base.getDate()) return null // no 31st this month
				} else d.setDate(base.getDate() + k * days)
				return Math.floor(d.getTime() / 1000)
			}
			const approx = (rep === 'monthly' ? 31 : days) * 86400
			let k = Math.max(0, Math.floor((from - dur - f.start) / approx) - 2)
			const out = []
			for (let n = 0; n < 3000 && out.length < 1000; n++, k++) {
				const st = at(k)
				if (st === null) continue
				if (st >= to || st > until) break
				if (st + dur <= from || skip.has(st)) continue
				if (rep === 'weekdays') {
					const wd = new Date(st * 1000).getDay()
					if (wd === 0 || wd === 6) continue
				}
				out.push(st)
			}
			return out
		}
		const builtinSource = {
			kind: 'builtin',
			calendars: async () => commitments().map((c) => ({ url: BUILTIN + c.uuid, name: c.name, color: c.color, writable: true })),
			events: async (from, to, urls) => {
				const want = new Set(urls)
				const out = []
				for (const [bu, b] of Object.entries(db.records.block)) {
					if (!complete('block', b) || !want.has(BUILTIN + b.f.commitment)) continue
					for (const st of occurrences(b.f, from, to)) {
						out.push({ uid: `${bu}#${st}`, title: b.f.title || '', start: st, end: st + (b.f.end - b.f.start), url: BUILTIN + b.f.commitment,
							series: lid(bu), occurrence: st, repeat: b.f.repeat || '', until: b.f.until || null })
					}
				}
				return out
			},
			createEvent: async ({ url, title, start, end, repeat = '', until = null }) => {
				const bu = uuid4()
				write('block', bu, { commitment: url.slice(BUILTIN.length), title, start, end, repeat, until, skip: [], origin: null, created: now() })
				changed()
				return { uid: `${bu}#${start}` }
			},
		}
		if (builtin) o = { ...o, calendar: builtinSource }
		const commitmentJson = (u, r) => ({
			id: lid(u),
			uuid: u,
			name: r.f.name,
			color: r.f.color || '#0082c9',
			calendarId: calUrlOf(u, r) && calendarList.some((c) => c.url === calUrlOf(u, r)) ? calLid(calUrlOf(u, r)) : null,
			position: r.f.position || 0,
			weeklyGoal: r.f.goal ?? null,
			calendarUrl: r.f.calendarUrl ?? null,
		})
		/**
		 * A record shows once it has what it needs (and its parent exists): from a
		 * drive, another device's change can arrive before the record itself.
		 */
		const REQUIRED = { commitment: ['name'], task: ['commitment', 'title'], subtask: ['task', 'title'], note: ['commitment', 'text'], session: ['start'], block: ['commitment', 'start', 'end'] }
		const complete = (type, r) => !!r && REQUIRED[type].every((k) => r.f[k] !== undefined && r.f[k] !== null && r.f[k] !== '')
			&& (type === 'task' || type === 'note' || type === 'block' ? complete('commitment', db.records.commitment[r.f.commitment])
				: type === 'subtask' ? complete('task', db.records.task[r.f.task]) : true)
		const commitments = () => Object.entries(db.records.commitment)
			.filter(([, r]) => complete('commitment', r))
			.sort(([ua, a], [ub, b]) => (a.f.position || 0) - (b.f.position || 0) || lid(ua) - lid(ub))
			.map(([u, r]) => commitmentJson(u, r))

		const subtaskJson = (u, r) => ({
			id: lid(u), uuid: u, taskId: lid(r.f.task), title: r.f.title, position: r.f.position || 0,
			done: !!r.f.done, doneAt: r.f.doneAt ?? null, estimate: r.f.estimate ?? null,
		})
		const subtasksOf = (taskUuid) => Object.entries(db.records.subtask)
			.filter(([, r]) => r.f.task === taskUuid && complete('subtask', r))
			.sort(([ua, a], [ub, b]) => (a.f.position || 0) - (b.f.position || 0) || lid(ua) - lid(ub))
		const taskJson = (u, r) => {
			const subs = subtasksOf(u).map(([su, sr]) => subtaskJson(su, sr))
			const ests = subs.filter((s) => s.estimate !== null)
			return {
				id: lid(u), uuid: u, commitmentId: lid(r.f.commitment), title: r.f.title, note: r.f.note ?? null,
				estimate: ests.length ? ests.reduce((a, s) => a + s.estimate, 0) : null,
				position: r.f.position || 0, done: !!r.f.done, doneAt: r.f.doneAt ?? null,
				carried: (r.f.carriedBlocks || []).length, created: r.f.created || 0, subtasks: subs,
			}
		}
		const tasks = (commitmentUuid = null, done = null) => Object.entries(db.records.task)
			.filter(([, r]) => (commitmentUuid === null || r.f.commitment === commitmentUuid) && (done === null || !!r.f.done === done) && complete('task', r))
			.sort(([ua, a], [ub, b]) => (a.f.position || 0) - (b.f.position || 0) || lid(ua) - lid(ub))
			.map(([u, r]) => taskJson(u, r))
		const sessionJson = (u, r) => ({
			id: lid(u), uuid: u, commitmentId: lid(r.f.commitment ?? null), start: r.f.start, end: r.f.end ?? null,
			blockUid: r.f.blockUid ?? null, pomodoro: !!r.f.pomodoro,
		})
		const noteJson = (u, r) => ({
			id: lid(u), uuid: u, commitmentId: lid(r.f.commitment), text: r.f.text, position: r.f.position || 0,
			done: !!r.f.done, doneAt: r.f.doneAt ?? null, created: r.f.created || 0,
		})
		const notesOf = (commitmentUuid = null, done = null) => Object.entries(db.records.note)
			.filter(([, r]) => (commitmentUuid === null || r.f.commitment === commitmentUuid) && (done === null || !!r.f.done === done) && complete('note', r))
			.sort(([ua, a], [ub, b]) => (a.f.position || 0) - (b.f.position || 0) || lid(ua) - lid(ub))
		const runningEntry = () => {
			const run = Object.entries(db.records.session).filter(([, r]) => (r.f.end === null || r.f.end === undefined) && complete('session', r))
			run.sort(([, a], [, b]) => b.f.start - a.f.start)
			return run[0] || null
		}
		const running = () => {
			const e = runningEntry()
			return e ? sessionJson(e[0], e[1]) : null
		}

		/** Seconds of work left in a task (open subtasks; with `at`, those finished since `at` count as open). */
		const remaining = (task, def, at = null) => task.subtasks.reduce((sum, s) => {
			const open = !s.done || (at !== null && (s.doneAt || 0) >= at)
			return sum + (open ? (s.estimate ?? def) * 60 : 0)
		}, 0)
		const fill = (queue, seconds, def, at = null) => {
			const planned = []
			let used = 0
			for (const t of queue) {
				if (planned.length && used >= seconds) break
				planned.push(t)
				used += remaining(t, def, at)
			}
			return planned
		}

		// --- blocks from the calendar ---

		const refreshCalendars = async () => {
			try {
				calendarList = (await o.calendar.calendars()) || []
			} catch (e) {
				calendarList = calendarList || []
			}
		}
		/** Blocks of the commitments in [from, to), sorted (like the server's CommitmentService::blocks). */
		/** @param {boolean} strict throw if the calendars could not (all) be read */
		const blocks = async (from, to, onlyUuids = null, strict = false) => {
			const byUrl = new Map()
			for (const [u, r] of Object.entries(db.records.commitment)) {
				if (calUrlOf(u, r) && (!onlyUuids || onlyUuids.includes(u))) byUrl.set(calUrlOf(u, r), u)
			}
			if (!byUrl.size) return []
			let events = []
			try {
				events = (await o.calendar.events(from, to, [...byUrl.keys()])) || []
			} catch (e) {
				if (strict) throw e
				events = []
			}
			if (strict && events.incomplete) throw new Error('Calendars not readable')
			const out = []
			for (const ev of events) {
				const cu = byUrl.get(ev.url)
				if (!cu || !(ev.end > ev.start) || ev.end <= from || ev.start >= to) continue
				const b = { uid: ev.uid, title: ev.title || '', start: ev.start, end: ev.end, calendarId: calLid(ev.url), commitmentId: lid(cu) }
				// Built in: which block and occurrence (to change or delete it)
				if (ev.series) Object.assign(b, { series: ev.series, occurrence: ev.occurrence, repeat: ev.repeat, until: ev.until })
				out.push(b)
			}
			out.sort((a, b) => a.start - b.start)
			return out
		}
		/** A repeat rule from a request: {repeat, until} (until: last possible start, or null) */
		const repeatOf = (body, start) => {
			const repeat = REPEATS.includes(body.repeat) ? body.repeat : ''
			let until = body.until === null || body.until === undefined || body.until === '' ? null : Math.trunc(Number(body.until))
			if (!repeat || !Number.isFinite(until) || until < start) until = null
			return { repeat, until }
		}
		const findOverlaps = (list) => {
			const out = []
			for (let i = 0; i < list.length; i++) {
				for (let j = i + 1; j < list.length && list[j].start < list[i].end; j++) {
					if (list[j].commitmentId === list[i].commitmentId) continue
					out.push({ a: list[i], b: list[j], start: Math.max(list[i].start, list[j].start), end: Math.min(list[i].end, list[j].end) })
				}
			}
			return out
		}

		/** Carry-over marks for blocks that ended since the last check (idempotent: a set of marks). */
		const processEndedBlocks = async () => {
			const t = now()
			const def = settings().defaultEstimate
			let touched = false
			for (const [cu, c] of Object.entries(db.records.commitment)) {
				const since = Math.max(db.checked[cu] || (c.f.created || t), t - 14 * 86400)
				if (!calUrlOf(cu, c) || since >= t) { db.checked[cu] = t; continue }
				let ended
				try {
					ended = (await blocks(since - 86400, t, [cu], true)).filter((b) => b.end > since && b.end <= t)
				} catch (e) {
					continue // calendar not readable now (offline): try again next time
				}
				db.checked[cu] = t
				if (!ended.length) continue
				const all = tasks(cu, null)
				for (const b of ended) {
					const queue = all.filter((x) => x.created < b.end && (!x.done || (x.doneAt || 0) >= b.start))
					for (const x of fill(queue, b.end - b.start, def, b.start)) {
						if (x.done) continue
						const mark = b.uid + '@' + b.start
						const rec = db.records.task[x.uuid]
						const set = rec.f.carriedBlocks || []
						if (!set.includes(mark)) {
							write('task', x.uuid, { carriedBlocks: carriedSet([...set, mark]) })
							touched = true
						}
					}
				}
			}
			persist()
			if (touched) changed()
		}

		// --- the API -------------------------------------------------------------------------

		const commitmentUuid = (id) => byLid('commitment', id)[0]
		const taskDoneFollowsSubtasks = (tu) => {
			const subs = subtasksOf(tu)
			if (!subs.length) return
			const all = subs.every(([, s]) => !!s.f.done)
			const t = db.records.task[tu]
			if (all && !t.f.done) write('task', tu, { done: true, doneAt: now() })
			else if (!all && t.f.done) write('task', tu, { done: false, doneAt: null })
		}
		const maxPos = (list) => list.reduce((m, [, r]) => Math.max(m, r.f.position || 0), 0)
		const createSubtask = (tu, title, estimate = null) => {
			if (estimate === null || estimate === undefined) [title, estimate] = parseEstimate(title)
			if (subtasksOf(tu).length >= MAX_SUBTASKS) throw new ApiError('Too many subtasks')
			const su = uuid4()
			write('subtask', su, {
				task: tu, title: text(title, 255), position: maxPos(subtasksOf(tu)) + 1, done: false, doneAt: null,
				estimate: estimate > 0 ? Math.min(Math.trunc(estimate), 100000) : null, created: now(),
			})
			taskDoneFollowsSubtasks(tu)
			return su
		}
		const deleteTask = (tu) => {
			for (const [su] of subtasksOf(tu)) remove('subtask', su)
			remove('task', tu)
		}

		const range = (q) => {
			const t = now()
			let from = q.from !== undefined ? Number(q.from) : t - 30 * 86400
			const to = q.to !== undefined ? Number(q.to) : t + 86400
			if (!(to > from)) throw new ApiError('Invalid range')
			from = Math.max(from, to - 400 * 86400)
			return [from, to]
		}

		const routes = [
			['GET', /^state$/, async () => {
				await refreshCalendars()
				const list = commitments()
				const linked = new Set(list.map((c) => c.calendarId).filter((x) => x !== null))
				return {
					commitments: list,
					calendars: calendarList.map((c) => ({ id: calLid(c.url), uri: c.url, name: c.name, color: shortColor(c.color), linked: linked.has(calLid(c.url)), url: c.url })),
					settings: settings(),
					running: running(),
					longBreakUntil: longBreakUntil(),
					now: now(),
					features: { createBlocks: typeof o.calendar.createEvent === 'function', calendars: o.calendar.kind !== 'none', builtinCalendar: builtin, deleteCalendar: !builtin && typeof o.calendar.deleteCalendar === 'function' ? (o.calendar.kind === 'nextcloud' ? 'trash' : 'permanent') : null, calendarView: builtin || typeof o.calendar.updateEvent === 'function' },
					sync: { pending: pendingCount(), lastSync: db.lastSync, server: !!o.remote, refused: db.refused || null },
				}
			}],
			['GET', /^dashboard$/, async () => {
				const t = now()
				await refreshCalendars()
				await processEndedBlocks()
				const s = settings()
				const all = await blocks(t - 86400, t + 14 * 86400)
				const open = tasks(null, false)
				const out = commitments().map((c) => {
					const own = all.filter((b) => b.commitmentId === c.id && b.end > t)
					let current = null
					let next = null
					for (const b of own) {
						if (b.start <= t && b.end > t) current = b
						else if (b.start > t) { next = b; break }
					}
					const queue = open.filter((x) => x.commitmentId === c.id)
					const target = current || next
					const planned = target ? fill(queue, target.end - Math.max(t, target.start), s.defaultEstimate) : queue.slice(0, 3)
					const h7 = t + 7 * 86400
					const blockSeconds = own.reduce((sum, b) => sum + Math.max(0, Math.min(b.end, h7) - Math.max(b.start, t)), 0)
					const neededSeconds = queue.reduce((sum, x) => sum + remaining(x, s.defaultEstimate), 0)
					return {
						commitment: c, currentBlock: current, nextBlock: next, upcoming: own.slice(0, 5),
						plannedTaskIds: planned.map((x) => x.id), queue,
						capacity: { days: 7, blockSeconds, neededSeconds },
					}
				})
				return { now: t, commitments: out, overlaps: findOverlaps(all.filter((b) => b.end > t)), running: running(), longBreakUntil: longBreakUntil(), settings: s }
			}],
			['PUT', /^settings$/, async (m, q, body) => {
				const ch = {}
				const s = settings()
				for (const [k, [, min, max]] of Object.entries(SETTINGS)) {
					if (body[k] !== undefined && body[k] !== null && body[k] !== '' && !isNaN(Number(body[k]))) {
						const v = clampInt(body[k], min, max)
						if (v !== s[k]) ch[k] = v
					}
				}
				for (const k of Object.keys(SETTINGS_BOOL)) {
					if (body[k] !== undefined && !!body[k] !== s[k]) ch[k] = !!body[k]
				}
				writeSettings(ch)
				changed()
				return settings()
			}],

			// commitments
			['POST', /^commitments$/, async (m, q, body) => {
				await refreshCalendars()
				let name = body.name
				let color = shortColor(body.color || '#0082c9')
				let url = null
				if (body.calendarId !== undefined && body.calendarId !== null) {
					const cal = calendarList.find((c) => calLid(c.url) === Number(body.calendarId))
					if (!cal) throw new ApiError('Calendar not found')
					if (Object.values(db.records.commitment).some((r) => r.f.calendarUrl === cal.url)) throw new ApiError('This calendar is already a commitment')
					url = cal.url
					name = cal.name
					color = shortColor(cal.color)
				}
				name = text(name, 255)
				const u = uuid4()
				// Without a calendar, the server creates one on the next sync
				if (url === null && typeof o.calendar.createCalendar === 'function') {
					// Without Nextcloud (a drive), the app makes the calendar (Apple Calendar on the Mac)
					try { url = (await o.calendar.createCalendar({ name, color })) || null } catch (e) { url = null }
				}
				write('commitment', u, { name, color, calendarUrl: url, position: Object.keys(db.records.commitment).length, goal: null, created: now() })
				db.checked[u] = now()
				changed()
				return commitmentJson(u, db.records.commitment[u])
			}],
			['PUT', /^commitments\/(\d+)$/, async (m, q, body) => {
				await refreshCalendars()
				const [u] = byLid('commitment', m[1])
				const ch = {}
				if ('weeklyGoal' in body) {
					const g = body.weeklyGoal === null || body.weeklyGoal === '' ? null : clampInt(body.weeklyGoal, 0, 168 * 60)
					ch.goal = g > 0 ? g : null
				}
				if (body.name !== undefined && body.name !== null) ch.name = text(body.name, 255)
				if (body.color !== undefined && body.color !== null) ch.color = shortColor(body.color)
				if (body.relink) {
					if (body.calendarId === null || body.calendarId === undefined) ch.calendarUrl = null // new calendar: made on sync
					else {
						const cal = calendarList.find((c) => calLid(c.url) === Number(body.calendarId))
						if (!cal) throw new ApiError('Calendar not found')
						ch.calendarUrl = cal.url
					}
				}
				write('commitment', u, ch)
				changed()
				return commitmentJson(u, db.records.commitment[u])
			}],
			['DELETE', /^commitments\/(\d+)$/, async (m, q) => {
				const [u, r] = byLid('commitment', m[1])
				// ?calendar=1: its calendar and events go too, first (built in: its blocks always go)
				if (q.calendar === '1' && !builtin && r.f.calendarUrl && typeof o.calendar.deleteCalendar === 'function') {
					if (Object.entries(db.records.commitment).some(([x, c]) => x !== u && c.f.calendarUrl === r.f.calendarUrl)) throw new ApiError('Another commitment uses this calendar')
					await o.calendar.deleteCalendar(r.f.calendarUrl)
					await refreshCalendars()
				}
				for (const [tu, t] of Object.entries(db.records.task)) if (t.f.commitment === u) deleteTask(tu)
				// Tracked time stays, as unplanned time
				for (const [nu, n] of Object.entries(db.records.note)) if (n.f.commitment === u) remove('note', nu)
				for (const [bu, b] of Object.entries(db.records.block)) if (b.f.commitment === u) remove('block', bu)
				for (const [su, s] of Object.entries(db.records.session)) if (s.f.commitment === u) write('session', su, { commitment: null })
				remove('commitment', u)
				changed()
				return { ok: true }
			}],
			['POST', /^commitments-order$/, async (m, q, body) => {
				let pos = 0
				for (const id of (body.ids || []).slice(0, 500)) {
					const [u] = byLid('commitment', id)
					write('commitment', u, { position: pos++ })
				}
				changed()
				return { ok: true }
			}],

			// tasks
			['GET', /^tasks$/, async (m, q) => {
				const cu = q.commitmentId !== undefined ? commitmentUuid(q.commitmentId) : null
				const done = q.status === 'open' ? false : q.status === 'done' ? true : null
				return tasks(cu, done)
			}],
			['POST', /^tasks$/, async (m, q, body) => {
				const cu = commitmentUuid(body.commitmentId)
				let title = text(body.title, 255)
				const list = []
				for (let st of Array.isArray(body.subtasks) ? body.subtasks : []) {
					st = st && typeof st === 'object' ? st : { title: st }
					if (typeof st.title !== 'string' || !st.title.trim()) continue
					list.push({ title: st.title, estimate: st.estimate !== undefined && st.estimate !== null && !isNaN(Number(st.estimate)) ? Math.trunc(Number(st.estimate)) : null })
				}
				if (list.length > MAX_SUBTASKS) throw new ApiError('Too many subtasks')
				let estimate = body.estimate !== undefined && body.estimate !== null ? Number(body.estimate) : null
				if (!list.length) {
					// "Email supervisor 10m" -> the task and its one subtask, 10 minutes
					if (estimate === null) {
						const [plain, est] = parseEstimate(title)
						if (est !== null) { title = plain; estimate = est }
					}
					list.push({ title, estimate })
				}
				const tu = uuid4()
				const siblings = Object.entries(db.records.task).filter(([, r]) => r.f.commitment === cu)
				write('task', tu, {
					commitment: cu, title, note: text(body.note ?? null, 10000, false), position: maxPos(siblings) + 1,
					done: false, doneAt: null, created: now(), carriedBlocks: [],
				})
				for (const st of list) createSubtask(tu, st.title, st.estimate)
				changed()
				return taskJson(tu, db.records.task[tu])
			}],
			['PUT', /^tasks\/(\d+)$/, async (m, q, body) => {
				const [tu, t] = byLid('task', m[1])
				const ch = {}
				if ('title' in body) {
					const old = t.f.title
					ch.title = text(typeof body.title === 'string' ? body.title : '', 255)
					const subs = subtasksOf(tu)
					if (subs.length === 1 && subs[0][1].f.title === old) write('subtask', subs[0][0], { title: ch.title })
				}
				if ('note' in body) ch.note = text(typeof body.note === 'string' ? body.note : null, 10000, false)
				if ('commitmentId' in body && Number(body.commitmentId) !== lid(t.f.commitment)) {
					const target = commitmentUuid(body.commitmentId)
					ch.commitment = target
					ch.position = maxPos(Object.entries(db.records.task).filter(([, r]) => r.f.commitment === target)) + 1
				}
				write('task', tu, ch)
				changed()
				return taskJson(tu, db.records.task[tu])
			}],
			['DELETE', /^tasks\/(\d+)$/, async (m) => {
				const [tu] = byLid('task', m[1])
				deleteTask(tu)
				changed()
				return { ok: true }
			}],
			['POST', /^tasks-order$/, async (m, q, body) => {
				const cu = commitmentUuid(body.commitmentId)
				let pos = 1
				for (const id of (body.ids || []).slice(0, 2000)) {
					const [tu, t] = byLid('task', id)
					if (t.f.commitment !== cu) continue
					write('task', tu, { position: pos++ })
				}
				changed()
				return { ok: true }
			}],
			['POST', /^tasks\/(\d+)\/subtasks$/, async (m, q, body) => {
				const [tu] = byLid('task', m[1])
				createSubtask(tu, typeof body.title === 'string' ? body.title : '', body.estimate !== undefined && body.estimate !== null ? Number(body.estimate) : null)
				changed()
				return taskJson(tu, db.records.task[tu])
			}],
			['POST', /^tasks\/(\d+)\/subtasks-order$/, async (m, q, body) => {
				const [tu] = byLid('task', m[1])
				const subs = subtasksOf(tu)
				const byId = new Map(subs.map(([su, s]) => [lid(su), [su, s]]))
				const ordered = []
				for (const id of (body.ids || []).slice(0, 2000)) {
					if (byId.has(Number(id))) { ordered.push(byId.get(Number(id))); byId.delete(Number(id)) }
				}
				let pos = 1
				for (const [su, s] of [...ordered, ...byId.values()]) {
					if ((s.f.position || 0) !== pos) write('subtask', su, { position: pos })
					pos++
				}
				changed()
				return taskJson(tu, db.records.task[tu])
			}],
			['PUT', /^subtasks\/(\d+)$/, async (m, q, body) => {
				const [su, s] = byLid('subtask', m[1])
				const ch = {}
				if ('title' in body) ch.title = text(typeof body.title === 'string' ? body.title : '', 255)
				if ('estimate' in body) {
					const e = body.estimate === null || body.estimate === '' || isNaN(Number(body.estimate)) ? null : Math.trunc(Number(body.estimate))
					ch.estimate = e > 0 ? Math.min(e, 100000) : null
				}
				if ('done' in body && !!body.done !== !!s.f.done) {
					ch.done = !!body.done
					ch.doneAt = body.done ? now() : null
				}
				write('subtask', su, ch)
				taskDoneFollowsSubtasks(s.f.task)
				changed()
				return taskJson(s.f.task, db.records.task[s.f.task])
			}],
			['DELETE', /^subtasks\/(\d+)$/, async (m) => {
				const [su, s] = byLid('subtask', m[1])
				const tu = s.f.task
				if (subtasksOf(tu).length <= 1) throw new ApiError('A task needs at least one subtask. Delete the task instead.')
				remove('subtask', su)
				taskDoneFollowsSubtasks(tu)
				changed()
				return taskJson(tu, db.records.task[tu])
			}],

			// notes
			['GET', /^notes$/, async (m, q) => {
				const cu = q.commitmentId !== undefined ? commitmentUuid(q.commitmentId) : null
				const done = q.status === 'open' ? false : q.status === 'done' ? true : null
				return notesOf(cu, done).map(([u, r]) => noteJson(u, r))
			}],
			['POST', /^notes$/, async (m, q, body) => {
				const cu = commitmentUuid(body.commitmentId)
				const own = notesOf(cu, null)
				if (own.length >= MAX_NOTES) throw new ApiError('Too many notes')
				const u = uuid4()
				write('note', u, { commitment: cu, text: noteText(body.text), position: maxPos(own) + 1, done: false, doneAt: null, created: now() })
				changed()
				return noteJson(u, db.records.note[u])
			}],
			['PUT', /^notes\/(\d+)$/, async (m, q, body) => {
				const [u, n] = byLid('note', m[1])
				const ch = {}
				if ('text' in body) ch.text = noteText(body.text)
				if ('done' in body) {
					const done = body.done === true || body.done === 'true' || body.done === 1 || body.done === '1'
					if (done !== !!n.f.done) { ch.done = done; ch.doneAt = done ? now() : null }
				}
				if ('commitmentId' in body && Number(body.commitmentId) !== lid(n.f.commitment)) {
					const target = commitmentUuid(body.commitmentId)
					ch.commitment = target
					ch.position = maxPos(notesOf(target, null)) + 1
				}
				write('note', u, ch)
				changed()
				return noteJson(u, db.records.note[u])
			}],
			['DELETE', /^notes\/(\d+)$/, async (m) => {
				const [u] = byLid('note', m[1])
				remove('note', u)
				changed()
				return { ok: true }
			}],
			['POST', /^notes-order$/, async (m, q, body) => {
				const cu = commitmentUuid(body.commitmentId)
				let pos = 1
				for (const id of (Array.isArray(body.ids) ? body.ids : []).slice(0, MAX_NOTES)) {
					const [u, n] = byLid('note', id)
					if (n.f.commitment !== cu) continue
					if ((n.f.position || 0) !== pos) write('note', u, { position: pos })
					pos++
				}
				changed()
				return { ok: true }
			}],

			// reports
			['GET', /^blocks$/, async (m, q) => {
				await refreshCalendars()
				const [from, to] = range(q)
				const list = await blocks(from, to)
				return { blocks: list, overlaps: findOverlaps(list) }
			}],
			['POST', /^blocks$/, async (m, q, body) => {
				if (typeof o.calendar.createEvent !== 'function') throw new ApiError('Not found', 404)
				const [cu, c] = byLid('commitment', body.commitmentId)
				const start = Math.trunc(Number(body.start))
				const end = Math.trunc(Number(body.end))
				if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 24 * 3600) throw new ApiError('Invalid time')
				if (!calUrlOf(cu, c)) throw new ApiError('This commitment gets its calendar at the next sync. Try again then.')
				const title = text(typeof body.title === 'string' && body.title.trim() ? body.title : c.f.name, 255)
				// Repeats: in the built-in calendar, or a calendar that can change events (Nextcloud)
				const extra = builtin || typeof o.calendar.updateEvent === 'function' ? { ...repeatOf(body, start), tz: typeof body.tz === 'string' ? body.tz : undefined } : {}
				const ev = await o.calendar.createEvent({ url: calUrlOf(cu, c), title, start, end, ...extra })
				return { uid: ev.uid, title, start, end, calendarId: calLid(calUrlOf(cu, c)), commitmentId: lid(cu) }
			}],
			// Built-in calendar: change a block (this occurrence, this and the following ones, or all)
			['PUT', /^blocks\/(\d+)\/(\d+)$/, async (m, q, body) => {
				if (!builtin && typeof o.calendar.updateEvent === 'function') {
					// Nextcloud: the event changes in the commitment's calendar on the server
					const ch = {}
					for (const k of ['start', 'end', 'title', 'repeat', 'until', 'scope', 'tz']) if (body[k] !== undefined) ch[k] = body[k]
					if (body.commitmentId !== undefined) {
						const [cu, c] = byLid('commitment', body.commitmentId)
						if (!calUrlOf(cu, c)) throw new ApiError('This commitment gets its calendar at the next sync. Try again then.')
						ch.url = calUrlOf(cu, c)
					}
					return o.calendar.updateEvent(Number(m[1]), Number(m[2]), ch)
				}
				if (!builtin) throw new ApiError('Not found', 404)
				const [bu, b] = byLid('block', m[1])
				if (!complete('block', b)) throw new ApiError('Not found', 404)
				const occ = Number(m[2])
				if (!occurrences(b.f, occ, occ + 1).includes(occ)) throw new ApiError('Not found', 404)
				const dur = b.f.end - b.f.start
				const start = body.start === undefined ? occ : Math.trunc(Number(body.start))
				const end = body.end === undefined ? start + dur : Math.trunc(Number(body.end))
				if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 24 * 3600 || start < 0) throw new ApiError('Invalid time')
				let commitment = b.f.commitment
				if (body.commitmentId !== undefined) commitment = byLid('commitment', body.commitmentId)[0]
				const title = body.title === undefined ? (b.f.title || '') : (typeof body.title === 'string' ? [...body.title.trim()].slice(0, 255).join('') : '')
				const repeating = !!b.f.repeat
				const scope = repeating && ['this', 'future'].includes(body.scope) ? body.scope : 'all'
				const delta = start - occ
				const rule = body.repeat !== undefined || body.until !== undefined
					? repeatOf({ repeat: body.repeat ?? b.f.repeat, until: body.until === undefined ? b.f.until : body.until }, start)
					: { repeat: b.f.repeat || '', until: b.f.until ? b.f.until + delta : null } // the end moves with the blocks
				if (scope === 'this') {
					// This one only: skipped in the series, kept as its own block
					write('block', bu, { skip: skipList([...(b.f.skip || []), occ]) })
					const nu = uuid4()
					write('block', nu, { commitment, title, start, end, repeat: '', until: null, skip: [], origin: null, created: now() })
					changed()
					return { ok: true, series: lid(nu), occurrence: start }
				}
				if (scope === 'future' && occ !== b.f.start) {
					// The series ends before this one; a new one starts here
					write('block', bu, { until: occ - 1, skip: skipList((b.f.skip || []).filter((x) => x < occ)) })
					const nu = uuid4()
					const skip = skipList((b.f.skip || []).filter((x) => x > occ).map((x) => x + delta))
					write('block', nu, { commitment, title, start, end, ...rule, skip, origin: null, created: now() })
					changed()
					return { ok: true, series: lid(nu), occurrence: start }
				}
				// All of them: the whole series moves by the same amount
				const sStart = b.f.start + delta
				write('block', bu, { commitment, title, start: sStart, end: sStart + (end - start), ...(rule.repeat ? { repeat: rule.repeat, until: rule.until && rule.until < sStart ? null : rule.until } : { repeat: '', until: null }),
					skip: skipList((b.f.skip || []).map((x) => x + delta)) })
				changed()
				return { ok: true, series: lid(bu), occurrence: start }
			}],
			['DELETE', /^blocks\/(\d+)\/(\d+)$/, async (m, q) => {
				if (!builtin && typeof o.calendar.updateEvent === 'function' && typeof o.calendar.deleteEvent === 'function') return o.calendar.deleteEvent(Number(m[1]), Number(m[2]), ['this', 'future'].includes(q.scope) ? q.scope : 'all')
				if (!builtin) throw new ApiError('Not found', 404)
				const [bu, b] = byLid('block', m[1])
				const occ = Number(m[2])
				const scope = b.f.repeat && ['this', 'future'].includes(q.scope) ? q.scope : 'all'
				if (scope === 'this') write('block', bu, { skip: skipList([...(b.f.skip || []), occ]) })
				else if (scope === 'future' && occ > b.f.start) write('block', bu, { until: occ - 1 })
				else remove('block', bu)
				changed()
				return { ok: true }
			}],
			['GET', /^done$/, async (m, q) => {
				const [from, to] = range(q)
				const items = []
				for (const [su, s] of Object.entries(db.records.subtask)) {
					if (!s.f.done || s.f.doneAt === null || s.f.doneAt === undefined || s.f.doneAt < from || s.f.doneAt >= to) continue
					const t = db.records.task[s.f.task]
					if (!t || !complete('subtask', s)) continue
					items.push({ kind: 'subtask', id: lid(su), title: s.f.title, task: t.f.title, taskId: lid(s.f.task), commitmentId: lid(t.f.commitment), doneAt: s.f.doneAt })
				}
				for (const [nu, n] of Object.entries(db.records.note)) {
					if (!n.f.done || n.f.doneAt === null || n.f.doneAt === undefined || n.f.doneAt < from || n.f.doneAt >= to) continue
					if (!complete('note', n)) continue
					items.push({ kind: 'note', id: lid(nu), title: noteTitle(n.f.text), task: null, taskId: null, commitmentId: lid(n.f.commitment), doneAt: n.f.doneAt })
				}
				const kindOrder = (k) => (k === 'note' ? 0 : 1) // same order as the server (by kind name)
				items.sort((a, b) => a.doneAt - b.doneAt || kindOrder(a.kind) - kindOrder(b.kind) || a.id - b.id)
				return items
			}],

			// time tracking
			['GET', /^sessions$/, async (m, q) => {
				const [from, to] = range(q)
				return Object.entries(db.records.session)
					.filter(([, r]) => complete('session', r) && r.f.start < to && (r.f.end === null || r.f.end === undefined || r.f.end > from))
					.sort(([, a], [, b]) => a.f.start - b.f.start)
					.map(([u, r]) => sessionJson(u, r))
			}],
			['POST', /^sessions\/start$/, async (m, q, body) => {
				const t = now()
				const run = runningEntry()
				if (run) write('session', run[0], { end: Math.max(run[1].f.start, t) })
				let cu = null
				let blockUid = null
				if (body.commitmentId !== undefined && body.commitmentId !== null) {
					cu = commitmentUuid(body.commitmentId)
					const cur = (await blocks(t, t + 1, [cu]))[0]
					blockUid = cur ? cur.uid : null
				}
				const s = settings()
				const su = uuid4()
				write('session', su, { commitment: cu, start: t, end: null, blockUid, pomodoro: body.pomodoro === undefined || body.pomodoro === null ? s.pomodoro : !!body.pomodoro })
				// A new focus session ends any long break
				if (longBreakUntil() !== null) writeSettings({ longBreakUntil: null })
				changed()
				return sessionJson(su, db.records.session[su])
			}],
			['POST', /^sessions\/stop$/, async (m, q, body) => {
				const run = runningEntry()
				if (!run) return { session: null, longBreakUntil: longBreakUntil() }
				const t = now()
				const at = body.at !== undefined && body.at !== null ? Number(body.at) : t
				const end = Math.max(run[1].f.start, Math.min(at, t))
				write('session', run[0], { end })
				if (body.longBreak) writeSettings({ longBreakUntil: end + settings().longBreakMinutes * 60 })
				changed()
				return { session: sessionJson(run[0], db.records.session[run[0]]), longBreakUntil: longBreakUntil() }
			}],
			// You started earlier than you pressed play: the running session starts earlier (at most 12 hours
			// back). Right after a switch, the session before ends then too; else it can't reach into it.
			['PUT', /^sessions\/(\d+)$/, async (m, q, body) => {
				const [su, s] = byLid('session', m[1])
				if (!complete('session', s) || (s.f.end !== null && s.f.end !== undefined)) throw new ApiError('Only the running session can be changed')
				const t = now()
				const want = Math.trunc(Number(body.start))
				if (!Number.isFinite(want)) throw new ApiError('Invalid time')
				let start = Math.max(t - 12 * 3600, Math.min(want, t))
				const prev = Object.entries(db.records.session)
					.filter(([u, r]) => u !== su && complete('session', r) && r.f.end !== null && r.f.end !== undefined && r.f.end <= s.f.start)
					.sort(([, a], [, b]) => b.f.end - a.f.end)[0]
				if (prev && s.f.start - prev[1].f.end <= 1) {
					start = Math.max(start, prev[1].f.start + 60) // the one before keeps at least a minute
					write('session', prev[0], { end: start })
				} else if (prev) start = Math.max(start, prev[1].f.end)
				write('session', su, { start })
				changed()
				return { ...sessionJson(su, db.records.session[su]), clamped: start !== want }
			}],
			['DELETE', /^sessions\/(\d+)$/, async (m) => {
				const [su] = byLid('session', m[1])
				remove('session', su)
				changed()
				return { ok: true }
			}],
		]

		/** Answers one API request, like the server would. */
		async function api(method, path, body) {
			const [p, qs] = String(path).split('?')
			const q = Object.create(null)
			for (const part of (qs || '').split('&')) {
				if (!part) continue
				const [k, v = ''] = part.split('=')
				q[decodeURIComponent(k)] = decodeURIComponent(v)
			}
			for (const [m, re, fn] of routes) {
				const match = m === method && re.exec(p)
				if (match) return JSON.parse(JSON.stringify(await fn(match, q, body && typeof body === 'object' ? body : {})))
			}
			throw new ApiError('Not found', 404)
		}

		// --- sync ----------------------------------------------------------------------------

		const dirtyRecords = () => {
			const out = []
			for (const [key, d] of Object.entries(db.dirty)) {
				const [type, u] = key.split(':')
				if (d.deleted) {
					out.push({ type, id: u, deleted: true })
					continue
				}
				const rec = type === 'settings' ? db.settings : db.records[type][u]
				if (!rec) continue
				const fields = {}
				const clock = {}
				for (const k of Object.keys(d)) {
					fields[k] = rec.f[k] ?? null
					clock[k] = rec.c[k]
				}
				out.push({ type, id: u, fields, clock })
			}
			// parents first
			const order = { settings: 0, commitment: 1, task: 2, subtask: 3, note: 4, session: 5, block: 6 }
			// A remote that doesn't keep some types (Nextcloud has real calendars): those stay on this device
			const local = new Set(o.remote && Array.isArray(o.remote.localTypes) ? o.remote.localTypes : [])
			return out.filter((r) => !local.has(r.type)).sort((a, b) => order[a.type] - order[b.type])
		}

		/** Removes a record's children here (the server deletes them too). `tombstone`: remember them as deleted. */
		const dropChildren = (type, u, tombstone = true) => {
			const drop = (t, id) => {
				delete db.records[t][id]
				delete db.dirty[t + ':' + id]
				if (tombstone) db.deleted[id] = t
			}
			if (type === 'task') {
				for (const [su, s] of Object.entries(db.records.subtask)) if (s.f.task === u) drop('subtask', su)
			}
			if (type === 'commitment') {
				for (const [tu, t] of Object.entries(db.records.task)) {
					if (t.f.commitment === u) { dropChildren('task', tu, tombstone); drop('task', tu) }
				}
				for (const [nu, n] of Object.entries(db.records.note)) if (n.f.commitment === u) drop('note', nu)
				for (const [bu, b] of Object.entries(db.records.block)) if (b.f.commitment === u) drop('block', bu)
			}
		}

		/** One record from the server, merged into the local copy. */
		const merge = (rec) => {
			if (!rec || typeof rec !== 'object') return
			const type = rec.type
			if (type !== 'settings' && !TYPES.includes(type)) return
			if (type === 'settings' ? rec.id !== 'settings' : !UUID_RE.test(rec.id)) return
			if (rec.deleted) {
				if (db.records[type] && db.records[type][rec.id]) {
					dropChildren(type, rec.id)
					delete db.records[type][rec.id]
				}
				db.deleted[rec.id] = type
				delete db.dirty[type + ':' + rec.id]
				return
			}
			if (db.deleted[rec.id]) return
			const local = type === 'settings' ? db.settings : (db.records[type][rec.id] || (db.records[type][rec.id] = { f: {}, c: {} }))
			const key = type + ':' + rec.id
			const dirty = db.dirty[key]
			for (const [k, v] of Object.entries(rec.fields || {})) {
				if (!FIELDS[type].includes(k)) continue
				if (k === 'carriedBlocks' ? !(Array.isArray(v) && v.every((x) => typeof x === 'string'))
					: k === 'skip' ? !(Array.isArray(v) && v.length <= 1000 && v.every((x) => Number.isInteger(x)))
						: !okValue(v)) continue
				const rc = rec.clock && typeof rec.clock[k] === 'string' && CLOCK_RE.test(rec.clock[k]) ? rec.clock[k] : ''
				observe(rc)
				if (k === 'carriedBlocks') {
					local.f[k] = carriedSet([...(local.f[k] || []), ...v])
					if (!local.c[k] || rc > local.c[k]) local.c[k] = rc
					continue
				}
				const lc = local.c[k] || ''
				if (rc > lc || (!lc && !(k in local.f))) {
					local.f[k] = v
					local.c[k] = rc
					if (dirty) delete dirty[k] // someone changed it later: our edit lost
				} else if (rc === lc && dirty) {
					delete dirty[k] // the server has our change
				}
			}
			if (dirty && !Object.keys(dirty).length) delete db.dirty[key]
		}

		/** Two devices started a timer offline: older ones end where the newest started. @return true if any changed */
		const oneRunning = () => {
			const run = Object.entries(db.records.session).filter(([, r]) => (r.f.end === null || r.f.end === undefined) && complete('session', r))
			if (run.length < 2) return false
			run.sort(([, a], [, b]) => b.f.start - a.f.start)
			const newest = run[0][1].f.start
			for (const [u, r] of run.slice(1)) write('session', u, { end: Math.max(r.f.start, newest) })
			return true
		}

		/** Push local changes, then pull everyone's. Only one at a time. */
		/** Every field of every record (and the settings) to send again: after the server lost data. */
		const markAllDirty = () => {
			for (const type of TYPES) {
				for (const [u, r] of Object.entries(db.records[type])) {
					const d = db.dirty[type + ':' + u] || (db.dirty[type + ':' + u] = {})
					for (const k of Object.keys(r.f)) if (r.c[k]) d[k] = true
				}
			}
			const d = db.dirty['settings:settings'] || (db.dirty['settings:settings'] = {})
			for (const k of Object.keys(db.settings.f)) if (db.settings.c[k]) d[k] = true
		}

		/**
		 * Sends local changes. A change the server refuses (invalid, or the phone's
		 * clock is far off) is dropped here too, and the server's version is
		 * fetched again, so the phone never keeps data the server doesn't have.
		 * @return {object[]} refused: [{type, id, reason}]
		 */
		const pushDirty = async () => {
			const pushed = dirtyRecords()
			const refused = []
			for (let i = 0; i < pushed.length; i += 2000) {
				const chunk = pushed.slice(i, i + 2000)
				const res = await o.remote.push(chunk)
				const rejected = new Map((res && Array.isArray(res.rejected) ? res.rejected : []).map((r) => [String(r.id), String(r.reason || '')]))
				for (const r of chunk) {
					const key = r.type + ':' + r.id
					const d = db.dirty[key]
					if (!d) continue
					if (r.deleted) { if (d.deleted) delete db.dirty[key]; continue }
					if (rejected.has(r.id)) {
						refused.push({ type: r.type, id: r.id, reason: rejected.get(r.id) })
						delete db.dirty[key]
						if (r.type === 'settings') {
							for (const k of Object.keys(r.fields)) db.settings.c[k] = '' // the server's value wins on the next pull
						} else if (db.records[r.type][r.id]) {
							dropChildren(r.type, r.id, false)
							delete db.records[r.type][r.id] // back from the server on the next pull, if it has it
						}
						continue
					}
					const rec = r.type === 'settings' ? db.settings : db.records[r.type][r.id]
					// Accepted: forget the fields not changed again meanwhile
					for (const k of Object.keys(r.fields)) {
						if (!rec || rec.c[k] === r.clock[k]) delete d[k]
					}
					if (!Object.keys(d).length) delete db.dirty[key]
				}
			}
			if (refused.length) db.cursor = 0 // fetch everything again: restores what the server has
			return refused
		}

		const pullAll = async () => {
			let more = true
			let pages = 0
			let pulled = 0
			let reset = false
			while (more && pages++ < 1000) {
				const res = await o.remote.pull(db.cursor, 1000)
				if (!res || typeof res !== 'object' || !Number.isFinite(res.cursor)) throw new Error('Invalid answer from the server')
				if (res.reset) { db.cursor = 0; reset = true }
				for (const rec of Array.isArray(res.records) ? res.records : []) merge(rec)
				pulled += Array.isArray(res.records) ? res.records.length : 0
				db.cursor = res.cursor
				more = !!res.more
			}
			return { pulled, reset }
		}

		/** Push local changes, then pull everyone's. Only one at a time. */
		async function sync() {
			if (!o.remote) return { ok: false, reason: 'no server' }
			if (syncing) return syncing
			syncing = (async () => {
				const before = pendingCount()
				const refused = await pushDirty()
				let { pulled, reset } = await pullAll()
				if (reset) {
					// The server's data was restored from a backup (or recreated): send it ours again
					markAllDirty()
					refused.push(...await pushDirty())
					pulled += (await pullAll()).pulled
				}
				// One timer runs at a time (Nextcloud does this itself; a drive can't): the newest keeps running
				if (oneRunning()) changed()
				db.lastSync = now()
				if (refused.length) db.refused = { at: now(), reasons: [...new Set(refused.map((r) => r.reason))].slice(0, 5) }
				persist()
				// Tell the app (notifications, the page) without scheduling another sync
				if (o.onChange) {
					try { o.onChange(db, { sync: true }) } catch (e) { /* ignore */ }
				}
				return { ok: true, pushed: before, pulled, refused }
			})()
			try {
				return await syncing
			} finally {
				syncing = null
			}
		}

		/**
		 * Changes made outside the page on this device (Stop in the notification,
		 * the automatic stop at a long break): merged like the server's, and kept
		 * as changes to send unless the server already has them.
		 */
		function importLocal(records) {
			for (const rec of Array.isArray(records) ? records : []) {
				if (!rec || !rec.fields || !rec.clock) continue
				const type = rec.type
				if (type !== 'settings' && !TYPES.includes(type)) continue
				const local = type === 'settings' ? db.settings : db.records[type][rec.id]
				if (!local) continue
				merge(rec)
				const key = type + ':' + rec.id
				for (const k of Object.keys(rec.fields)) {
					if (local.c[k] === rec.clock[k]) (db.dirty[key] || (db.dirty[key] = {}))[k] = true
				}
			}
			changed()
		}

		await refreshCalendars()
		return {
			api,
			sync,
			importLocal,
			node: () => db.node,
			hlc: () => db.hlc,
			ApiError,
			/** Changes not yet sent to the server */
			pending: () => pendingCount(),
			lastSync: () => db.lastSync,
			/** What the native side needs for notifications: running timer, settings, commitments, calendars */
			snapshot: () => ({ node: db.node, hlc: db.hlc, pending: Object.keys(db.dirty).length, running: running(), settings: settings(), longBreakUntil: longBreakUntil(), commitments: commitments().map((c) => ({ id: c.id, uuid: c.uuid, name: c.name, color: c.color, calendarUrl: c.calendarUrl })) }),
			flush: () => o.storage.save(db),
			/** Built-in calendar, for moving to Apple Calendar and back (the app only, not the pages) */
			builtinBlocks: () => Object.entries(db.records.block).filter(([, b]) => complete('block', b)).map(([u, b]) => ({
				uuid: u, commitment: b.f.commitment, title: b.f.title || '', start: b.f.start, end: b.f.end, repeat: b.f.repeat || '', until: b.f.until || null, skip: skipList(b.f.skip), origin: b.f.origin || null })),
			/** Events from another calendar as built-in blocks (one each; an event imported before is not added again) */
			importBlocks: (list) => {
				const seen = new Set(Object.values(db.records.block).map((b) => b.f.origin).filter(Boolean))
				let n = 0
				for (const e of Array.isArray(list) ? list : []) {
					if (!e || !db.records.commitment[e.commitment] || !(e.end > e.start) || e.end - e.start > 86400 || seen.has(e.origin)) continue
					seen.add(e.origin)
					write('block', uuid4(), { commitment: e.commitment, title: [...String(e.title || '')].slice(0, 255).join(''), start: Math.trunc(e.start), end: Math.trunc(e.end), repeat: '', until: null, skip: [], origin: String(e.origin || '').slice(0, 600) || null, created: now() })
					n++
				}
				if (n) changed()
				return n
			},
			/** Occurrences of one built-in block in [from, to) */
			occurrencesOf: (uuid, from, to) => (db.records.block[uuid] ? occurrences(db.records.block[uuid].f, from, to) : []),
			/** Where a block was copied to (or came from): "apple:<event id>" */
			markBlock: (uuid, origin) => { if (db.records.block[uuid]) { write('block', uuid, { origin: String(origin).slice(0, 600) }); changed() } },
			removeBlocks: (uuids) => { for (const u of uuids || []) remove('block', u); changed() },
			linkCalendar: (commitmentUuid, url) => { if (db.records.commitment[commitmentUuid]) { write('commitment', commitmentUuid, { calendarUrl: url }); changed() } },
			/** Moving to a new sync (data taken along): send everything, read the new one from the start */
			resendAll: () => { markAllDirty(); db.cursor = 0; return o.storage.save(db) },
			_db: () => db,
		}
	}

	const api = { createEngine, parseEstimate, ApiError }
	if (typeof module !== 'undefined' && module.exports) module.exports = api
	else root.TrackerEngine = api
})(typeof window !== 'undefined' ? window : globalThis)
