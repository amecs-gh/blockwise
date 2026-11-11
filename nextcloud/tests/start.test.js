// Started earlier than play: moving the running session's start back (engine,
// the Mac and Android apps). node tests/start.test.js
const assert = require('node:assert/strict')
const { createEngine } = require('../js/engine.js')
const ok = (n) => console.log('  ✔', n)
const mem = () => { let s = null; return { load: async () => s, save: async (d) => { s = JSON.parse(JSON.stringify(d)) } } }
let clock = 1_800_000_000
;(async () => {
	const e = await createEngine({ storage: mem(), remote: null, calendar: { kind: 'builtin' }, now: () => clock, nowMs: () => clock * 1000 })
	const a = await e.api('POST', 'commitments', { name: 'Thesis', color: '#3b6fd8' })
	const b = await e.api('POST', 'commitments', { name: 'Teaching', color: '#d8643b' })

	// Forgot to press play: started 10 minutes before
	const s1 = await e.api('POST', 'sessions/start', { commitmentId: a.id })
	clock += 60
	let r = await e.api('PUT', `sessions/${s1.id}`, { start: s1.start - 600 })
	assert.equal(r.start, s1.start - 600)
	assert.equal(r.clamped, false)
	assert.equal((await e.api('GET', 'dashboard')).running.start, s1.start - 600)
	ok('the running session starts 10 minutes earlier')

	// Forgot to switch: Teaching since 15 minutes ago, Thesis ends then too
	clock += 3600
	const s2 = await e.api('POST', 'sessions/start', { commitmentId: b.id })
	r = await e.api('PUT', `sessions/${s2.id}`, { start: s2.start - 900 })
	assert.equal(r.start, s2.start - 900)
	const list = await e.api('GET', `sessions?from=${clock - 7200}&to=${clock + 1}`)
	assert.equal(list[0].end, s2.start - 900, 'the one before ends when this one starts')
	ok('right after a switch: the session before ends earlier too')

	// Not before the start of the session before
	r = await e.api('PUT', `sessions/${s2.id}`, { start: list[0].start - 3600 })
	assert.equal(r.start, list[0].start + 60, 'the one before keeps a minute')
	assert.equal(r.clamped, true)
	ok('can\'t swallow the session before')

	// After a gap: not into the session before
	await e.api('POST', 'sessions/stop', {})
	clock += 1800
	const s3 = await e.api('POST', 'sessions/start', { commitmentId: a.id })
	const before = (await e.api('GET', `sessions?from=${clock - 7200}&to=${clock + 1}`)).find((x) => x.id === s2.id)
	r = await e.api('PUT', `sessions/${s3.id}`, { start: s3.start - 3600 })
	assert.equal(r.start, before.end, 'starts when the one before ended')
	assert.equal(r.clamped, true)
	ok('after a gap: starts at the latest when the session before ended')

	// Never in the future, at most 12 hours back, only the running one
	r = await e.api('PUT', `sessions/${s3.id}`, { start: clock + 999 })
	assert.equal(r.start, clock)
	await assert.rejects(e.api('PUT', `sessions/${s2.id}`, { start: clock - 60 }), /Only the running session/)
	await assert.rejects(e.api('PUT', `sessions/${s3.id}`, { start: 'soon' }), /Invalid time/)
	await e.api('POST', 'sessions/stop', {})
	clock += 86400
	const s4 = await e.api('POST', 'sessions/start', {})
	r = await e.api('PUT', `sessions/${s4.id}`, { start: clock - 20 * 3600 })
	assert.equal(r.start, clock - 12 * 3600)
	ok('not in the future, at most 12 hours back, only the running session')
	console.log('\nall start-time tests passed')
})().catch((e) => { console.error('✘', e); process.exit(1) })
