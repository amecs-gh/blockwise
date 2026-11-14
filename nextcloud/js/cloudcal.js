/*
 * Blockwise cloud calendars: a commitment's blocks as events in the calendar of
 * the account you log in with (Google Calendar; Outlook with a Microsoft
 * account), for the apps that sync through a drive (js/filesync.js).
 *
 * Each commitment gets its own calendar, made by Blockwise ("Thesis"); Blockwise
 * only ever touches calendars it made (Google: the calendar.app.created scope).
 * Plan, move or delete a block in Blockwise and the event changes; change the
 * event in Google Calendar or Outlook and Blockwise shows it.
 *
 * Local first. What the calendar last said is kept (`storage`, encrypted by the
 * app) for the weeks around today, so the planner works offline and starts at
 * once; what changes here is shown at once and waits, in order, until the
 * calendar answers again (then it's sent, and the calendar asked again). A page
 * never waits for the network: what is old is asked for in the background and
 * `onChange` says when there is something new.
 *
 * The adapter is what js/engine.js expects as `calendar` (calendars, events,
 * createEvent, updateEvent, deleteEvent, createCalendar, deleteCalendar). The
 * engine names blocks by numbers (blocks/<series>/<occurrence>): the calendar's
 * event ids get small numbers here, kept with the cache.
 *
 * `request(method, path, body)` reaches the provider's API (a path below its
 * fixed address; the app adds the login and refuses anything else) and resolves
 * to the answer's JSON, or rejects with {status} (0 or none: not reachable).
 *
 * Usable in browsers/WebViews (window.BlockwiseCloudCalendar) and Node (require).
 */
;(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory()
	else root.BlockwiseCloudCalendar = factory()
})(typeof self !== 'undefined' ? self : this, function () {
'use strict'

const DAY = 86400
const FRESH = 120000
const RETRY = 60000
// The weeks around today: always kept
const BACK = 42 * DAY
const AHEAD = 120 * DAY
// Ranges on a 6-hour grid: one ending "now" stays the same question (and answer)
const GRID = 6 * 3600
// A block planned here, not sent yet: its number (the calendar's own get smaller ones)
const PENDING = 8e12
const REPEATS = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly']

const gridKey = (from, to) => `${Math.floor(from / GRID) * GRID}-${Math.ceil(to / GRID) * GRID}`
const utcBasic = (sec) => new Date(sec * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const iso = (sec) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const secOf = (s) => {
	const t = Date.parse(s)
	return Number.isFinite(t) ? Math.floor(t / 1000) : NaN
}
const validTz = (tz) => {
	if (typeof tz !== 'string' || !tz || tz.length > 64) return null
	try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz } catch (e) { return null }
}
const localTz = () => {
	try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch (e) { return 'UTC' }
}
const ID_RE = /^[A-Za-z0-9@._=+\-]{1,300}$/
const safeId = (id) => {
	if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Unexpected answer from the calendar.')
	return id
}

/** The planner's repeats as an RRULE (and back; anything else is "custom") */
function toRrule(repeat, until) {
	const r = { daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekly: 'FREQ=WEEKLY', biweekly: 'FREQ=WEEKLY;INTERVAL=2', monthly: 'FREQ=MONTHLY' }[repeat]
	if (!r) return null
	return until ? `${r};UNTIL=${utcBasic(until)}` : r
}
function parseRrule(rule) {
	const parts = {}
	for (const p of String(rule || '').replace(/^RRULE:/i, '').toUpperCase().split(';')) {
		const [k, v] = p.split('=')
		if (k && v !== undefined) parts[k.trim()] = v.trim()
	}
	return parts
}
function fromRrule(rule) {
	if (!rule) return ''
	const p = parseRrule(rule)
	const once = !p.INTERVAL || p.INTERVAL === '1'
	if (p.COUNT) return 'custom'
	if (p.FREQ === 'DAILY' && once && !p.BYDAY) return 'daily'
	if (p.FREQ === 'WEEKLY' && once && p.BYDAY === 'MO,TU,WE,TH,FR') return 'weekdays'
	if (p.FREQ === 'WEEKLY' && !p.BYDAY) return once ? 'weekly' : p.INTERVAL === '2' ? 'biweekly' : 'custom'
	if (p.FREQ === 'MONTHLY' && once && !p.BYDAY && !p.BYMONTHDAY) return 'monthly'
	return 'custom'
}
function untilOf(rule) {
	const u = parseRrule(rule).UNTIL
	if (!u) return null
	const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(u)
	if (!m) return null
	if (!m[4]) return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000) + DAY - 1
	return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000)
}
/** The same rule ending at `until` (or without an end) */
function ruleUntil(rule, until) {
	const keep = String(rule).replace(/^RRULE:/i, '').split(';').filter((p) => p && !/^(UNTIL|COUNT)=/i.test(p))
	if (until !== null && until !== undefined) keep.push(`UNTIL=${utcBasic(until)}`)
	return keep.join(';')
}

/** A block planned here: its occurrences in [from, to) (local time, like the engine) */
function occurrencesOf(o, from, to) {
	const len = o.end - o.start
	const out = []
	const until = o.until || Infinity
	const base = new Date(o.start * 1000)
	for (let k = 0; k < 1000; k++) {
		const at = new Date(base.getTime())
		if (o.repeat === 'monthly') {
			at.setMonth(base.getMonth() + k)
			if (at.getDate() !== base.getDate()) continue
		} else at.setDate(base.getDate() + k * (o.repeat === 'weekly' ? 7 : o.repeat === 'biweekly' ? 14 : 1))
		const s = Math.floor(at / 1000)
		if (s >= to || s > until) break
		const wd = at.getDay()
		if (s + len > from && !(o.repeat === 'weekdays' && (wd === 0 || wd === 6))) out.push(s)
		if (!REPEATS.includes(o.repeat)) break
	}
	return out
}

// --- Google Calendar (https://www.googleapis.com/calendar/v3/) ---------------------------------

const google = {
	prefix: 'gcal:',
	/** One page of events in [from, to): the occurrences (expanded) and the repeating events themselves */
	async read(request, cal, from, to) {
		const enc = encodeURIComponent(cal)
		const items = []
		const masters = new Map()
		for (const single of [true, false]) {
			let page = ''
			for (let n = 0; n < 20; n++) {
				const q = new URLSearchParams({ timeMin: iso(from), timeMax: iso(to), singleEvents: String(single), maxResults: '2500', showDeleted: 'false' })
				if (single) q.set('orderBy', 'startTime')
				if (page) q.set('pageToken', page)
				const r = await request('GET', `calendars/${enc}/events?${q}`)
				for (const e of (r && Array.isArray(r.items) ? r.items : [])) {
					if (!e || typeof e.id !== 'string' || !ID_RE.test(e.id) || e.status === 'cancelled') continue
					if (!single) {
						if (Array.isArray(e.recurrence)) {
							const rule = e.recurrence.find((x) => /^RRULE:/i.test(x))
							if (rule) masters.set(e.id, { rule: rule.slice(6), start: secOf(e.start && e.start.dateTime), tz: e.start && e.start.timeZone })
						}
						continue
					}
					const start = secOf(e.start && e.start.dateTime)
					const end = secOf(e.end && e.end.dateTime)
					if (!(end > start)) continue // all day, or odd: not a block
					const series = typeof e.recurringEventId === 'string' && ID_RE.test(e.recurringEventId) ? e.recurringEventId : e.id
					const occ = series !== e.id ? secOf(e.originalStartTime && e.originalStartTime.dateTime) : start
					items.push({ key: e.id, series, occ: Number.isFinite(occ) ? occ : start, start, end, title: typeof e.summary === 'string' ? e.summary.slice(0, 255) : '', cal })
				}
				page = r && typeof r.nextPageToken === 'string' ? r.nextPageToken : ''
				if (!page) break
			}
		}
		for (const it of items) {
			const m = masters.get(it.series)
			it.repeat = m ? fromRrule(m.rule) : ''
			it.until = m ? untilOf(m.rule) : null
		}
		return items
	},
	body({ title, start, end, rule, tz }) {
		const zone = validTz(tz) || localTz()
		const b = { summary: title, start: { dateTime: iso(start), timeZone: zone }, end: { dateTime: iso(end), timeZone: zone } }
		b.recurrence = rule ? [`RRULE:${rule}`] : []
		return b
	},
	async create(request, cal, ev) {
		const r = await request('POST', `calendars/${encodeURIComponent(cal)}/events`, { ...google.body(ev), extendedProperties: { private: { blockwise: '1' } } })
		return { series: safeId(r && r.id) }
	},
	async master(request, cal, series) {
		const e = await request('GET', `calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(series)}`)
		const rule = e && Array.isArray(e.recurrence) ? (e.recurrence.find((x) => /^RRULE:/i.test(x)) || '').slice(6) : ''
		return { start: secOf(e && e.start && e.start.dateTime), end: secOf(e && e.end && e.end.dateTime), title: e && typeof e.summary === 'string' ? e.summary : '', rule, tz: e && e.start && e.start.timeZone }
	},
	/** One occurrence of a series: Google's id for it */
	instance: async (request, cal, series, occ) => `${series}_${utcBasic(occ)}`,
	async patch(request, cal, id, fields) {
		await request('PATCH', `calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(id)}`, fields)
	},
	async remove(request, cal, id) {
		try {
			await request('DELETE', `calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(id)}`)
		} catch (e) {
			if (e && (e.status === 404 || e.status === 410)) return // gone already
			throw e
		}
	},
	async move(request, cal, id, dest) {
		await request('POST', `calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(id)}/move?destination=${encodeURIComponent(dest)}`)
	},
	times: (start, end, tz) => {
		const zone = validTz(tz) || localTz()
		return { start: { dateTime: iso(start), timeZone: zone }, end: { dateTime: iso(end), timeZone: zone } }
	},
	recurrence: (rule) => ({ recurrence: rule ? [`RRULE:${rule}`] : [] }),
	summary: (title) => ({ summary: title }),
	async createCalendar(request, { name, color }) {
		const r = await request('POST', 'calendars', { summary: String(name || 'Blockwise').slice(0, 200), description: 'Blocks planned in Blockwise', timeZone: localTz() })
		const id = safeId(r && r.id)
		// Its color as in Blockwise (if Google lets the app set it)
		if (/^#[0-9a-fA-F]{6}$/.test(color || '')) {
			try { await request('PATCH', `users/me/calendarList/${encodeURIComponent(id)}?colorRgbFormat=true`, { backgroundColor: color.toLowerCase(), foregroundColor: '#ffffff' }) } catch (e) { /* its default color */ }
		}
		return id
	},
	async deleteCalendar(request, id) {
		try { await request('DELETE', `calendars/${encodeURIComponent(id)}`) } catch (e) { if (!e || e.status !== 404) throw e }
	},
}

// --- Outlook (Microsoft Graph, https://graph.microsoft.com/v1.0/) -------------------------------
//
// Graph names repeats with a pattern and a range (not RRULEs): converted both
// ways here, so the rest works with RRULEs as for Google. Times are sent as the
// wall-clock time in the block's time zone (so a repeat keeps its hour across
// summer time) and come back in UTC. Graph has no "move to another calendar":
// the event is made there and deleted here.

const GRAPH_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const RR_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
/** "YYYY-MM-DDTHH:MM:SS" as the clock shows it in `tz` */
function wall(sec, tz) {
	const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
	const p = {}
	for (const x of f.formatToParts(new Date(sec * 1000))) p[x.type] = x.value
	return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`
}
const wallUtc = (w) => Date.UTC(+w.slice(0, 4), +w.slice(5, 7) - 1, +w.slice(8, 10), +w.slice(11, 13) || 0, +w.slice(14, 16) || 0, +w.slice(17, 19) || 0) / 1000
/** The moment the clock in `tz` shows `w` */
function fromWall(w, tz) {
	const guess = wallUtc(w)
	let t = guess - (wallUtc(wall(guess, tz)) - guess)
	t = guess - (wallUtc(wall(t, tz)) - t)
	return t
}
const dayBefore = (date) => new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) - DAY * 1000).toISOString().slice(0, 10)
/** Graph's {dateTime, timeZone} as seconds (it answers in UTC) */
function graphTime(g) {
	if (!g || typeof g.dateTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(g.dateTime)) return NaN
	const w = g.dateTime.slice(0, 19)
	const tz = g.timeZone && g.timeZone !== 'UTC' ? validTz(g.timeZone) : null
	return tz ? fromWall(w, tz) : secOf(`${w.length === 16 ? `${w}:00` : w}Z`)
}
/** An RRULE (from toRrule/ruleUntil) as Graph's recurrence, for a series starting at `start` */
function graphRecurrence(rule, start, tz) {
	if (!rule) return null
	const zone = validTz(tz) || localTz()
	const p = parseRrule(rule)
	const first = wall(start, zone)
	const interval = Math.max(1, Math.min(99, Number(p.INTERVAL) || 1))
	let pattern
	if (p.FREQ === 'DAILY') pattern = { type: 'daily', interval }
	else if (p.FREQ === 'WEEKLY') {
		const days = p.BYDAY ? p.BYDAY.split(',').map((d) => GRAPH_DAYS[RR_DAYS.indexOf(d.slice(-2))]).filter(Boolean) : []
		pattern = { type: 'weekly', interval, daysOfWeek: days.length ? days : [GRAPH_DAYS[new Date(wallUtc(first) * 1000).getUTCDay()]], firstDayOfWeek: 'monday' }
	} else if (p.FREQ === 'MONTHLY') pattern = { type: 'absoluteMonthly', interval, dayOfMonth: Number(p.BYMONTHDAY) || +first.slice(8, 10) }
	else return null
	const range = { type: 'noEnd', startDate: first.slice(0, 10), recurrenceTimeZone: zone }
	const until = untilOf(rule)
	if (until !== null) {
		// Graph ends on a day: the last one with an occurrence at or before `until`
		const u = wall(until, zone)
		let end = u.slice(0, 10)
		if (u.slice(11) < first.slice(11)) end = dayBefore(end)
		if (end < range.startDate) end = range.startDate
		Object.assign(range, { type: 'endDate', endDate: end })
	} else if (p.COUNT) Object.assign(range, { type: 'numbered', numberOfOccurrences: Math.max(1, Math.min(999, Number(p.COUNT) || 1)) })
	return { pattern, range }
}
/** Graph's recurrence as an RRULE (fromRrule then names the planner's repeats) */
function rruleOfGraph(r, start) {
	const pt = r && r.pattern
	if (!pt || typeof pt.type !== 'string') return ''
	const zone = validTz(r.range && r.range.recurrenceTimeZone) || localTz()
	const interval = Math.max(1, Math.min(99, Number(pt.interval) || 1))
	let rule
	if (pt.type === 'daily') rule = `FREQ=DAILY;INTERVAL=${interval}`
	else if (pt.type === 'weekly') {
		const days = (Array.isArray(pt.daysOfWeek) ? pt.daysOfWeek : []).map((d) => RR_DAYS[GRAPH_DAYS.indexOf(String(d).toLowerCase())]).filter(Boolean)
		const own = Number.isFinite(start) ? RR_DAYS[new Date(wallUtc(wall(start, zone)) * 1000).getUTCDay()] : null
		const sorted = RR_DAYS.filter((d) => days.includes(d))
		rule = `FREQ=WEEKLY;INTERVAL=${interval}`
		if (sorted.join(',') === 'MO,TU,WE,TH,FR') rule += ';BYDAY=MO,TU,WE,TH,FR'
		else if (!(sorted.length === 1 && sorted[0] === own) && sorted.length) rule += `;BYDAY=${sorted.join(',')}`
	} else if (pt.type === 'absoluteMonthly') {
		const own = Number.isFinite(start) ? +wall(start, zone).slice(8, 10) : null
		rule = `FREQ=MONTHLY;INTERVAL=${interval}` + (Number(pt.dayOfMonth) && Number(pt.dayOfMonth) !== own ? `;BYMONTHDAY=${Number(pt.dayOfMonth)}` : '')
	} else rule = `FREQ=YEARLY;INTERVAL=${interval}` // (anything else: shown, not one of the planner's repeats)
	const rg = r.range || {}
	if (rg.type === 'endDate' && /^\d{4}-\d{2}-\d{2}$/.test(rg.endDate || '')) rule += `;UNTIL=${utcBasic(fromWall(`${rg.endDate}T23:59:59`, zone))}`
	else if (rg.type === 'numbered' && Number(rg.numberOfOccurrences) > 0) rule += `;COUNT=${Number(rg.numberOfOccurrences)}`
	return rule
}
/** The nearest of Outlook's calendar colors */
function outlookColor(hex) {
	const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '')
	if (!m) return 'auto'
	const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255)
	const max = Math.max(r, g, b)
	const min = Math.min(r, g, b)
	if (max - min < 0.12) return 'lightGray'
	let h = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4
	h = (h * 60 + 360) % 360
	if (h < 15 || h >= 340) return 'lightRed'
	if (h < 40) return max < 0.6 ? 'lightBrown' : 'lightOrange'
	if (h < 70) return 'lightYellow'
	if (h < 160) return 'lightGreen'
	if (h < 200) return 'lightTeal'
	if (h < 280) return 'lightBlue'
	return 'lightPink'
}
const FIELDS = 'id,subject,start,end,type,seriesMasterId,originalStart,isAllDay,isCancelled'
const enc = encodeURIComponent
const graphEv = (cal, id) => `me/calendars/${enc(cal)}/events/${enc(id)}`

const microsoft = {
	prefix: 'mscal:',
	async read(request, cal, from, to) {
		const items = []
		const masters = new Set()
		let skip = 0
		for (let n = 0; ; n++) {
			// (a cut-off list would look like deleted occurrences)
			if (n >= 100) throw new Error('Too many events in this calendar to read at once.')
			const r = await request('GET', `me/calendars/${enc(cal)}/calendarView?startDateTime=${iso(from)}&endDateTime=${iso(to)}&$top=500&$select=${FIELDS}${skip ? `&$skip=${skip}` : ''}`)
			const list = r && Array.isArray(r.value) ? r.value : []
			for (const e of list) {
				if (!e || typeof e.id !== 'string' || !ID_RE.test(e.id) || e.isCancelled || e.isAllDay) continue
				const start = graphTime(e.start)
				const end = graphTime(e.end)
				if (!(end > start)) continue
				const inSeries = (e.type === 'occurrence' || e.type === 'exception') && typeof e.seriesMasterId === 'string' && ID_RE.test(e.seriesMasterId)
				const series = inSeries ? e.seriesMasterId : e.id
				const occ = inSeries ? secOf(e.originalStart) : start
				if (inSeries) masters.add(series)
				items.push({ key: e.id, series, occ: Number.isFinite(occ) ? occ : start, start, end, title: typeof e.subject === 'string' ? e.subject.slice(0, 255) : '', cal })
			}
			// (only the number of the next page is taken from the answer)
			const next = r && typeof r['@odata.nextLink'] === 'string' ? /[?&](?:\$|%24)skip=(\d{1,6})(?:&|$)/.exec(r['@odata.nextLink']) : null
			if (!next || !list.length || Number(next[1]) <= skip) break
			skip = Number(next[1])
		}
		const rules = new Map()
		for (const id of masters) {
			try { const m = await microsoft.master(request, cal, id); rules.set(id, m.rule) } catch (e) { if (!e || !e.status || e.status >= 500 || e.status === 429) throw e }
		}
		for (const it of items) {
			const rule = rules.get(it.series)
			it.repeat = rule ? fromRrule(rule) : ''
			it.until = rule ? untilOf(rule) : null
		}
		return items
	},
	times: (start, end, tz) => {
		const zone = validTz(tz) || localTz()
		return { start: { dateTime: wall(start, zone), timeZone: zone }, end: { dateTime: wall(end, zone), timeZone: zone } }
	},
	recurrence: (rule, start, tz) => ({ recurrence: rule ? graphRecurrence(rule, start, tz) : null }),
	summary: (title) => ({ subject: title }),
	async create(request, cal, { title, start, end, rule, tz }) {
		const body = { subject: title, ...microsoft.times(start, end, tz) }
		if (rule) body.recurrence = graphRecurrence(rule, start, tz)
		const r = await request('POST', `me/calendars/${enc(cal)}/events`, body)
		return { series: safeId(r && r.id) }
	},
	async master(request, cal, series) {
		const e = await request('GET', `${graphEv(cal, series)}?$select=subject,start,end,recurrence,originalStartTimeZone`)
		const start = graphTime(e && e.start)
		const rec = e && e.recurrence
		return {
			start, end: graphTime(e && e.end), title: e && typeof e.subject === 'string' ? e.subject : '',
			rule: rec ? rruleOfGraph(rec, start) : '',
			tz: validTz(rec && rec.range && rec.range.recurrenceTimeZone) || validTz(e && e.originalStartTimeZone) || null,
			recurrence: rec || null,
		}
	},
	/** One occurrence of a series: Graph's id for it (asked for) */
	async instance(request, cal, series, occ) {
		const r = await request('GET', `${graphEv(cal, series)}/instances?startDateTime=${iso(occ - 35 * DAY)}&endDateTime=${iso(occ + 35 * DAY)}&$top=200&$select=id,originalStart`)
		const hit = (r && Array.isArray(r.value) ? r.value : []).find((e) => e && secOf(e.originalStart) === occ)
		if (!hit) throw Object.assign(new Error('This occurrence is no longer in the calendar.'), { status: 404 })
		return safeId(hit.id)
	},
	async patch(request, cal, id, fields) {
		await request('PATCH', graphEv(cal, id), fields)
	},
	async remove(request, cal, id) {
		try {
			await request('DELETE', graphEv(cal, id))
		} catch (e) {
			if (e && (e.status === 404 || e.status === 410)) return
			throw e
		}
	},
	async move(request, cal, id, dest) {
		const m = await microsoft.master(request, cal, id)
		const body = { subject: m.title, ...microsoft.times(m.start, m.end, m.tz) }
		if (m.recurrence) body.recurrence = graphRecurrence(m.rule, m.start, m.tz)
		await request('POST', `me/calendars/${enc(dest)}/events`, body)
		await microsoft.remove(request, cal, id)
	},
	async createCalendar(request, { name, color }) {
		// (the app marks it as Blockwise's: only such calendars are reachable)
		const r = await request('POST', 'me/calendars', { name: String(name || 'Blockwise').slice(0, 200), color: outlookColor(color) })
		return safeId(r && r.id)
	},
	async deleteCalendar(request, id) {
		try { await request('DELETE', `me/calendars/${enc(id)}`) } catch (e) { if (!e || e.status !== 404) throw e }
	},
}

const PROVIDERS = { google, microsoft }

/**
 * @param {object} o
 * @param {'google'|'microsoft'} o.provider
 * @param {(method: string, path: string, body?: object) => Promise<any>} o.request
 * @param {{load: () => Promise<string|null>, save: (text: string) => Promise<void>}} [o.storage]
 * @param {() => void} [o.onChange] new blocks to show (draw again)
 * @param {(loading: boolean) => void} [o.onLoading]
 * @param {() => void} [o.onOffline] the calendar didn't answer
 * @param {(messages: string[]) => void} [o.onRefused] changes the calendar didn't take (dropped)
 */
function createCloudCalendar(o) {
	const P = PROVIDERS[o.provider]
	if (!P) throw new Error('Unknown calendar')
	const now = o.now || (() => Math.floor(Date.now() / 1000))
	const clock = o.clock || (() => Date.now())
	const request = o.request
	const fire = (name, ...a) => { try { if (typeof o[name] === 'function') o[name](...a) } catch (e) { /* the page's */ } }

	// Kept: answers per range, the changes waiting, numbers for the calendar's ids
	const windows = new Map() // key -> {at, items: {cal -> [item]}, failed}
	let ops = []
	let nextPid = 1
	let ids = { next: 1, of: {} } // series id -> number
	const keyOf = new Map()
	const sentAs = new Map() // pid -> series id (sent since)
	const num = (series) => {
		if (!ids.of[series]) ids.of[series] = ids.next++
		keyOf.set(ids.of[series], series)
		return ids.of[series]
	}
	let loaded = null
	const load = () => {
		if (!loaded) {
			loaded = (async () => {
				try {
					const t = o.storage ? await o.storage.load() : null
					const kept = t ? JSON.parse(t) : null
					if (!kept) return
					for (const [k, items] of kept.windows || []) if (items && typeof items === 'object' && !windows.has(k)) windows.set(k, { at: 0, items })
					if (Array.isArray(kept.ops)) ops = kept.ops.concat(ops)
					if (Number.isFinite(kept.nextPid)) nextPid = Math.max(nextPid, kept.nextPid)
					if (kept.ids && typeof kept.ids.of === 'object') {
						ids = { next: Math.max(ids.next, kept.ids.next || 1), of: { ...kept.ids.of, ...ids.of } }
						for (const [s, n] of Object.entries(ids.of)) keyOf.set(n, s)
					}
				} catch (e) { /* nothing kept */ }
				if (ops.length) flushSoon(500)
			})()
		}
		return loaded
	}
	let keepTimer = null
	const keepSoon = () => {
		if (!o.storage) return
		clearTimeout(keepTimer)
		keepTimer = setTimeout(() => {
			// The newest ranges, and the ids still in them (or waiting)
			const kept = [...windows].sort((a, b) => b[1].at - a[1].at).slice(0, 10)
			const used = new Set()
			for (const [, w] of kept) for (const list of Object.values(w.items)) for (const it of list) used.add(it.series)
			for (const x of ops) if (x.series) used.add(x.series)
			const of = {}
			for (const s of used) if (ids.of[s]) of[s] = ids.of[s]
			o.storage.save(JSON.stringify({ v: 1, windows: kept.map(([k, w]) => [k, w.items]), ops, nextPid, ids: { next: ids.next, of } })).catch(() => {})
		}, 600)
	}

	let asking = 0
	let offline = false
	let offlineSaid = 0
	const asked = (d) => { asking += d; fire('onLoading', asking > 0 && !offline) }
	const unreachable = () => {
		// What waits is tried again in a minute (and as soon as anything gets through)
		if (ops.length) flushSoon(RETRY)
		if (!offline) { offline = true; fire('onLoading', false); fire('onChange') }
		if (clock() - offlineSaid > 10 * 60000) { offlineSaid = clock(); fire('onOffline') }
	}
	const reachable = () => {
		offline = false
		offlineSaid = 0
		if (ops.length) flushSoon(300)
	}
	const notReachable = (e) => !e || !e.status || e.status >= 500 || e.status === 401 || e.status === 429

	const asks = new Map()
	/** Asks the calendar for [range] of these calendars, in the background */
	function ask(key, cals) {
		if (asks.has(key)) return asks.get(key)
		const [from, to] = key.split('-').map(Number)
		asked(1)
		const p = (async () => {
			try {
				const items = {}
				for (const cal of cals) items[cal] = await P.read(request, cal, from, to)
				const before = windows.get(key)
				const merged = { ...(before ? before.items : {}), ...items }
				windows.delete(key)
				windows.set(key, { at: clock(), items: merged })
				while (windows.size > 30) windows.delete(windows.keys().next().value)
				reachable()
				keepSoon()
				if (!before || JSON.stringify(before.items) !== JSON.stringify(merged)) fire('onChange')
			} catch (e) {
				const before = windows.get(key)
				windows.set(key, { at: clock() - FRESH + RETRY, items: before ? before.items : {}, failed: !before })
				if (notReachable(e)) unreachable()
			}
		})().finally(() => { asks.delete(key); asked(-1) })
		asks.set(key, p)
		return p
	}
	const windowKey = () => {
		const d = new Date()
		d.setHours(0, 0, 0, 0)
		const t = Math.floor(d / 1000)
		return gridKey(t - BACK, t + AHEAD)
	}
	/** The kept answer covering [from, to) for these calendars, if any: [key, window] */
	function known(from, to, cals) {
		const has = (w) => cals.every((c) => Array.isArray(w.items[c]))
		const exact = gridKey(from, to)
		if (windows.has(exact) && has(windows.get(exact))) return [exact, windows.get(exact)]
		let best = null
		for (const [k, w] of windows) {
			const [a, b] = k.split('-').map(Number)
			if (a <= from && b >= to && has(w) && (!best || w.at > best[1].at)) best = [k, w]
		}
		return best
	}

	// --- the changes waiting, on top of what the calendar said ---
	const touches = (it, x) => it.series === x.series && (!it.repeat || x.scope === 'all' || !x.scope
		|| (x.scope === 'this' ? it.occ === x.occ : it.occ >= x.occ))
	function withChanges(list, cal, from, to) {
		let out = list.slice()
		for (const x of ops) {
			if (x.op === 'create') {
				const skip = new Set(x.skip || [])
				if (x.cal === cal) for (const s of occurrencesOf(x, from - DAY, to + DAY)) if (!skip.has(s)) out.push({ key: `pending-${x.pid}#${s}`, pid: x.pid, series: null, occ: s, start: s, end: s + (x.end - x.start), title: x.title, cal, repeat: x.repeat || '', until: x.until || null })
			} else if (x.op === 'delete') {
				out = out.filter((it) => !touches(it, x))
			} else if (x.op === 'update') {
				const ch = x.ch
				const delta = ch.start !== undefined ? ch.start - x.occ : 0
				out = out.map((it) => {
					if (!touches(it, x)) return it
					const start = it.start + delta
					const len = ch.start !== undefined && ch.end !== undefined ? ch.end - ch.start : it.end - it.start
					return { ...it, start, end: start + len, title: ch.title !== undefined ? ch.title : it.title, cal: ch.cal || it.cal, repeat: ch.repeat !== undefined && ch.repeat !== 'custom' ? ch.repeat : it.repeat }
				})
			}
		}
		return out.filter((it) => it.cal === cal || !it.cal)
	}
	/** Moved to another commitment's calendar: shown there (from what the change says) */
	function movedInto(cal, from, to) {
		const out = []
		for (const x of ops) {
			if (x.op !== 'update' || !x.ch.cal || x.ch.cal !== cal || x.cal === cal) continue
			const ch = x.ch
			const start = ch.start !== undefined ? ch.start : x.start
			const len = ch.start !== undefined && ch.end !== undefined ? ch.end - ch.start : x.end - x.start
			if (start + len > from && start < to) out.push({ key: `moved-${x.series}#${x.occ}`, series: x.series, occ: x.occ, start, end: start + len, title: ch.title !== undefined ? ch.title : x.title, cal, repeat: '', until: null })
		}
		return out
	}

	// --- sending ---
	let flushTimer = null
	let flushing = null
	const flushSoon = (ms) => { clearTimeout(flushTimer); flushTimer = setTimeout(flush, ms) }
	function flush() {
		if (flushing || !ops.length) return flushing || Promise.resolve()
		flushing = (async () => {
			let sent = 0
			const refused = []
			while (ops.length) {
				const x = ops[0]
				try {
					await send(x)
				} catch (e) {
					if (notReachable(e)) { unreachable(); break }
					refused.push(e && e.message ? String(e.message).slice(0, 160) : 'refused')
				}
				ops.shift()
				sent++
				keepSoon()
			}
			if (refused.length) fire('onRefused', [...new Set(refused)])
			if (sent) {
				// What the calendar has now: asked again
				for (const w of windows.values()) w.at = 0
				fire('onChange')
			}
		})().finally(() => { flushing = null })
		return flushing
	}
	async function send(x) {
		if (x.op === 'create') {
			const r = await P.create(request, x.cal, { title: x.title, start: x.start, end: x.end, rule: toRrule(x.repeat, x.until), tz: x.tz })
			sentAs.set(x.pid, r.series)
			// (copied in with occurrences deleted before: deleted there too)
			for (const s of Array.isArray(x.skip) ? x.skip.slice(0, 200) : []) {
				if (Number.isFinite(s)) await P.instance(request, x.cal, r.series, s).then((id) => P.remove(request, x.cal, id)).catch(() => {})
			}
			return
		}
		const single = !x.repeat
		if (x.op === 'delete') {
			if (single || x.scope === 'all' || !x.scope) return P.remove(request, x.cal, x.series)
			if (x.scope === 'this') return P.remove(request, x.cal, await P.instance(request, x.cal, x.series, x.occ))
			const m = await P.master(request, x.cal, x.series)
			if (x.occ <= m.start) return P.remove(request, x.cal, x.series)
			return P.patch(request, x.cal, x.series, P.recurrence(ruleUntil(m.rule, x.occ - 1), m.start, m.tz))
		}
		// update
		const ch = x.ch
		const len = ch.start !== undefined && ch.end !== undefined ? ch.end - ch.start : null
		const fields = {}
		if (ch.title !== undefined) Object.assign(fields, P.summary(ch.title))
		if (single || x.scope === 'this') {
			const id = single ? x.series : await P.instance(request, x.cal, x.series, x.occ)
			const newStart = ch.start !== undefined ? ch.start : x.start
			if (ch.start !== undefined || ch.end !== undefined) {
				Object.assign(fields, P.times(newStart, len !== null ? newStart + len : (ch.end !== undefined ? ch.end : x.end), ch.tz))
			}
			if (single && ch.repeat !== undefined && ch.repeat !== 'custom') Object.assign(fields, P.recurrence(toRrule(ch.repeat, ch.until), newStart, ch.tz))
			if (Object.keys(fields).length) await P.patch(request, x.cal, id, fields)
			if (ch.cal && ch.cal !== x.cal) {
				if (single) await P.move(request, x.cal, x.series, ch.cal)
				else {
					// One occurrence to another commitment: off the series here, a single event there
					await P.remove(request, x.cal, id)
					const start = ch.start !== undefined ? ch.start : x.start
					await P.create(request, ch.cal, { title: ch.title !== undefined ? ch.title : x.title, start, end: len !== null ? start + len : x.end - x.start + start, rule: null, tz: ch.tz })
				}
			}
			return
		}
		const m = await P.master(request, x.cal, x.series)
		const delta = ch.start !== undefined ? ch.start - x.occ : 0
		const mlen = len !== null ? len : m.end - m.start
		let rule = m.rule
		if (ch.repeat !== undefined && ch.repeat !== 'custom') rule = toRrule(ch.repeat, ch.until === undefined ? untilOf(m.rule) : ch.until)
		else if (ch.until !== undefined) rule = ruleUntil(m.rule, ch.until)
		else if (untilOf(m.rule) && delta) rule = ruleUntil(m.rule, untilOf(m.rule) + delta)
		if (x.scope === 'future' && x.occ > m.start) {
			// This one and the following: the series ends before it, a new one starts here
			await P.patch(request, x.cal, x.series, P.recurrence(ruleUntil(m.rule, x.occ - 1), m.start, m.tz))
			const start = x.occ + delta
			await P.create(request, ch.cal || x.cal, { title: ch.title !== undefined ? ch.title : m.title, start, end: start + mlen, rule, tz: ch.tz || m.tz })
			return
		}
		const start = m.start + delta
		Object.assign(fields, P.times(start, start + mlen, ch.tz || m.tz), P.recurrence(rule, start, ch.tz || m.tz))
		await P.patch(request, x.cal, x.series, fields)
		if (ch.cal && ch.cal !== x.cal) await P.move(request, x.cal, x.series, ch.cal)
	}

	const urlOf = (cal) => P.prefix + cal
	const calOf = (url) => (typeof url === 'string' && url.startsWith(P.prefix) && ID_RE.test(url.slice(P.prefix.length)) ? url.slice(P.prefix.length) : null)
	const queue = (x) => { ops.push(x); keepSoon(); flushSoon(300) }
	/** The block (as last shown) with this number and occurrence */
	function find(series, occ) {
		const key = keyOf.get(series)
		if (!key) return null
		for (const w of [...windows.values()].sort((a, b) => b.at - a.at)) {
			for (const list of Object.values(w.items)) {
				const it = list.find((x) => x.series === key && x.occ === occ) || list.find((x) => x.series === key)
				if (it) return it
			}
		}
		return null
	}

	const adapter = {
		kind: o.provider,
		/** The commitments' calendars (the app knows them: the engine keeps their urls) */
		async calendars() {
			await load()
			const list = typeof o.calendarsOf === 'function' ? (o.calendarsOf() || []) : []
			return list.filter((c) => calOf(c.url)).map((c) => ({ url: c.url, name: c.name, color: c.color, writable: true }))
		},
		async events(from, to, urls) {
			await load()
			const cals = [...new Set(urls.map(calOf).filter(Boolean))]
			if (!cals.length) return []
			// The weeks around today, for every page (and for offline)
			const wk = windowKey()
			const w = windows.get(wk)
			if (!w || clock() - w.at > FRESH || !cals.every((c) => Array.isArray(w.items[c]))) {
				if (!w || clock() - w.at > RETRY / 2 || !cals.every((c) => Array.isArray(w.items[c]))) ask(wk, cals)
			}
			let k = known(from, to, cals)
			if (!k) ask(gridKey(from, to), cals)
			else if (clock() - k[1].at > FRESH && k[0] !== wk) ask(k[0], cals)
			const items = k ? k[1].items : {}
			const out = []
			for (const cal of cals) {
				const list = withChanges(items[cal] || [], cal, from, to).concat(movedInto(cal, from, to))
				for (const it of list) {
					if (!(it.end > from && it.start < to)) continue
					out.push({
						uid: it.key, title: it.title, start: it.start, end: it.end, url: urlOf(cal),
						series: it.pid !== undefined ? PENDING + it.pid : num(it.series), occurrence: it.occ, repeat: it.repeat || '', until: it.until || null,
					})
				}
			}
			if (!k || k[1].failed) out.incomplete = true
			return out
		},
		async createEvent(ev) {
			await load()
			const cal = calOf(ev.url)
			if (!cal) throw new Error('This commitment has no calendar yet. Try again when you are online.')
			const pid = nextPid++
			queue({ op: 'create', pid, cal, title: String(ev.title || '').slice(0, 255), start: ev.start, end: ev.end, repeat: REPEATS.includes(ev.repeat) ? ev.repeat : '', until: ev.until || null, tz: validTz(ev.tz) })
			return { uid: `pending-${pid}#${ev.start}` }
		},
		async updateEvent(series, occ, ch) {
			await load()
			const cal = ch.url !== undefined ? calOf(ch.url) : undefined
			if (ch.url !== undefined && !cal) throw new Error('This commitment has no calendar yet. Try again when you are online.')
			if (series >= PENDING) {
				const pid = series - PENDING
				const x = ops.find((y) => y.op === 'create' && y.pid === pid)
				if (!x) {
					if (!sentAs.has(pid)) throw new Error('This block is gone. Pull to refresh.')
					return adapter.updateEvent(num(sentAs.get(pid)), occ, ch)
				}
				const len = x.end - x.start
				if (ch.start !== undefined) x.start += ch.start - occ
				x.end = ch.start !== undefined && ch.end !== undefined ? x.start + (ch.end - ch.start) : x.start + len
				if (ch.title !== undefined) x.title = String(ch.title).slice(0, 255)
				if (cal) x.cal = cal
				if (ch.repeat !== undefined && ch.repeat !== 'custom') x.repeat = REPEATS.includes(ch.repeat) ? ch.repeat : ''
				if (ch.until !== undefined) x.until = ch.until || null
				keepSoon()
				flushSoon(300)
				return { ok: true, series, occurrence: x.start }
			}
			const it = find(series, occ)
			if (!it) throw new Error('This block is gone. Pull to refresh.')
			const change = {}
			for (const f of ['start', 'end', 'title', 'repeat', 'until', 'tz']) if (ch[f] !== undefined) change[f] = ch[f]
			if (cal) change.cal = cal
			const scope = ['this', 'future', 'all'].includes(ch.scope) ? ch.scope : 'all'
			queue({ op: 'update', series: it.series, occ, scope, cal: it.cal, repeat: it.repeat || '', start: it.start, end: it.end, title: it.title, ch: change })
			return { ok: true, series, occurrence: ch.start !== undefined ? ch.start : occ }
		},
		async deleteEvent(series, occ, scope) {
			await load()
			if (series >= PENDING) {
				const pid = series - PENDING
				const i = ops.findIndex((y) => y.op === 'create' && y.pid === pid)
				if (i >= 0) { ops.splice(i, 1); keepSoon(); return { ok: true } }
				if (!sentAs.has(pid)) return { ok: true }
				return adapter.deleteEvent(num(sentAs.get(pid)), occ, scope)
			}
			const it = find(series, occ)
			if (!it) return { ok: true }
			queue({ op: 'delete', series: it.series, occ, scope: ['this', 'future', 'all'].includes(scope) ? scope : 'all', cal: it.cal, repeat: it.repeat || '' })
			return { ok: true }
		},
		/** A calendar for a new commitment (needs the calendar to answer) */
		async createCalendar({ name, color }) {
			try {
				const id = await P.createCalendar(request, { name, color })
				reachable()
				return urlOf(id)
			} catch (e) {
				if (notReachable(e)) unreachable()
				throw e
			}
		},
		async deleteCalendar(url) {
			const cal = calOf(url)
			if (cal) await P.deleteCalendar(request, cal)
		},
		// --- for the app ---
		loading: () => asking > 0 && !offline,
		offline: () => offline,
		/** Changes waiting for the calendar */
		pending: () => ops.length,
		/** Sends what waits now (e.g. back online) */
		flush: () => load().then(flush),
		/** The calendar's url for a calendar id, and back */
		urlOf,
		calOf,
		/**
		 * Everything in [from, to) as the calendar has it now (moving back to the
		 * built-in calendar): waits for the network; refuses while changes still wait.
		 */
		async readAll(from, to, urls) {
			await load()
			await flush()
			if (ops.length) throw new Error('Some changes have not reached the calendar yet. Try again when you are online.')
			const out = []
			for (const cal of [...new Set(urls.map(calOf).filter(Boolean))]) {
				let items
				try { items = await P.read(request, cal, from, to) } catch (e) {
					if (notReachable(e)) unreachable()
					throw new Error('The calendar could not be read. Try again when you are online.')
				}
				for (const it of items) out.push({ uid: it.key, title: it.title, start: it.start, end: it.end, url: urlOf(cal), series: num(it.series), occurrence: it.occ, repeat: it.repeat || '', until: it.until || null })
			}
			return out
		},
		/** Copies blocks in (moving from the built-in calendar): queued like any new block */
		async importBlocks(list) {
			await load()
			let n = 0
			for (const b of list || []) {
				const cal = calOf(b.url)
				if (!cal || !(b.end > b.start)) continue
				const repeat = REPEATS.includes(b.repeat) ? b.repeat : ''
				ops.push({ op: 'create', pid: nextPid++, cal, title: String(b.title || '').slice(0, 255), start: b.start, end: b.end, repeat, until: b.until || null, tz: validTz(b.tz), skip: repeat && Array.isArray(b.skip) ? b.skip.filter(Number.isFinite) : [] })
				n++
			}
			keepSoon()
			flushSoon(300)
			return n
		},
	}
	return adapter
}

return { createCloudCalendar, toRrule, fromRrule, untilOf, ruleUntil, occurrencesOf, PROVIDERS, graphRecurrence, rruleOfGraph, outlookColor, wall, fromWall }
})
