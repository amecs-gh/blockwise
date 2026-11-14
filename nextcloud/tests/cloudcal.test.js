/* Cloud calendars (js/cloudcal.js) against a stand-in Google Calendar. Run: TZ=UTC node tests/cloudcal.test.js */
'use strict'
process.env.TZ = 'UTC'
const assert = require('assert')
const { createCloudCalendar, toRrule, fromRrule, untilOf, ruleUntil } = require('../js/cloudcal.js')
const { fakeGoogle } = require('./fake-gcal.js')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const day0 = Math.floor(Date.UTC(2026, 10, 16) / 1000) // a Monday
const T = (d, h) => day0 + d * 86400 + h * 3600

;(async () => {
	// RRULEs
	assert.equal(toRrule('weekdays', null), 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')
	assert.equal(toRrule('biweekly', T(10, 0)), 'FREQ=WEEKLY;INTERVAL=2;UNTIL=20261126T000000Z')
	assert.equal(fromRrule('FREQ=WEEKLY;INTERVAL=2;UNTIL=20261126T000000Z'), 'biweekly')
	assert.equal(fromRrule('FREQ=DAILY;COUNT=3'), 'custom')
	assert.equal(untilOf('FREQ=DAILY;UNTIL=20261126T000000Z'), T(10, 0))
	assert.equal(ruleUntil('FREQ=DAILY;COUNT=4', T(10, 0)), 'FREQ=DAILY;UNTIL=20261126T000000Z')
	console.log('  ✔ repeats as RRULEs')

	const g = fakeGoogle()
	let kept = null
	let changes = 0
	const make = () => createCloudCalendar({
		provider: 'google',
		request: g.request,
		storage: { load: async () => kept, save: async (t) => { kept = t } },
		onChange: () => { changes++ },
	})
	let cc = make()
	const thesis = await cc.createCalendar({ name: 'Thesis', color: '#c2255c' })
	const work = await cc.createCalendar({ name: 'Work', color: '#3b6fd8' })
	assert.match(thesis, /^gcal:cal\d+@group\.calendar\.google\.com$/)
	assert.equal(g.cals.get(cc.calOf(thesis)).color, '#c2255c', 'the calendar in the commitment\'s color')
	console.log('  ✔ a calendar per commitment')

	// Planned here: shown at once, then sent
	await cc.createEvent({ url: thesis, title: 'Draft', start: T(0, 9), end: T(0, 11) })
	let evs = await cc.events(T(0, 0), T(1, 0), [thesis])
	assert.deepEqual(evs.map((e) => [e.title, e.start, e.end]), [['Draft', T(0, 9), T(0, 11)]], 'shown at once')
	await wait(400); await cc.flush()
	assert.equal(g.events(cc.calOf(thesis)).length, 1, 'sent to the calendar')
	// read back from the calendar
	const read = async (c, from, to, urls) => { await c.events(from, to, urls); await wait(50); return c.events(from, to, urls) }
	evs = await read(cc, T(0, 0), T(1, 0), [thesis])
	assert.equal(evs.length, 1)
	assert.ok(evs[0].series < 8e12 && /^\d+$/.test(String(evs[0].series)), 'a number for the engine')
	console.log('  ✔ planned: shown at once, then in the calendar')

	// Moved and renamed (one-off)
	await cc.updateEvent(evs[0].series, evs[0].occurrence, { start: T(0, 13), end: T(0, 14), title: 'Draft 2', scope: 'all' })
	evs = await cc.events(T(0, 0), T(1, 0), [thesis])
	assert.deepEqual(evs.map((e) => [e.title, e.start, e.end]), [['Draft 2', T(0, 13), T(0, 14)]], 'moved at once')
	await cc.flush()
	const ev1 = g.events(cc.calOf(thesis))[0]
	assert.equal(ev1.summary, 'Draft 2')
	assert.equal(ev1.start.dateTime, '2026-11-16T13:00:00Z')
	console.log('  ✔ moved and renamed')

	// A repeating block: weekdays at 9
	await cc.createEvent({ url: work, title: 'Work', start: T(0, 9), end: T(0, 12), repeat: 'weekdays' })
	await cc.flush()
	evs = await read(cc, T(0, 0), T(7, 0), [work])
	assert.equal(evs.length, 5, 'five weekdays')
	assert.ok(evs.every((e) => e.repeat === 'weekdays'), 'its repeat known')
	// This one only: Wednesday to 14:00
	const wed = evs[2]
	await cc.updateEvent(wed.series, wed.occurrence, { start: T(2, 14), end: T(2, 17), scope: 'this' })
	evs = await cc.events(T(0, 0), T(7, 0), [work])
	assert.deepEqual(evs.map((e) => e.start), [T(0, 9), T(1, 9), T(2, 14), T(3, 9), T(4, 9)], 'this one only, at once')
	await cc.flush()
	evs = await read(cc, T(0, 0), T(7, 0), [work])
	assert.deepEqual(evs.map((e) => e.start).sort((a, b) => a - b), [T(0, 9), T(1, 9), T(2, 14), T(3, 9), T(4, 9)], 'this one only, in the calendar')
	// Delete Thursday only
	const thu = evs.find((e) => e.start === T(3, 9))
	await cc.deleteEvent(thu.series, thu.occurrence, 'this')
	await cc.flush()
	evs = await read(cc, T(0, 0), T(7, 0), [work])
	assert.deepEqual(evs.map((e) => e.start).sort((a, b) => a - b), [T(0, 9), T(1, 9), T(2, 14), T(4, 9)])
	// All of them an hour later
	const mon = evs.find((e) => e.start === T(0, 9))
	await cc.updateEvent(mon.series, mon.occurrence, { start: T(0, 10), end: T(0, 13), scope: 'all' })
	await cc.flush()
	evs = await read(cc, T(0, 0), T(7, 0), [work])
	assert.ok(evs.some((e) => e.start === T(0, 10)) && evs.some((e) => e.start === T(1, 10)), 'the series moved')
	// From next week on: none (ends before it)
	const next = await read(cc, T(7, 0), T(14, 0), [work])
	await cc.deleteEvent(next[0].series, next[0].occurrence, 'future')
	await cc.flush()
	assert.equal((await read(cc, T(7, 0), T(14, 0), [work])).length, 0, 'ended before next week')
	assert.ok((await read(cc, T(0, 0), T(7, 0), [work])).length >= 4, 'this week stays')
	console.log('  ✔ repeating: this one, all, and the following ones')

	// Moved to another commitment's calendar
	const one = (await read(cc, T(0, 0), T(1, 0), [thesis]))[0]
	await cc.updateEvent(one.series, one.occurrence, { url: work, scope: 'all' })
	assert.equal((await cc.events(T(0, 0), T(1, 0), [thesis])).length, 0, 'gone from Thesis at once')
	assert.ok((await cc.events(T(0, 0), T(1, 0), [work])).some((e) => e.title === 'Draft 2'), 'in Work at once')
	await cc.flush()
	assert.equal(g.events(cc.calOf(thesis)).length, 0)
	assert.ok(g.events(cc.calOf(work)).some((e) => e.summary === 'Draft 2'), 'moved in the calendar')
	console.log('  ✔ moved to another commitment')

	// Offline: kept answers, changes wait in order, survive a restart, then go
	await wait(700) // (kept a moment after)
	g.setDown(true)
	cc = make() // (a restart)
	evs = await cc.events(T(0, 0), T(7, 0), [work])
	assert.ok(evs.length >= 4, 'the last known blocks, offline after a restart')
	await cc.createEvent({ url: thesis, title: 'Offline', start: T(1, 15), end: T(1, 16) })
	const off = (await cc.events(T(1, 0), T(2, 0), [thesis])).find((e) => e.title === 'Offline')
	assert.ok(off && off.series >= 8e12, 'shown while waiting')
	await cc.updateEvent(off.series, off.occurrence, { start: T(1, 16), end: T(1, 17), scope: 'all' })
	assert.equal(cc.pending(), 1, 'edits to a waiting block go into it')
	await wait(400); await cc.flush()
	assert.equal(cc.pending(), 1, 'still waiting while down')
	assert.ok(cc.offline(), 'knows it is offline')
	await wait(700)
	cc = make() // (another restart: what waits is kept)
	assert.equal((await cc.events(T(1, 0), T(2, 0), [thesis])).filter((e) => e.title === 'Offline').length, 1)
	g.setDown(false)
	await cc.flush()
	assert.equal(cc.pending(), 0, 'sent when back')
	const sentEv = g.events(cc.calOf(thesis)).find((e) => e.summary === 'Offline')
	assert.equal(sentEv.start.dateTime, '2026-11-17T16:00:00Z', 'as moved while offline')
	console.log('  ✔ offline: kept, waiting in order across restarts, sent when back')

	// Refused (the event deleted elsewhere meanwhile): dropped, said
	let refused = null
	const cr = createCloudCalendar({ provider: 'google', request: g.request, onRefused: (m) => { refused = m } })
	const list = await read(cr, T(1, 0), T(2, 0), [thesis])
	const victim = list.find((e) => e.title === 'Offline')
	g.cals.get(cr.calOf(thesis)).events.clear()
	await cr.updateEvent(victim.series, victim.occurrence, { title: 'x', scope: 'all' })
	await cr.flush()
	assert.equal(cr.pending(), 0)
	assert.ok(refused && refused.length, 'said')
	console.log('  ✔ a change the calendar refuses is dropped and said')

	// Copied in from the built-in calendar, with an occurrence deleted before
	const ci = createCloudCalendar({ provider: 'google', request: g.request })
	const n = await ci.importBlocks([
		{ url: work, title: 'Daily', start: T(14, 8), end: T(14, 9), repeat: 'daily', until: T(18, 8), skip: [T(15, 8)] },
		{ url: 'blockwise:x', title: 'Not here', start: T(14, 8), end: T(14, 9) },
	])
	assert.equal(n, 1)
	await ci.flush()
	const daily = (await read(ci, T(14, 0), T(21, 0), [work])).filter((e) => e.title === 'Daily')
	assert.deepEqual(daily.map((e) => e.start), [T(14, 8), T(16, 8), T(17, 8), T(18, 8)], 'repeats and the deleted one copied')
	console.log('  ✔ copied in from the built-in calendar')

	// No storm: the same range asked once while fresh
	const before = g.calls.length
	for (let i = 0; i < 5; i++) await ci.events(T(14, 0), T(21, 0), [work])
	await wait(50)
	assert.ok(g.calls.length - before <= 4, `asked at most once (${g.calls.length - before} requests)`)
	console.log('  ✔ asks once per range while fresh')
	console.log('cloud calendar tests passed')
})().catch((e) => { console.error('✘', e); process.exit(1) })
