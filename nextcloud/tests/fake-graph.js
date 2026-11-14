/*
 * A stand-in for Microsoft Graph's calendar API (the parts Blockwise uses), in
 * memory: calendars, events with repeats (daily, weekly on days, absolute
 * monthly; an end date or a count), single occurrences changed or cancelled.
 * Times come in as the wall clock in a time zone and go out in UTC, as Graph
 * does. Ids are opaque. `request(method, path, body)` answers like the app's
 * request function. Strict where Graph is (a repeat must start on the event's
 * day) and where Blockwise must be (only subject, start, end and recurrence).
 */
'use strict'

const { wall, fromWall } = require('../js/cloudcal.js')
const DAY = 86400
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const out = (sec) => ({ dateTime: new Date(sec * 1000).toISOString().slice(0, 19) + '.0000000', timeZone: 'UTC' })
const isoZ = (sec) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const inSec = (g) => fromWall(g.dateTime.slice(0, 19), g.timeZone)
const dateUtc = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 1000

/** A series' occurrence starts in [from, to) */
function expand(e, from, to) {
	if (!e.recurrence) return e.start < to && e.end > from ? [e.start] : []
	const { pattern: p, range: r } = e.recurrence
	const tz = r.recurrenceTimeZone || e.tz
	const first = wall(e.start, tz)
	const time = first.slice(11)
	const day0 = dateUtc(first.slice(0, 10))
	const len = e.end - e.start
	const outList = []
	let count = 0
	const monday0 = day0 - ((new Date(day0 * 1000).getUTCDay() + 6) % 7) * DAY
	for (let k = 0; k < 3000; k++) {
		const d = day0 + k * DAY
		const date = new Date(d * 1000).toISOString().slice(0, 10)
		if (r.type === 'endDate' && date > r.endDate) break
		const wd = new Date(d * 1000).getUTCDay()
		let hit = false
		if (p.type === 'daily') hit = k % p.interval === 0
		else if (p.type === 'weekly') hit = Math.floor((d - monday0) / (7 * DAY)) % p.interval === 0 && p.daysOfWeek.includes(DAYS[wd])
		else if (p.type === 'absoluteMonthly') {
			const months = (new Date(d * 1000).getUTCFullYear() - new Date(day0 * 1000).getUTCFullYear()) * 12 + new Date(d * 1000).getUTCMonth() - new Date(day0 * 1000).getUTCMonth()
			hit = new Date(d * 1000).getUTCDate() === p.dayOfMonth && months % p.interval === 0
		}
		if (!hit) continue
		count++
		if (r.type === 'numbered' && count > r.numberOfOccurrences) break
		const t = fromWall(`${date}T${time}`, tz)
		if (t >= to) break
		if (t + len > from) outList.push(t)
	}
	return outList
}

function fakeGraph({ pageSize = 7 } = {}) {
	const cals = new Map() // id -> {name, color, events: Map}
	const account = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 5)
	let n = 1
	const id = (kind) => `AAMk${account}${kind}${n++}AAA=`
	const calls = []
	let down = false
	const err = (status, message) => Object.assign(new Error(message || `HTTP ${status}`), { status })
	const cal = (cid) => { const c = cals.get(decodeURIComponent(cid)); if (!c) throw err(404, 'ErrorItemNotFound'); return c }
	const strict = (body, keys) => {
		for (const k of Object.keys(body || {})) if (!keys.includes(k)) throw err(400, `Blockwise must not send ${k}`)
	}
	function checkRecurrence(e) {
		if (!e.recurrence) return
		const tz = e.recurrence.range.recurrenceTimeZone || e.tz
		if (e.recurrence.range.startDate !== wall(e.start, tz).slice(0, 10)) throw err(400, 'The recurrence pattern does not start on the event\'s day')
		if (!e.recurrence.pattern.interval) throw err(400, 'interval')
	}
	const occId = (m, t) => `${m.id}OCC${t}`
	/** The occurrences and exceptions of a series, or a single event, overlapping [from, to) */
	function view(c, from, to) {
		const list = []
		for (const e of c.events.values()) {
			if (e.master) continue
			if (!e.recurrence) {
				if (e.start < to && e.end > from) list.push(shape(e, 'singleInstance'))
				continue
			}
			for (const t of expand(e, from - 60 * DAY, to + 60 * DAY)) {
				const ex = c.events.get(occId(e, t))
				if (ex) {
					if (!ex.cancelled && ex.start < to && ex.end > from) list.push(shape(ex, 'exception'))
					continue
				}
				if (t < to && t + (e.end - e.start) > from) list.push({ id: occId(e, t), subject: e.subject, start: out(t), end: out(t + e.end - e.start), type: 'occurrence', seriesMasterId: e.id, originalStart: isoZ(t), isAllDay: false, isCancelled: false })
			}
		}
		return list.sort((a, b) => inSec(a.start) - inSec(b.start))
	}
	function shape(e, type) {
		const o = { id: e.id, subject: e.subject, start: out(e.start), end: out(e.end), type, isAllDay: false, isCancelled: false }
		if (e.master) { o.seriesMasterId = e.master; o.originalStart = isoZ(e.originalStart) }
		if (type === 'seriesMaster' || e.recurrence) { o.type = 'seriesMaster'; o.recurrence = e.recurrence; o.originalStartTimeZone = e.tz }
		return o
	}
	async function request(method, path, body) {
		calls.push(`${method} ${path}`)
		if (down) throw Object.assign(new Error('offline'), { status: 0 })
		const [p, qs] = path.split('?')
		const q = new URLSearchParams((qs || '').replace(/\$/g, '%24'))
		let m
		if (method === 'POST' && p === 'me/calendars') {
			strict(body, ['name', 'color'])
			const cid = id('cal')
			cals.set(cid, { name: body.name, color: body.color, events: new Map() })
			return { id: cid, name: body.name, color: body.color }
		}
		if ((m = /^me\/calendars\/([^/]+)$/.exec(p)) && method === 'DELETE') { cal(m[1]); cals.delete(decodeURIComponent(m[1])); return null }
		if ((m = /^me\/calendars\/([^/]+)\/calendarView$/.exec(p)) && method === 'GET') {
			const all = view(cal(m[1]), Math.floor(Date.parse(q.get('startDateTime')) / 1000), Math.floor(Date.parse(q.get('endDateTime')) / 1000))
			const skip = Number(q.get('$skip') || 0)
			const top = Math.min(Number(q.get('$top') || 10), pageSize)
			const page = all.slice(skip, skip + top)
			const r = { value: page }
			if (skip + top < all.length) r['@odata.nextLink'] = `https://graph.microsoft.com/v1.0/me/calendars('x')/calendarView?startDateTime=${q.get('startDateTime')}&$skip=${skip + top}`
			return r
		}
		if ((m = /^me\/calendars\/([^/]+)\/events$/.exec(p)) && method === 'POST') {
			const c = cal(m[1])
			strict(body, ['subject', 'start', 'end', 'recurrence'])
			const e = { id: id('ev'), subject: body.subject, start: inSec(body.start), end: inSec(body.end), tz: body.start.timeZone, recurrence: body.recurrence || null }
			checkRecurrence(e)
			c.events.set(e.id, e)
			return shape(e, e.recurrence ? 'seriesMaster' : 'singleInstance')
		}
		if ((m = /^me\/calendars\/([^/]+)\/events\/([^/]+)\/instances$/.exec(p)) && method === 'GET') {
			const c = cal(m[1])
			const sid = decodeURIComponent(m[2])
			const e = c.events.get(sid)
			if (!e || !e.recurrence) throw err(404, 'ErrorItemNotFound')
			const from = Math.floor(Date.parse(q.get('startDateTime')) / 1000)
			const to = Math.floor(Date.parse(q.get('endDateTime')) / 1000)
			return { value: view(c, from, to).filter((x) => x.seriesMasterId === sid) }
		}
		if ((m = /^me\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(p))) {
			const c = cal(m[1])
			const eid = decodeURIComponent(m[2])
			let e = c.events.get(eid)
			const occ = /^(.+)OCC(\d+)$/.exec(eid)
			if (!e && occ && c.events.get(occ[1])) {
				// An occurrence not changed yet: becomes an exception on its first change
				const master = c.events.get(occ[1])
				const t = Number(occ[2])
				if (!expand(master, t, t + 1).includes(t)) throw err(404, 'ErrorItemNotFound')
				e = { id: eid, subject: master.subject, start: t, end: t + master.end - master.start, tz: master.tz, master: master.id, originalStart: t }
				if (method !== 'GET') c.events.set(eid, e)
			}
			if (!e || e.cancelled) throw err(404, 'ErrorItemNotFound')
			if (method === 'GET') return shape(e, e.recurrence ? 'seriesMaster' : e.master ? 'exception' : 'singleInstance')
			if (method === 'DELETE') {
				if (e.master) e.cancelled = true
				else { c.events.delete(eid); for (const [k, x] of [...c.events]) if (x.master === eid) c.events.delete(k) }
				return null
			}
			if (method === 'PATCH') {
				strict(body, ['subject', 'start', 'end', 'recurrence'])
				if (body.subject !== undefined) e.subject = body.subject
				if (body.start) { e.start = inSec(body.start); e.tz = body.start.timeZone }
				if (body.end) e.end = inSec(body.end)
				if (body.recurrence !== undefined) {
					if (e.master) throw err(400, 'An occurrence has no recurrence')
					e.recurrence = body.recurrence
				}
				checkRecurrence(e)
				return shape(e, e.recurrence ? 'seriesMaster' : 'singleInstance')
			}
		}
		throw err(400, `Unknown: ${method} ${path}`)
	}
	return {
		request, cals, calls, setDown: (v) => { down = v },
		/** The events (not occurrences) in a calendar, with times in seconds */
		events: (cid) => [...cal(encodeURIComponent(cid)).events.values()].filter((e) => !e.cancelled),
		view: (cid, from, to) => view(cal(encodeURIComponent(cid)), from, to),
	}
}

module.exports = { fakeGraph }
