// Backups with blocks that live in a calendar app (here Google Calendar, a
// stand-in): exported with the commitments (a repeat once, its moved and deleted
// occurrences kept), and imported into another account: a calendar per
// commitment made there, the blocks put in it; importing twice adds nothing.
// Also: a backup of the built-in calendar imported into Google Calendar, and
// the other way round. TZ=UTC node tests/backup-calendar.test.js
'use strict'
process.env.TZ = 'UTC'
const assert = require('node:assert/strict')
const { createEngine } = require('../js/engine.js')
const { createCloudCalendar } = require('../js/cloudcal.js')
const { fakeGoogle } = require('./fake-gcal.js')
const ok = (n) => console.log('  ✔', n)

const mem = () => { let s = null; return { load: async () => (s ? JSON.parse(s) : null), save: async (db) => { s = JSON.stringify(db) } } }
const day0 = Math.floor(Date.UTC(2026, 10, 16) / 1000) // a Monday
const T = (d, h) => day0 + d * 86400 + h * 3600
let clock = T(0, 7)
let ms = 0

async function engineWith(calendar) {
	let e = null
	const cal = calendar === 'builtin' ? { kind: 'builtin' } : createCloudCalendar({
		provider: 'google',
		request: calendar.request,
		calendarsOf: () => (e ? e.snapshot().commitments.filter((c) => c.calendarUrl).map((c) => ({ url: c.calendarUrl, name: c.name, color: c.color })) : []),
	})
	e = await createEngine({ storage: mem(), calendar: cal, remote: null, now: () => clock, nowMs: () => clock * 1000 + ++ms })
	return { e, cal }
}
const titles = (list) => list.map((b) => `${b.title}@${new Date(b.start * 1000).toISOString().slice(5, 16)}`).sort()

;(async () => {
	// Account 1: two commitments, their blocks in Google Calendar
	const g1 = fakeGoogle()
	const { e: a, cal: ca } = await engineWith(g1)
	const thesis = await a.api('POST', 'commitments', { name: 'Thesis', color: '#c2255c' })
	const gym = await a.api('POST', 'commitments', { name: 'Gym', color: '#3b6fd8' })
	assert.equal(g1.cals.size, 2, 'a calendar per commitment')
	await a.api('POST', 'blocks', { commitmentId: thesis.id, title: 'Write', start: T(0, 9), end: T(0, 11), repeat: 'weekdays' })
	await a.api('POST', 'blocks', { commitmentId: gym.id, title: 'Run', start: T(2, 18), end: T(2, 19) })
	await ca.flush()
	let week = (await a.api('GET', `blocks?from=${T(0, 0)}&to=${T(7, 0)}`)).blocks
	await new Promise((r) => setTimeout(r, 30))
	week = (await a.api('GET', `blocks?from=${T(0, 0)}&to=${T(7, 0)}`)).blocks
	// Tuesday moved to 14:00, Thursday deleted (in the calendar)
	const tue = week.find((b) => b.start === T(1, 9))
	await a.api('PUT', `blocks/${tue.series}/${tue.occurrence}`, { start: T(1, 14), end: T(1, 16), scope: 'this' })
	const thu = week.find((b) => b.start === T(3, 9))
	await a.api('DELETE', `blocks/${thu.series}/${thu.occurrence}?scope=this`)
	await ca.flush()
	ok('account 1: blocks in Google Calendar (a repeat, one moved, one deleted)')

	// Export: commitments and blocks (the repeat once, with what changed)
	const { records } = await a.api('GET', 'backup')
	const blockRecs = records.filter((r) => r.type === 'block')
	assert.equal(records.filter((r) => r.type === 'commitment').length, 2)
	const write = blockRecs.find((r) => r.fields.title === 'Write' && r.fields.repeat === 'weekdays')
	assert.ok(write, 'the repeat, once')
	assert.deepEqual(write.fields.skip, [T(1, 9), T(3, 9)], 'the moved and the deleted occurrence left out of it')
	assert.ok(blockRecs.some((r) => r.fields.title === 'Write' && !r.fields.repeat && r.fields.start === T(1, 14)), 'the moved one on its own')
	assert.ok(blockRecs.some((r) => r.fields.title === 'Run' && r.fields.start === T(2, 18)))
	assert.equal(blockRecs.length, 3)
	ok('export: commitments, and their blocks from Google Calendar')

	// Import into another account: calendars made, blocks there
	const g2 = fakeGoogle()
	const { e: b, cal: cb } = await engineWith(g2)
	const r = await b.api('POST', 'backup', { records })
	assert.equal(r.calendars, 2, 'a calendar made per commitment')
	assert.equal(r.blocks, 3)
	await cb.flush()
	assert.deepEqual([...g2.cals.values()].map((c) => c.summary).sort(), ['Gym', 'Thesis'])
	const st = await b.api('GET', 'state')
	assert.ok(st.commitments.every((c) => c.calendarUrl && c.calendarUrl.startsWith('gcal:') && !records.some((x) => x.fields.calendarUrl === c.calendarUrl)), 'their own calendars, not those of account 1')
	const got = await cb.readAll(T(0, 0), T(7, 0), st.commitments.map((c) => c.calendarUrl))
	const before = await ca.readAll(T(0, 0), T(7, 0), (await a.api('GET', 'state')).commitments.map((c) => c.calendarUrl))
	assert.deepEqual(titles(got), titles(before), 'the same week in the other account')
	// Twice: nothing more
	const again = await b.api('POST', 'backup', { records })
	await cb.flush()
	assert.equal(again.calendars, 0)
	assert.equal(again.blocks, 0, 'already there: not again')
	ok('import into another account: a calendar per commitment, the blocks in it, once')

	// That backup into the built-in calendar: the blocks as Blockwise's own
	const { e: c } = await engineWith('builtin')
	await c.api('POST', 'backup', { records })
	const inside = (await c.api('GET', `blocks?from=${T(0, 0)}&to=${T(7, 0)}`)).blocks
	assert.deepEqual(titles(inside), titles(before), 'the same week, built in')
	ok('into the built-in calendar')

	// And a built-in backup into Google Calendar
	const back = (await c.api('GET', 'backup')).records
	const g3 = fakeGoogle()
	const { e: d, cal: cd } = await engineWith(g3)
	const r3 = await d.api('POST', 'backup', { records: back })
	await cd.flush()
	assert.equal(r3.calendars, 2)
	const st3 = await d.api('GET', 'state')
	assert.deepEqual(titles(await cd.readAll(T(0, 0), T(7, 0), st3.commitments.map((x) => x.calendarUrl))), titles(before), 'the same week, in Google Calendar')
	ok('a built-in backup into Google Calendar')
	console.log('backup with calendars: all checks passed')
})().catch((e) => { console.error('✘', e); process.exit(1) })
