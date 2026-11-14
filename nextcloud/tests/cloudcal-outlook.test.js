/* Cloud calendars (js/cloudcal.js) against a stand-in Outlook (Microsoft Graph). Run: TZ=UTC node tests/cloudcal-outlook.test.js */
'use strict'
process.env.TZ = 'UTC'
const assert = require('assert')
const { createCloudCalendar, graphRecurrence, rruleOfGraph, fromRrule, untilOf, outlookColor, wall, fromWall } = require('../js/cloudcal.js')
const { fakeGraph } = require('./fake-graph.js')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const day0 = Math.floor(Date.UTC(2026, 10, 16) / 1000) // a Monday
const T = (d, h) => day0 + d * 86400 + h * 3600
const starts = (list) => list.map((e) => e.start).sort((a, b) => a - b)

;(async () => {
	// Repeats in Graph's words, and back
	const zurich = 'Europe/Zurich'
	const mon9 = fromWall('2026-11-16T09:00:00', zurich)
	assert.equal(wall(mon9, zurich), '2026-11-16T09:00:00')
	assert.equal(fromWall('2026-07-01T09:00:00', zurich), Date.UTC(2026, 6, 1, 7) / 1000, 'summer time')
	let g = graphRecurrence('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', mon9, zurich)
	assert.deepEqual(g.pattern, { type: 'weekly', interval: 1, daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], firstDayOfWeek: 'monday' })
	assert.deepEqual(g.range, { type: 'noEnd', startDate: '2026-11-16', recurrenceTimeZone: zurich })
	assert.equal(fromRrule(rruleOfGraph(g, mon9)), 'weekdays')
	g = graphRecurrence('FREQ=WEEKLY;INTERVAL=2', mon9, zurich)
	assert.deepEqual(g.pattern.daysOfWeek, ['monday'], 'every other week on its day')
	assert.equal(fromRrule(rruleOfGraph(g, mon9)), 'biweekly')
	assert.equal(fromRrule(rruleOfGraph(graphRecurrence('FREQ=DAILY', mon9, zurich), mon9)), 'daily')
	assert.equal(fromRrule(rruleOfGraph(graphRecurrence('FREQ=WEEKLY', mon9, zurich), mon9)), 'weekly')
	g = graphRecurrence('FREQ=MONTHLY', mon9, zurich)
	assert.deepEqual(g.pattern, { type: 'absoluteMonthly', interval: 1, dayOfMonth: 16 })
	assert.equal(fromRrule(rruleOfGraph(g, mon9)), 'monthly')
	// Ending before an occurrence (09:00 Thursday minus a second): Wednesday is the last day
	g = graphRecurrence('FREQ=DAILY;UNTIL=' + new Date((fromWall('2026-11-19T09:00:00', zurich) - 1) * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), mon9, zurich)
	assert.equal(g.range.endDate, '2026-11-18')
	assert.equal(untilOf(rruleOfGraph(g, mon9)), fromWall('2026-11-18T23:59:59', zurich))
	assert.equal(rruleOfGraph({ pattern: { type: 'relativeMonthly', interval: 1 }, range: { type: 'noEnd' } }, mon9).startsWith('FREQ=YEARLY'), true, 'others: not one of the planner\'s')
	assert.equal(fromRrule(rruleOfGraph({ pattern: { type: 'daily', interval: 1 }, range: { type: 'numbered', numberOfOccurrences: 3 } }, mon9)), 'custom')
	assert.equal(outlookColor('#e03131'), 'lightRed')
	assert.equal(outlookColor('#c2255c'), 'lightPink')
	assert.equal(outlookColor('#3b6fd8'), 'lightBlue')
	assert.equal(outlookColor('#2f9e44'), 'lightGreen')
	assert.equal(outlookColor('#888888'), 'lightGray')
	console.log('  ✔ repeats in Graph\'s words and back')

	const f = fakeGraph()
	let kept = null
	const make = () => createCloudCalendar({
		provider: 'microsoft',
		request: f.request,
		storage: { load: async () => kept, save: async (t) => { kept = t } },
	})
	let cc = make()
	const thesis = await cc.createCalendar({ name: 'Thesis', color: '#c2255c' })
	const work = await cc.createCalendar({ name: 'Work', color: '#3b6fd8' })
	assert.match(thesis, /^mscal:AAMk/)
	assert.equal(f.cals.get(cc.calOf(thesis)).color, 'lightPink')
	console.log('  ✔ a calendar per commitment, in its color')

	const read = async (c, from, to, urls) => { await c.events(from, to, urls); await wait(50); return c.events(from, to, urls) }
	await cc.createEvent({ url: thesis, title: 'Draft', start: T(0, 9), end: T(0, 11), tz: zurich })
	assert.equal((await cc.events(T(0, 0), T(1, 0), [thesis])).length, 1, 'shown at once')
	await wait(400); await cc.flush()
	assert.equal(f.events(cc.calOf(thesis)).length, 1, 'sent')
	let evs = await read(cc, T(0, 0), T(1, 0), [thesis])
	assert.deepEqual(evs.map((e) => [e.title, e.start, e.end]), [['Draft', T(0, 9), T(0, 11)]])
	await cc.updateEvent(evs[0].series, evs[0].occurrence, { start: T(0, 13), end: T(0, 14), title: 'Draft 2', scope: 'all', tz: zurich })
	await cc.flush()
	assert.equal(f.events(cc.calOf(thesis))[0].subject, 'Draft 2')
	assert.equal(f.events(cc.calOf(thesis))[0].start, T(0, 13))
	console.log('  ✔ planned, moved and renamed')

	// Weekdays at 9 (Zurich time), more than a page of them
	await cc.createEvent({ url: work, title: 'Work', start: T(0, 9), end: T(0, 12), repeat: 'weekdays', tz: zurich })
	await cc.flush()
	evs = await read(cc, T(0, 0), T(14, 0), [work])
	assert.equal(evs.length, 10, 'ten weekdays, over two pages')
	assert.ok(evs.every((e) => e.repeat === 'weekdays'), 'its repeat known')
	const wed = evs.find((e) => e.start === T(2, 9))
	await cc.updateEvent(wed.series, wed.occurrence, { start: T(2, 14), end: T(2, 17), scope: 'this', tz: zurich })
	await cc.flush()
	evs = await read(cc, T(0, 0), T(7, 0), [work])
	assert.deepEqual(starts(evs), [T(0, 9), T(1, 9), T(2, 14), T(3, 9), T(4, 9)], 'this one only')
	const thu = evs.find((e) => e.start === T(3, 9))
	await cc.deleteEvent(thu.series, thu.occurrence, 'this')
	await cc.flush()
	evs = await read(cc, T(0, 0), T(7, 0), [work])
	assert.deepEqual(starts(evs), [T(0, 9), T(1, 9), T(2, 14), T(4, 9)], 'Thursday deleted')
	const mon = evs.find((e) => e.start === T(0, 9))
	await cc.updateEvent(mon.series, mon.occurrence, { start: T(0, 10), end: T(0, 13), scope: 'all' })
	await cc.flush()
	evs = await read(cc, T(0, 0), T(7, 0), [work])
	assert.ok(evs.some((e) => e.start === T(0, 10)) && evs.some((e) => e.start === T(1, 10)), 'the series moved')
	// The following ones from Wednesday next week: deleted (the series ends Tuesday)
	let next = await read(cc, T(7, 0), T(14, 0), [work])
	const nwed = next.find((e) => e.start === T(9, 10))
	await cc.deleteEvent(nwed.series, nwed.occurrence, 'future')
	await cc.flush()
	next = await read(cc, T(7, 0), T(14, 0), [work])
	assert.deepEqual(starts(next), [T(7, 10), T(8, 10)], 'ends on Tuesday')
	// From Monday next week on: a new series at 15:00
	const nmon = next.find((e) => e.start === T(7, 10))
	await cc.updateEvent(nmon.series, nmon.occurrence, { start: T(7, 15), end: T(7, 16), scope: 'future' })
	await cc.flush()
	next = await read(cc, T(7, 0), T(14, 0), [work])
	assert.deepEqual(starts(next), [T(7, 15), T(8, 15)], 'the following ones at 15:00 (still ending Tuesday)')
	assert.ok((await read(cc, T(0, 0), T(7, 0), [work])).length >= 4, 'this week stays')
	console.log('  ✔ repeating: this one, all, and the following ones')

	const one = (await read(cc, T(0, 0), T(1, 0), [thesis]))[0]
	await cc.updateEvent(one.series, one.occurrence, { url: work, scope: 'all' })
	await cc.flush()
	assert.equal(f.events(cc.calOf(thesis)).length, 0)
	assert.ok(f.events(cc.calOf(work)).some((e) => e.subject === 'Draft 2'), 'moved to the other calendar')
	console.log('  ✔ moved to another commitment')

	// Offline, across restarts
	await wait(700)
	f.setDown(true)
	cc = make()
	assert.ok((await cc.events(T(0, 0), T(7, 0), [work])).length >= 4, 'kept')
	await cc.createEvent({ url: thesis, title: 'Offline', start: T(1, 15), end: T(1, 16) })
	await wait(400); await cc.flush()
	assert.equal(cc.pending(), 1)
	await wait(700)
	cc = make()
	f.setDown(false)
	await cc.flush()
	assert.equal(cc.pending(), 0, 'sent when back')
	assert.ok(f.events(cc.calOf(thesis)).some((e) => e.subject === 'Offline'))
	console.log('  ✔ offline: kept, waiting, sent when back')

	// Copied in with an occurrence deleted before
	const ci = createCloudCalendar({ provider: 'microsoft', request: f.request })
	assert.equal(await ci.importBlocks([{ url: work, title: 'Daily', start: T(14, 8), end: T(14, 9), repeat: 'daily', until: T(18, 8), skip: [T(15, 8)] }]), 1)
	await ci.flush()
	const daily = (await read(ci, T(14, 0), T(21, 0), [work])).filter((e) => e.title === 'Daily')
	assert.deepEqual(starts(daily), [T(14, 8), T(16, 8), T(17, 8), T(18, 8)], 'repeats and the deleted one copied')
	console.log('  ✔ copied in from the built-in calendar')
	console.log('outlook calendar tests passed')
	process.exit(0)
})().catch((e) => { console.error('✘', e); process.exit(1) })
