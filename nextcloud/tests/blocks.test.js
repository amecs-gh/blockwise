// The built-in calendar (no server): blocks, repeats (across a DST change),
// changing one / the following / all, deleting, syncing through a drive, and
// never sending blocks to Nextcloud. TZ=Europe/Zurich node tests/blocks.test.js
process.env.TZ = process.env.TZ || 'Europe/Zurich'
const assert = require('node:assert/strict')
const { createEngine } = require('../js/engine.js')
const FS = require('../js/filesync.js')
const ok = (n) => console.log('  ✔', n)

const mem = () => { let s = null; return { load: async () => (s ? JSON.parse(s) : null), save: async (db) => { s = JSON.stringify(db) } } }
const local = (y, mo, d, h, mi = 0) => Math.floor(new Date(y, mo - 1, d, h, mi).getTime() / 1000)
const hm = (t) => { const d = new Date(t * 1000); return `${d.getDate()}.${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
let clock = local(2026, 10, 19, 8) // Monday 19 Oct 2026, before the DST change (25 Oct)

async function engine(extra = {}) {
	return createEngine({ storage: mem(), calendar: { kind: 'builtin' }, remote: null, now: () => clock, nowMs: () => clock * 1000 + (extra.ms = (extra.ms || 0) + 1), ...extra })
}

;(async () => {
	const e = await engine()
	const c = await e.api('POST', 'commitments', { name: 'Thesis', color: '#336699' })
	const c2 = await e.api('POST', 'commitments', { name: 'Gym', color: '#993366' })
	let st = await e.api('GET', 'state')
	assert.equal(st.features.builtinCalendar, true)
	assert.ok(st.commitments.every((x) => x.calendarId !== null), 'every commitment has its own calendar')
	assert.equal(st.calendars.length, 2)
	ok('built in: every commitment has its own calendar')

	// A weekly block, Mondays 9:00–11:00, across the DST change
	await e.api('POST', 'blocks', { commitmentId: c.id, title: 'Write', start: local(2026, 10, 19, 9), end: local(2026, 10, 19, 11), repeat: 'weekly' })
	let list = (await e.api('GET', `blocks?from=${local(2026, 10, 19, 0)}&to=${local(2026, 11, 10, 0)}`)).blocks
	assert.deepEqual(list.map((b) => hm(b.start)), ['19.10 09:00', '26.10 09:00', '2.11 09:00', '9.11 09:00'], 'same local time after the change')
	assert.ok(list.every((b) => b.end - b.start === 7200 && b.repeat === 'weekly' && b.series))
	ok('weekly: same local time across the DST change')

	const blocksIn = async (a, b) => (await e.api('GET', `blocks?from=${a}&to=${b}`)).blocks
	const W = [local(2026, 10, 19, 0), local(2026, 11, 10, 0)]
	const second = list[1]
	// This one only: moved to 14:00
	await e.api('PUT', `blocks/${second.series}/${second.occurrence}`, { start: local(2026, 10, 26, 14), end: local(2026, 10, 26, 15), scope: 'this' })
	list = await blocksIn(...W)
	assert.deepEqual(list.map((b) => hm(b.start)), ['19.10 09:00', '26.10 14:00', '2.11 09:00', '9.11 09:00'])
	assert.equal(list[1].repeat, '', 'the moved one is on its own')
	ok('change "this event only"')

	// This and the following: from 2 Nov at 10:00, and the title
	const third = list[2]
	await e.api('PUT', `blocks/${third.series}/${third.occurrence}`, { start: local(2026, 11, 2, 10), end: local(2026, 11, 2, 12), title: 'Edit', scope: 'future' })
	list = await blocksIn(...W)
	assert.deepEqual(list.map((b) => `${hm(b.start)} ${b.title}`), ['19.10 09:00 Write', '26.10 14:00 Write', '2.11 10:00 Edit', '9.11 10:00 Edit'])
	ok('change "this and following events"')

	// All of them (from the first one): an hour later
	await e.api('PUT', `blocks/${list[0].series}/${list[0].occurrence}`, { start: local(2026, 10, 19, 10), end: local(2026, 10, 19, 12), scope: 'all' })
	list = await blocksIn(...W)
	assert.deepEqual(list.map((b) => hm(b.start)), ['19.10 10:00', '26.10 14:00', '2.11 10:00', '9.11 10:00'])
	ok('change "all events" (only that series)')

	// Delete this one only, then the following, then a whole series
	await e.api('DELETE', `blocks/${list[3].series}/${list[3].occurrence}?scope=this`)
	assert.equal((await blocksIn(...W)).length, 3)
	await e.api('POST', 'blocks', { commitmentId: c2.id, start: local(2026, 10, 20, 7), end: local(2026, 10, 20, 8), repeat: 'weekdays' })
	let gym = (await blocksIn(local(2026, 10, 19, 0), local(2026, 11, 2, 0))).filter((b) => b.commitmentId === c2.id)
	assert.deepEqual(gym.map((b) => hm(b.start)), ['20.10 07:00', '21.10 07:00', '22.10 07:00', '23.10 07:00', '26.10 07:00', '27.10 07:00', '28.10 07:00', '29.10 07:00', '30.10 07:00'], 'weekdays only')
	assert.equal(gym[0].title, 'Gym', 'no title: the commitment\'s name')
	await e.api('DELETE', `blocks/${gym[4].series}/${gym[4].occurrence}?scope=future`)
	gym = (await blocksIn(local(2026, 10, 19, 0), local(2026, 11, 2, 0))).filter((b) => b.commitmentId === c2.id)
	assert.equal(gym.length, 4, 'ends before 26 Oct')
	await e.api('DELETE', `blocks/${gym[0].series}/${gym[0].occurrence}?scope=all`)
	gym = (await blocksIn(local(2026, 10, 19, 0), local(2026, 11, 2, 0))).filter((b) => b.commitmentId === c2.id)
	assert.equal(gym.length, 0)
	ok('delete this / following / all; weekdays skip the weekend')

	// Monthly on the 31st: only months that have one
	const m = await e.api('POST', 'blocks', { commitmentId: c2.id, start: local(2026, 10, 31, 9), end: local(2026, 10, 31, 10), repeat: 'monthly', until: local(2027, 3, 31, 9) })
	const months = (await blocksIn(local(2026, 10, 1, 0), local(2027, 6, 1, 0))).filter((b) => b.commitmentId === c2.id)
	assert.deepEqual(months.map((b) => hm(b.start)), ['31.10 09:00', '31.12 09:00', '31.1 09:00', '31.3 09:00'], 'until 31 March, no 30-day months')
	ok('monthly, with an end date')
	{
		// Moving all of a series with an end date: the end moves along (the last one stays)
		const d = await e.api('POST', 'blocks', { commitmentId: c.id, start: local(2026, 12, 1, 9), end: local(2026, 12, 1, 10), repeat: 'daily', until: local(2026, 12, 3, 9) })
		const [first] = (await blocksIn(local(2026, 12, 1, 0), local(2026, 12, 2, 0))).filter((x) => x.uid === d.uid)
		await e.api('PUT', `blocks/${first.series}/${first.occurrence}`, { start: local(2026, 12, 1, 11), end: local(2026, 12, 1, 12), scope: 'all' })
		const moved = (await blocksIn(local(2026, 12, 1, 0), local(2026, 12, 6, 0))).filter((x) => x.series === first.series)
		assert.deepEqual(moved.map((x) => hm(x.start)), ['1.12 11:00', '2.12 11:00', '3.12 11:00'])
		await e.api('DELETE', `blocks/${first.series}/${first.occurrence}?scope=all`)
		ok('moving a whole series keeps its last day')
	}

	// Invalid input refused
	await assert.rejects(e.api('POST', 'blocks', { commitmentId: c.id, start: 100, end: 50 }), /Invalid time/)
	await assert.rejects(e.api('POST', 'blocks', { commitmentId: c.id, start: 0, end: 90000 }), /Invalid time/)
	await assert.rejects(e.api('PUT', `blocks/${list[0].series}/12345`, { start: 1 }), /Not found/)
	const weird = await e.api('POST', 'blocks', { commitmentId: c.id, start: local(2026, 10, 21, 9), end: local(2026, 10, 21, 10), repeat: 'hourly' })
	assert.equal((await blocksIn(local(2026, 10, 21, 0), local(2026, 10, 22, 0))).filter((b) => b.uid === weird.uid).length, 1, 'unknown repeat: just once')
	ok('invalid times and repeats refused')

	// The Now page: the current block comes from the built-in calendar
	clock = local(2026, 10, 19, 10, 30)
	const dash = await e.api('GET', 'dashboard')
	const thesis = dash.commitments.find((x) => x.commitment.id === c.id)
	assert.equal(thesis.currentBlock && hm(thesis.currentBlock.start), '19.10 10:00')
	ok('Now: the current block')

	// Deleting a commitment deletes its blocks
	await e.api('DELETE', `commitments/${c2.id}`)
	assert.ok(!e.builtinBlocks().some((b) => b.commitment === c2.uuid))
	ok('a deleted commitment takes its blocks along')

	// Import (from Apple Calendar): once only
	const before = e.builtinBlocks().length
	const imp = [{ commitment: c.uuid, title: 'Seminar', start: local(2026, 10, 22, 14), end: local(2026, 10, 22, 16), origin: 'apple-uid#1' }]
	assert.equal(e.importBlocks(imp), 1)
	assert.equal(e.importBlocks(imp), 0, 'imported before: not again')
	assert.equal(e.builtinBlocks().length, before + 1)
	assert.equal(e.importBlocks([{ commitment: 'not-a-commitment', start: 1, end: 2, origin: 'x' }]), 0)
	ok('import: each event once, only into existing commitments')

	// Through a drive: blocks reach the other Mac
	{
		const files = new Map()
		const store = { list: async () => [...files.keys()], read: async (n) => files.get(n) || null, write: async (n, b, opt) => { if (opt && opt.create && files.has(n)) throw Object.assign(new Error('exists'), { exists: true }); files.set(n, b) }, remove: async (n) => files.delete(n) }
		const key = await FS.unlock(store, 'correct horse battery')
		const pair = async (eng) => FS.createRemote({ store, key, node: eng.node(), state: mem() })
		let ra, rb
		const a = await engine({ remote: { pull: (x, y) => ra.pull(x, y), push: (r) => ra.push(r) } })
		const b = await engine({ remote: { pull: (x, y) => rb.pull(x, y), push: (r) => rb.push(r) } })
		ra = await pair(a); rb = await pair(b)
		const ca = await a.api('POST', 'commitments', { name: 'Shared', color: '#123456' })
		await a.api('POST', 'blocks', { commitmentId: ca.id, start: local(2026, 10, 23, 9), end: local(2026, 10, 23, 10), repeat: 'daily', until: local(2026, 10, 25, 9) })
		await a.sync(); await b.sync()
		const got = (await b.api('GET', `blocks?from=${local(2026, 10, 23, 0)}&to=${local(2026, 10, 30, 0)}`)).blocks
		assert.equal(got.length, 3)
		await b.api('DELETE', `blocks/${got[1].series}/${got[1].occurrence}?scope=this`)
		await b.sync(); await a.sync()
		assert.equal((await a.api('GET', `blocks?from=${local(2026, 10, 23, 0)}&to=${local(2026, 10, 30, 0)}`)).blocks.length, 2)
		ok('blocks sync through a drive, both ways')
	}

	// To Nextcloud: blocks are never sent (it has its own calendars)
	{
		const pushed = []
		const n = await engine({ remote: { localTypes: ['block'], pull: async () => ({ records: [], cursor: 1, more: false }), push: async (r) => { pushed.push(...r); return { rejected: [] } } } })
		const cn = await n.api('POST', 'commitments', { name: 'Kept', color: '#123456' })
		await n.api('POST', 'blocks', { commitmentId: cn.id, start: local(2026, 10, 23, 9), end: local(2026, 10, 23, 10) })
		await n.sync()
		assert.ok(pushed.some((r) => r.type === 'commitment') && !pushed.some((r) => r.type === 'block'))
		assert.equal(n.pending(), 0, 'nothing shown as waiting')
		assert.equal(n.builtinBlocks().length, 1, 'kept on this device')
		ok('Nextcloud: blocks stay on the device, nothing waiting')
	}

	// Without the built-in calendar (Apple Calendar), the routes don't exist
	{
		const a = await createEngine({ storage: mem(), remote: null, calendar: { calendars: async () => [], events: async () => [] } })
		await assert.rejects(a.api('DELETE', 'blocks/1/1'), /Not found/)
		assert.equal((await a.api('GET', 'state')).features.builtinCalendar, false)
		ok('with another calendar: no built-in routes')
	}
	// Deleting a commitment with ?calendar=1 takes its calendar along (Apple Calendar); without, it stays
	{
		let cals = [{ url: 'apple:A', name: 'Thesis', color: '#336699' }, { url: 'apple:B', name: 'Gym', color: '#993366' }, { url: 'apple:H', name: 'Home', color: '#000000' }]
		const gone = []
		const calendar = { kind: 'apple', calendars: async () => cals, events: async () => [], deleteCalendar: async (url) => { gone.push(url); cals = cals.filter((c) => c.url !== url) } }
		const a = await createEngine({ storage: mem(), remote: null, calendar })
		let st = await a.api('GET', 'state')
		assert.equal(st.features.deleteCalendar, 'permanent')
		const id = (u) => st.calendars.find((c) => c.url === u).id
		const x = await a.api('POST', 'commitments', { calendarId: id('apple:A') })
		const y = await a.api('POST', 'commitments', { calendarId: id('apple:B') })
		await a.api('DELETE', `commitments/${y.id}`)
		assert.deepEqual(gone, [], 'kept without ?calendar=1')
		await a.api('DELETE', `commitments/${x.id}?calendar=1`)
		assert.deepEqual(gone, ['apple:A'], 'only its own calendar')
		st = await a.api('GET', 'state')
		assert.ok(!st.commitments.length && st.calendars.every((c) => c.url !== 'apple:A'))
		// A failure keeps the commitment
		calendar.deleteCalendar = async () => { throw new Error('nope') }
		const z = await a.api('POST', 'commitments', { calendarId: st.calendars.find((c) => c.url === 'apple:H').id })
		await assert.rejects(a.api('DELETE', `commitments/${z.id}?calendar=1`), /nope/)
		assert.equal((await a.api('GET', 'state')).commitments.length, 1)
		const b = await engine()
		assert.equal((await b.api('GET', 'state')).features.deleteCalendar, null, 'built in: blocks always go with it')
		ok('deleting a commitment can delete its calendar too, only when asked')
	}
	console.log('\nall built-in calendar tests passed')
})().catch((e) => { console.error('✘', e); process.exit(1) })
