// Backup in the engine (Mac, Android, browser): export everything, import it on
// another device, merge like a sync (later change wins, deleted stays deleted,
// a backup never deletes), refuse what isn't valid, and send it on.
// node tests/backup.test.js
const assert = require('node:assert/strict')
const { createEngine } = require('../js/engine.js')
const ok = (n) => console.log('  ✔', n)

const mem = () => { let s = null; return { load: async () => (s ? JSON.parse(s) : null), save: async (db) => { s = JSON.stringify(db) } } }
let clock = 1790000000

async function engine(remote = null) {
	let ms = 0
	return createEngine({ storage: mem(), calendar: { kind: 'builtin' }, remote, now: () => clock, nowMs: () => clock * 1000 + ++ms })
}
/** What a person sees: names and titles, sorted */
async function view(e) {
	const st = await e.api('GET', 'state')
	const tasks = (await e.api('GET', 'tasks')).tasks || (await e.api('GET', 'tasks'))
	const notes = await e.api('GET', 'notes')
	const sessions = await e.api('GET', `sessions?from=${clock - 86400}&to=${clock + 86400}`)
	const blocks = (await e.api('GET', `blocks?from=${clock - 86400}&to=${clock + 7 * 86400}`)).blocks
	return {
		commitments: st.commitments.map((c) => `${c.name} ${c.color} ${c.weeklyGoal}`).sort(),
		tasks: (Array.isArray(tasks) ? tasks : []).map((t) => `${t.title}:${(t.subtasks || []).map((s) => `${s.title}/${s.estimate}/${s.done}`).join(',')}`).sort(),
		notes: (Array.isArray(notes) ? notes : notes.notes || []).map((n) => n.text).sort(),
		sessions: (Array.isArray(sessions) ? sessions : sessions.sessions || []).map((s) => `${s.start}-${s.end}`).sort(),
		blocks: blocks.map((b) => `${b.title} ${b.start} ${b.repeat}`).sort(),
		settings: st.settings,
	}
}

;(async () => {
	// --- a device with some of everything ---
	const a = await engine()
	const thesis = await a.api('POST', 'commitments', { name: 'Thesis', color: '#336699' })
	await a.api('PUT', `commitments/${thesis.id}`, { weeklyGoal: 600 })
	const gym = await a.api('POST', 'commitments', { name: 'Gym', color: '#993366' })
	const task = await a.api('POST', 'tasks', { commitmentId: thesis.id, title: 'Chapter 3', subtasks: ['Outline 15m', 'Draft 45m'] })
	await a.api('POST', 'tasks', { commitmentId: gym.id, title: 'Plan the week' })
	await a.api('POST', 'notes', { commitmentId: thesis.id, text: '# Meeting\n- [x] send outline\n- [ ] ask about the date' })
	await a.api('POST', 'blocks', { commitmentId: thesis.id, title: 'Write', start: clock + 3600, end: clock + 3 * 3600, repeat: 'weekdays' })
	await a.api('POST', 'sessions/start', { commitmentId: thesis.id })
	clock += 1500
	await a.api('POST', 'sessions/stop', {})
	await a.api('PUT', 'settings', { pomodoro: true, focusMinutes: 50 })
	const before = await view(a)
	assert.equal(before.commitments.length, 2)
	assert.equal(before.tasks.length, 2)
	assert.equal(before.sessions.length, 1)
	assert.ok(before.blocks.length >= 5)

	const { records } = await a.api('GET', 'backup')
	const types = new Set(records.map((r) => r.type))
	for (const t of ['settings', 'commitment', 'task', 'subtask', 'note', 'session', 'block']) assert.ok(types.has(t), 'backup has ' + t)
	assert.ok(records.every((r) => r.type === 'settings' || /^[0-9a-f-]{36}$/.test(r.id)))
	assert.ok(records.every((r) => Object.keys(r.fields).every((k) => typeof r.clock[k] === 'string')), 'every field with its clock')
	ok('export: every kind of record, each field with its clock')

	// --- a new device: import in chunks, as the interface does ---
	const b = await engine()
	const order = { settings: 0, commitment: 1, task: 2, subtask: 3, note: 4, session: 5, block: 6 }
	const sorted = [...records].sort((x, y) => order[x.type] - order[y.type])
	let applied = 0
	for (let i = 0; i < sorted.length; i += 3) {
		const r = await b.api('POST', 'backup', { records: sorted.slice(i, i + 3) })
		assert.deepEqual(r.rejected, [])
		applied += r.applied
	}
	assert.equal(applied, records.length)
	assert.deepEqual(await view(b), before)
	ok('import on another device: the same commitments, tasks, notes, tracked time, blocks and settings')

	// Importing again changes nothing
	const again = await b.api('POST', 'backup', { records })
	assert.deepEqual(await view(b), before)
	assert.equal(again.rejected.length, 0)
	ok('importing the same backup twice: nothing doubles')

	// --- merging: the later change wins, deleted stays deleted, a backup never deletes ---
	const bTasks = await b.api('GET', 'tasks')
	const list = Array.isArray(bTasks) ? bTasks : bTasks.tasks
	const chapter = list.find((t) => t.title === 'Chapter 3')
	const plan = list.find((t) => t.title === 'Plan the week')
	clock += 60
	await b.api('PUT', `tasks/${chapter.id}`, { title: 'Chapter 3, second draft' })
	await b.api('DELETE', `tasks/${plan.id}`)
	const r1 = await b.api('POST', 'backup', { records })
	const after = await view(b)
	assert.ok(after.tasks.some((t) => t.startsWith('Chapter 3, second draft:')), 'the newer title stays')
	assert.ok(!after.tasks.some((t) => t.startsWith('Plan the week')), 'a deleted task stays deleted')
	assert.ok(r1.deleted >= 1, 'the deleted task (and its subtask) counted')
	ok('an older backup: newer changes stay, deleted stays deleted')

	const deletions = records.filter((r) => r.type === 'commitment').map((r) => ({ type: r.type, id: r.id, deleted: true }))
	await b.api('POST', 'backup', { records: deletions })
	assert.equal((await view(b)).commitments.length, 2)
	ok('a backup never deletes anything')

	// --- what isn't valid ---
	const thesisRec = records.find((r) => r.type === 'commitment' && r.fields.name === 'Thesis')
	const future = '9999999999999-0000-evil'
	const bad = await b.api('POST', 'backup', { records: [
		{ type: 'file', id: thesisRec.id, fields: { name: 'x' }, clock: { name: thesisRec.clock.name } },
		{ type: 'task', id: '../../etc', fields: { title: 'x' }, clock: { title: thesisRec.clock.name } },
		{ type: 'commitment', id: thesisRec.id, fields: { name: 'Hijacked' }, clock: { name: future } },
		{ type: 'commitment', id: thesisRec.id, fields: { name: 'No clock' } },
		null, 'text', 42,
	] })
	assert.deepEqual(bad.rejected.map((r) => r.reason).sort(), ['Incomplete record', 'Incomplete record', 'Invalid id', 'Unknown type'])
	assert.ok((await view(b)).commitments.some((c) => c.startsWith('Thesis ')), 'a clock far ahead or none at all changes nothing')
	await assert.rejects(b.api('POST', 'backup', { records: 'all' }), /Invalid backup/)
	await assert.rejects(b.api('POST', 'backup', { records: new Array(2001).fill(null) }), /Too many/)
	ok('refused: unknown types, bad ids, clocks far ahead, fields without clocks, oversized requests')

	// --- the import reaches the other devices: it is sent with the next sync ---
	const pushed = []
	const remote = { pull: async () => ({ cursor: 0, more: false, records: [] }), push: async (recs) => { pushed.push(...recs); return { rejected: [] } } }
	const c = await engine(remote)
	await c.api('POST', 'backup', { records })
	await c.sync()
	const sent = new Set(pushed.map((r) => r.type + ':' + r.id))
	for (const r of records) assert.ok(sent.has(r.type + ':' + r.id), 'sent ' + r.type)
	ok('imported records are sent on with the next sync')

	console.log('backup: all tests passed')
})().catch((e) => { console.error('✘', e); process.exit(1) })
