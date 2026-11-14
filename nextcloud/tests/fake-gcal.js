/*
 * A stand-in for Google Calendar's API (the parts Blockwise uses), in memory:
 * calendars, events with simple repeats (daily, weekly with BYDAY/INTERVAL,
 * monthly; UNTIL), single occurrences changed or cancelled, moving events.
 * `request(method, path, body)` answers like the app's request function does.
 * Times are UTC (run the tests with TZ=UTC).
 */
'use strict'

const sec = (s) => Math.floor(Date.parse(s) / 1000)
const iso = (t) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const basic = (t) => new Date(t * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const DAY = 86400

function rule(r) {
	const p = {}
	for (const part of r.replace(/^RRULE:/, '').split(';')) { const [k, v] = part.split('='); p[k] = v }
	return p
}
function untilOf(p) {
	if (!p.UNTIL) return Infinity
	const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/.exec(p.UNTIL)
	return m[4] ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000 + DAY - 1
}
function expand(e, from, to) {
	const start = sec(e.start.dateTime)
	const len = sec(e.end.dateTime) - start
	const r = (e.recurrence || []).find((x) => x.startsWith('RRULE:'))
	if (!r) return [start]
	const p = rule(r)
	const until = untilOf(p)
	const step = Number(p.INTERVAL || 1)
	const out = []
	for (let k = 0; k < 2000; k++) {
		let t
		if (p.FREQ === 'DAILY') t = start + k * step * DAY
		else if (p.FREQ === 'WEEKLY' && p.BYDAY) t = start + k * DAY
		else if (p.FREQ === 'WEEKLY') t = start + k * 7 * step * DAY
		else if (p.FREQ === 'MONTHLY') { const d = new Date(start * 1000); d.setUTCMonth(d.getUTCMonth() + k); t = d / 1000 }
		else break
		if (t > until || t >= to) break
		if (p.FREQ === 'WEEKLY' && p.BYDAY) {
			const wd = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(t * 1000).getUTCDay()]
			if (!p.BYDAY.split(',').includes(wd)) continue
		}
		if (t + len > from) out.push(t)
	}
	return out
}

function fakeGoogle() {
	const cals = new Map() // id -> {summary, events: Map(id -> event)}
	let n = 1
	const calls = []
	let down = false
	const err = (status, message) => Object.assign(new Error(message || `HTTP ${status}`), { status })
	const cal = (id) => { const c = cals.get(decodeURIComponent(id)); if (!c) throw err(404, 'Not Found'); return c }
	function instances(c, from, to) {
		const out = []
		for (const e of c.events.values()) {
			if (e.recurringEventId || e.status === 'cancelled') continue
			const len = sec(e.end.dateTime) - sec(e.start.dateTime)
			for (const t of expand(e, from, to)) {
				const iid = e.recurrence ? `${e.id}_${basic(t)}` : e.id
				const ex = c.events.get(iid)
				if (e.recurrence && ex) {
					if (ex.status === 'cancelled') continue
					if (sec(ex.end.dateTime) > from && sec(ex.start.dateTime) < to) out.push(ex)
					continue
				}
				if (!e.recurrence) { out.push(e); continue }
				out.push({ id: iid, summary: e.summary, recurringEventId: e.id, originalStartTime: { dateTime: iso(t) }, start: { dateTime: iso(t), timeZone: e.start.timeZone }, end: { dateTime: iso(t + len), timeZone: e.end.timeZone }, status: 'confirmed' })
			}
		}
		// exceptions moved into the range from outside
		for (const ex of c.events.values()) {
			if (!ex.recurringEventId || ex.status === 'cancelled' || out.includes(ex)) continue
			if (sec(ex.end.dateTime) > from && sec(ex.start.dateTime) < to) out.push(ex)
		}
		return out.sort((a, b) => sec(a.start.dateTime) - sec(b.start.dateTime))
	}
	async function request(method, path, body) {
		calls.push(`${method} ${path}`)
		if (down) throw Object.assign(new Error('offline'), { status: 0 })
		const [p, qs] = path.split('?')
		const q = new URLSearchParams(qs || '')
		let m
		if (method === 'POST' && p === 'calendars') {
			const id = `cal${n++}@group.calendar.google.com`
			cals.set(id, { summary: body.summary, events: new Map(), color: null })
			return { id, summary: body.summary }
		}
		if ((m = /^users\/me\/calendarList\/([^/]+)$/.exec(p)) && method === 'PATCH') { cal(m[1]).color = body.backgroundColor; return {} }
		if ((m = /^calendars\/([^/]+)$/.exec(p)) && method === 'DELETE') { cal(m[1]); cals.delete(decodeURIComponent(m[1])); return null }
		if ((m = /^calendars\/([^/]+)\/events$/.exec(p))) {
			const c = cal(m[1])
			if (method === 'POST') {
				const id = `ev${n++}`
				const e = { id, summary: body.summary, start: body.start, end: body.end, recurrence: body.recurrence && body.recurrence.length ? body.recurrence : undefined, status: 'confirmed' }
				c.events.set(id, e)
				return e
			}
			const from = sec(q.get('timeMin'))
			const to = sec(q.get('timeMax'))
			if (q.get('singleEvents') === 'true') return { items: instances(c, from, to) }
			return { items: [...c.events.values()].filter((e) => !e.recurringEventId && e.status !== 'cancelled' && expand(e, from, to).length) }
		}
		if ((m = /^calendars\/([^/]+)\/events\/([^/]+)\/move$/.exec(p)) && method === 'POST') {
			const c = cal(m[1])
			const id = decodeURIComponent(m[2])
			const e = c.events.get(id)
			if (!e) throw err(404)
			c.events.delete(id)
			for (const [k, x] of [...c.events]) if (x.recurringEventId === id) { c.events.delete(k); cal(q.get('destination')).events.set(k, x) }
			cal(q.get('destination')).events.set(id, e)
			return e
		}
		if ((m = /^calendars\/([^/]+)\/events\/([^/]+)$/.exec(p))) {
			const c = cal(m[1])
			const id = decodeURIComponent(m[2])
			let e = c.events.get(id)
			const inst = /^(.+)_(\d{8}T\d{6}Z)$/.exec(id)
			if (!e && inst && c.events.get(inst[1])) {
				// An occurrence not changed yet: made on first change
				const master = c.events.get(inst[1])
				const t = sec(inst[2].replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'))
				const len = sec(master.end.dateTime) - sec(master.start.dateTime)
				if (!expand(master, t, t + 1).includes(t)) throw err(404)
				e = { id, summary: master.summary, recurringEventId: master.id, originalStartTime: { dateTime: iso(t) }, start: { dateTime: iso(t) }, end: { dateTime: iso(t + len) }, status: 'confirmed' }
				if (method !== 'GET') c.events.set(id, e)
			}
			if (!e) throw err(404, 'Not Found')
			if (method === 'GET') return e
			if (method === 'DELETE') {
				if (e.recurringEventId) e.status = 'cancelled'
				else { c.events.delete(id); for (const [k, x] of [...c.events]) if (x.recurringEventId === id) c.events.delete(k) }
				return null
			}
			if (method === 'PATCH') {
				if (body.summary !== undefined) e.summary = body.summary
				if (body.start) e.start = body.start
				if (body.end) e.end = body.end
				if (body.recurrence) e.recurrence = body.recurrence.length ? body.recurrence : undefined
				return e
			}
		}
		throw err(400, `Unknown: ${method} ${path}`)
	}
	return { request, cals, calls, setDown: (v) => { down = v }, events: (calId) => [...cal(encodeURIComponent(calId)).events.values()] }
}

module.exports = { fakeGoogle, expand, iso }
