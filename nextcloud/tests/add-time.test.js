// Worked but forgot to track: adding the time afterwards (engine, the Mac and
// Android apps). node tests/add-time.test.js
const assert = require('node:assert/strict')
const { createEngine } = require('../js/engine.js')
const ok = (n) => console.log('  ✔', n)
const mem = () => { let s = null; return { load: async () => s, save: async (d) => { s = JSON.parse(JSON.stringify(d)) } } }
let clock = 1_800_000_000
;(async () => {
	const e = await createEngine({ storage: mem(), remote: null, calendar: { kind: 'builtin' }, now: () => clock, nowMs: () => clock * 1000 })
	const a = await e.api('POST', 'commitments', { name: 'Thesis', color: '#3b6fd8' })

	const s = await e.api('POST', 'sessions', { commitmentId: a.id, start: clock - 7200, end: clock - 3600 })
	assert.equal(s.start, clock - 7200)
	assert.equal(s.end, clock - 3600)
	assert.equal(s.commitmentId, a.id)
	const list = await e.api('GET', `sessions?from=${clock - 86400}&to=${clock}`)
	assert.equal(list.length, 1)
	ok('an hour two hours ago is added to Thesis')

	const u = await e.api('POST', 'sessions', { start: clock - 3000, end: clock - 2400 })
	assert.equal(u.commitmentId, null)
	ok('unplanned time can be added too')

	await assert.rejects(e.api('POST', 'sessions', { commitmentId: a.id, start: clock - 5000, end: clock - 4000 }), /overlaps/)
	await assert.rejects(e.api('POST', 'sessions', { start: clock - 2700, end: clock - 2500 }), /overlaps/)
	ok('not over time tracked already')

	await assert.rejects(e.api('POST', 'sessions', { start: clock - 60, end: clock + 600 }), /past/)
	await assert.rejects(e.api('POST', 'sessions', { start: clock - 600, end: clock - 900 }), /after the start/)
	await assert.rejects(e.api('POST', 'sessions', { start: clock - 30 * 3600, end: clock - 3 * 3600 }), /24 hours/)
	await assert.rejects(e.api('POST', 'sessions', { start: 'yesterday', end: clock - 60 }), /Invalid time/)
	await assert.rejects(e.api('POST', 'sessions', { commitmentId: 999, start: clock - 1200, end: clock - 600 }))
	ok('only in the past, end after start, at most 24 hours, a real commitment')

	// The running session counts as tracked up to now
	await e.api('POST', 'sessions/start', {})
	clock += 600
	await assert.rejects(e.api('POST', 'sessions', { start: clock - 300, end: clock - 60 }), /overlaps/)
	ok('not over the running session')

	const d = await e.api('GET', 'dashboard')
	assert.ok(d)
	console.log('\nall add-time tests passed')
})().catch((e) => { console.error('✘', e); process.exit(1) })
