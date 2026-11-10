// Engine test against the Nextcloud test server: node tests/engine.test.js
// 1. parity: the engine, synced from the server, answers like the server
// 2. offline: two devices edit offline, sync, and end up with the same data
const assert = require('node:assert/strict')
const { createEngine } = require('../js/engine.js')
const B = process.env.NC || 'http://localhost:8080'
const H = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64'), 'OCS-APIRequest': 'true', 'Content-Type': 'application/json', Accept: 'application/json' })
const USERS = { admin: H('admin', 'admin-test-pw-123'), bob: H('bob', 'bob-test-pw-12345') }
const server = async (user, m, p, body) => {
	const r = await fetch(`${B}/index.php/apps/tracker/api/${p}`, { method: m, headers: USERS[user], body: body === undefined ? undefined : JSON.stringify(body) })
	const d = await r.json().catch(() => null)
	if (r.status >= 400) throw Object.assign(new Error(`${m} ${p}: ${r.status} ${JSON.stringify(d)}`), { status: r.status })
	return d
}
const ok = (name) => console.log('  ✔', name)

/** Calendar source backed by the server (on Android: the phone's calendar storage) */
const serverCalendar = (user) => {
	let cals = []
	return {
		online: true,
		async calendars() {
			if (!this.online) throw new Error('offline')
			cals = (await server(user, 'GET', 'state')).calendars.map((c) => ({ id: c.id, url: c.url, name: c.name, color: c.color }))
			return cals
		},
		async events(from, to, urls) {
			if (!this.online) throw new Error('offline')
			const { blocks } = await server(user, 'GET', `blocks?from=${from}&to=${to}`)
			return blocks.map((b) => ({ uid: b.uid, title: b.title, start: b.start, end: b.end, url: (cals.find((c) => c.id === b.calendarId) || {}).url })).filter((e) => urls.includes(e.url))
		},
	}
}
const memoryStorage = () => {
	let saved = null
	return { load: async () => (saved ? JSON.parse(saved) : null), save: async (db) => { saved = JSON.stringify(db) } }
}
const serverRemote = (user) => ({
	online: true,
	async pull(since, limit) { if (!this.online) throw new Error('offline'); return server(user, 'GET', `sync?since=${since}&limit=${limit}`) },
	async push(records) { if (!this.online) throw new Error('offline'); return server(user, 'POST', 'sync', { records }) },
})
const device = async (user) => {
	const calendar = serverCalendar(user)
	const remote = serverRemote(user)
	const engine = await createEngine({ storage: memoryStorage(), remote, calendar })
	return { engine, remote, calendar, offline() { remote.online = calendar.online = false }, online() { remote.online = calendar.online = true } }
}

// --- comparing answers by uuid (local numbers differ from the server's ids) ---
const byUuid = (list) => Object.fromEntries(list.map((x) => [x.uuid, x]))
const cmpCommitment = (c) => ({ name: c.name, color: c.color, position: c.position, weeklyGoal: c.weeklyGoal ?? null, calendarUrl: c.calendarUrl ?? null, linked: c.calendarId !== null })
const cmpTask = (t) => ({ title: t.title, note: t.note ?? null, estimate: t.estimate, done: t.done, doneAt: t.doneAt, carried: t.carried, subtasks: t.subtasks.map((s) => [s.uuid, s.title, s.estimate, s.done, s.doneAt]) })

;(async () => {
	console.log('parity with the server')
	const d1 = await device('admin')
	const e = d1.engine
	await e.sync()
	ok(`synced ${Object.keys(e._db().records.task).length} tasks, ${Object.keys(e._db().records.session).length} sessions`)

	const [ss, es] = [await server('admin', 'GET', 'state'), await e.api('GET', 'state')]
	assert.deepEqual(es.settings, ss.settings)
	assert.equal(es.longBreakUntil, ss.longBreakUntil)
	assert.deepEqual(es.commitments.map((c) => c.uuid), ss.commitments.map((c) => c.uuid), 'same commitments, same order')
	const sc = byUuid(ss.commitments)
	for (const c of es.commitments) assert.deepEqual(cmpCommitment(c), cmpCommitment(sc[c.uuid]), c.name)
	assert.equal(es.calendars.length, ss.calendars.length)
	assert.deepEqual(es.calendars.map((c) => c.linked).sort(), ss.calendars.map((c) => c.linked).sort())
	assert.equal(es.running?.start ?? null, ss.running?.start ?? null)
	ok('state: commitments, calendars, settings, running timer')

	const idMap = (sList, eList) => new Map(eList.map((x) => [x.id, sList.find((y) => y.uuid === x.uuid)?.id]))
	const cIds = idMap(ss.commitments, es.commitments)
	for (const c of es.commitments) {
		for (const status of ['open', 'done', 'all']) {
			const st = await server('admin', 'GET', `tasks?commitmentId=${cIds.get(c.id)}${status === 'all' ? '' : '&status=' + status}`)
			const et = await e.api('GET', `tasks?commitmentId=${c.id}${status === 'all' ? '' : '&status=' + status}`)
			assert.deepEqual(et.map((t) => t.uuid), st.map((t) => t.uuid), `${c.name} ${status}: same tasks, same order`)
			const sm = byUuid(st)
			for (const t of et) assert.deepEqual(cmpTask(t), cmpTask(sm[t.uuid]), t.title)
		}
	}
	ok('tasks and subtasks of every commitment (open, done, all)')

	const t0 = Math.floor(Date.now() / 1000)
	const q = `from=${t0 - 60 * 86400}&to=${t0 + 14 * 86400}`
	const [sb, eb] = [await server('admin', 'GET', `blocks?${q}`), await e.api('GET', `blocks?${q}`)]
	const blk = (b) => [b.uid, b.title, b.start, b.end]
	assert.deepEqual(eb.blocks.map(blk), sb.blocks.map(blk))
	assert.deepEqual(eb.overlaps.map((o) => [o.a.uid, o.b.uid, o.start, o.end]), sb.overlaps.map((o) => [o.a.uid, o.b.uid, o.start, o.end]))
	ok(`blocks and overlaps (${eb.blocks.length} blocks, ${eb.overlaps.length} overlaps)`)

	const [sd, ed] = [await server('admin', 'GET', `done?${q}`), await e.api('GET', `done?${q}`)]
	assert.deepEqual(ed.map((x) => [x.title, x.task, x.doneAt]), sd.map((x) => [x.title, x.task, x.doneAt]))
	const [sse, ese] = [await server('admin', 'GET', `sessions?${q}`), await e.api('GET', `sessions?${q}`)]
	assert.deepEqual(ese.map((x) => [x.uuid, x.start, x.end, x.pomodoro, x.blockUid]), sse.map((x) => [x.uuid, x.start, x.end, x.pomodoro, x.blockUid]))
	ok(`done (${ed.length}) and tracked time (${ese.length})`)

	const [sdash, edash] = [await server('admin', 'GET', 'dashboard'), await e.api('GET', 'dashboard')]
	await e.sync() // carry-over marks the engine added are the same ones the server has (a set)
	const tUuid = (list, id) => list.flatMap((c) => c.queue).find((t) => t.id === id)?.uuid
	for (const c of edash.commitments) {
		const s = sdash.commitments.find((x) => x.commitment.uuid === c.commitment.uuid)
		const name = c.commitment.name
		assert.equal(c.currentBlock?.uid ?? null, s.currentBlock?.uid ?? null, name + ' current block')
		assert.equal(c.nextBlock?.uid ?? null, s.nextBlock?.uid ?? null, name + ' next block')
		assert.deepEqual(c.upcoming.map((b) => b.uid), s.upcoming.map((b) => b.uid), name + ' upcoming')
		assert.deepEqual(c.queue.map((t) => t.uuid), s.queue.map((t) => t.uuid), name + ' queue')
		assert.deepEqual(c.plannedTaskIds.map((id) => tUuid(edash.commitments, id)), s.plannedTaskIds.map((id) => tUuid(sdash.commitments, id)), name + ' planned')
		assert.deepEqual(c.capacity, s.capacity, name + ' capacity')
	}
	assert.equal(edash.overlaps.length, sdash.overlaps.length)
	ok('dashboard: current/next block, queue, plan, capacity')

	console.log('local changes reach the server')
	const c0 = es.commitments[0]
	const nt = await e.api('POST', 'tasks', { commitmentId: c0.id, title: 'Engine task 25m' })
	assert.equal(nt.title, 'Engine task'); assert.equal(nt.estimate, 25)
	const withSubs = await e.api('POST', `tasks/${nt.id}/subtasks`, { title: 'second 1h30' })
	assert.equal(withSubs.estimate, 25 + 90)
	await e.api('PUT', `subtasks/${withSubs.subtasks[0].id}`, { done: true })
	const half = (await e.api('GET', `tasks?commitmentId=${c0.id}`)).find((t) => t.uuid === nt.uuid)
	assert.equal(half.done, false)
	await assert.rejects(e.api('DELETE', `subtasks/${999999}`), /Not found/)
	assert.ok(e.pending() > 0)
	await e.sync()
	assert.equal(e.pending(), 0)
	const onServer = (await server('admin', 'GET', `tasks?commitmentId=${cIds.get(c0.id)}`)).find((t) => t.uuid === nt.uuid)
	assert.deepEqual(cmpTask(onServer), cmpTask(half)); ok('task with subtasks made on the device is on the server, identical')

	const run = await e.api('POST', 'sessions/start', { commitmentId: c0.id })
	assert.equal(run.end, null)
	await e.sync()
	assert.equal((await server('admin', 'GET', 'state')).running.uuid, run.uuid)
	const stopped = await e.api('POST', 'sessions/stop', { longBreak: true })
	assert.ok(stopped.session.end >= run.start && stopped.longBreakUntil > stopped.session.end)
	await e.sync()
	const st2 = await server('admin', 'GET', 'state')
	assert.equal(st2.running, null); assert.equal(st2.longBreakUntil, stopped.longBreakUntil)
	ok('timer started and stopped on the device (with long break) shows on the server')

	console.log('offline: two devices')
	const p1 = await device('bob'), p2 = await device('bob')
	await p1.engine.sync(); await p2.engine.sync()
	p1.offline(); p2.offline()
	const ce = await p1.engine.api('POST', 'commitments', { name: 'Offline commitment', color: '#336699' })
	assert.equal(ce.calendarUrl, null)
	const ta = await p1.engine.api('POST', 'tasks', { commitmentId: ce.id, title: 'Made offline', subtasks: [{ title: 'a', estimate: 10 }, { title: 'b' }] })
	await assert.rejects(p1.engine.sync(), /offline/)
	assert.ok(p1.engine.pending() > 0, 'changes wait while offline')
	p1.online(); await p1.engine.sync(); p1.offline()
	const fresh = (await p1.engine.api('GET', 'state')).commitments.find((c) => c.uuid === ce.uuid)
	assert.match(fresh.calendarUrl, /^\/remote\.php\/dav\/calendars\/bob\/offline-commitment.*\/$/); ok('a commitment made offline gets its calendar when it syncs')

	p2.online(); await p2.engine.sync(); p2.offline()
	const onP2 = (await p2.engine.api('GET', 'state')).commitments.find((c) => c.uuid === ce.uuid)
	const taskP2 = (await p2.engine.api('GET', `tasks?commitmentId=${onP2.id}`))[0]
	const taskP1 = (await p1.engine.api('GET', `tasks?commitmentId=${ce.id}`))[0]
	// both offline: p1 renames the task, p2 writes a note and finishes subtask a; p1 later renames again
	await p1.engine.api('PUT', `tasks/${taskP1.id}`, { title: 'Renamed on phone 1' })
	await p2.engine.api('PUT', `tasks/${taskP2.id}`, { title: 'Renamed on phone 2', note: 'note from 2' })
	await p2.engine.api('PUT', `subtasks/${taskP2.subtasks[0].id}`, { done: true })
	await new Promise((r) => setTimeout(r, 5))
	await p1.engine.api('PUT', `tasks/${taskP1.id}`, { title: 'Renamed on phone 1 again' })
	await p1.engine.api('PUT', 'settings', { focusMinutes: 40 })
	await p2.engine.api('PUT', 'settings', { shortBreakMinutes: 7 })
	// p2 deletes subtask b while p1 edits it: deleted wins
	await p2.engine.api('DELETE', `subtasks/${taskP2.subtasks[1].id}`)
	await p1.engine.api('PUT', `subtasks/${taskP1.subtasks[1].id}`, { title: 'b edited' })
	// timers on both: only one keeps running
	await p1.engine.api('POST', 'sessions/start', { commitmentId: ce.id })
	await new Promise((r) => setTimeout(r, 1100))
	const later = await p2.engine.api('POST', 'sessions/start', { commitmentId: onP2.id })
	p1.online(); p2.online()
	await p2.engine.sync(); await p1.engine.sync(); await p2.engine.sync()
	assert.equal(p1.engine.pending() + p2.engine.pending(), 0)
	const view = async (d) => {
		const s = await d.engine.api('GET', 'state')
		const c = s.commitments.find((x) => x.uuid === ce.uuid)
		return { settings: s.settings, running: s.running?.uuid ?? null, tasks: (await d.engine.api('GET', `tasks?commitmentId=${c.id}`)).map(cmpTask) }
	}
	const [v1, v2] = [await view(p1), await view(p2)]
	assert.deepEqual(v1, v2, 'both phones agree')
	const t = v1.tasks[0]
	assert.equal(t.title, 'Renamed on phone 1 again'); assert.equal(t.note, 'note from 2')
	assert.equal(t.subtasks.length, 1); assert.equal(t.subtasks[0][3], true); assert.equal(t.done, true, 'the only subtask left is done')
	assert.equal(v1.settings.focusMinutes, 40); assert.equal(v1.settings.shortBreakMinutes, 7)
	assert.equal(v1.running, later.uuid)
	ok('per field: latest change wins; deleted stays deleted; one timer keeps running; settings merge')
	const sv = await server('bob', 'GET', `tasks?commitmentId=${(await server('bob', 'GET', 'state')).commitments.find((c) => c.uuid === ce.uuid).id}`)
	assert.deepEqual(sv.map(cmpTask), v1.tasks); ok('the server agrees too')

	console.log('refused changes, server restore')
	{
		// A phone whose date is 3 days ahead: the server refuses its changes
		let changes = 0, syncs = 0
		const ahead = await createEngine({ storage: memoryStorage(), remote: serverRemote('bob'), calendar: serverCalendar('bob'), nowMs: () => Date.now() + 3 * 86400000, onChange: (db, info) => { if (info && info.sync) syncs++; else changes++ } })
		await ahead.sync()
		assert.equal(changes, 0, 'a sync is not reported as a local change (no endless syncing)')
		assert.equal(syncs, 1)
		const st = await ahead.api('GET', 'state')
		const c = st.commitments.find((x) => x.uuid === ce.uuid)
		const t = (await ahead.api('GET', `tasks?commitmentId=${c.id}`))[0]
		await ahead.api('PUT', `tasks/${t.id}`, { title: 'From the future' })
		const r = await ahead.sync()
		assert.ok(r.refused.length >= 1 && /too far ahead/.test(r.refused[0].reason), 'refused, with the reason')
		const back = (await ahead.api('GET', `tasks?commitmentId=${c.id}`)).find((x) => x.uuid === t.uuid)
		assert.equal(back.title, v1.tasks[0].title, 'the refused change is undone: the server\'s version is back')
		assert.equal(ahead.pending(), 0)
		assert.ok((await ahead.api('GET', 'state')).sync.refused.reasons.length, 'the app can tell you')
		ok('a change the server refuses is undone and reported, not kept forever')

		// The server "restored from a backup": its change counter is behind the phone's cursor
		const db = p1.engine._db()
		const savedCursor = db.cursor
		db.cursor = savedCursor + 1000000
		const r2 = await p1.engine.sync()
		assert.ok(r2.pulled > 0, 'pulled everything again')
		assert.equal(p1.engine.pending(), 0, 'and sent its data again')
		ok('after a server restore the phone pulls everything and sends its data again')
	}

	// tidy up
	await p1.engine.api('POST', 'sessions/stop', {})
	await p1.engine.api('DELETE', `commitments/${ce.id}`)
	await p1.engine.api('DELETE', `tasks/${nt.id}`).catch(() => {})
	await p1.engine.sync(); await p2.engine.sync()
	assert.equal((await p2.engine.api('GET', 'state')).commitments.some((c) => c.uuid === ce.uuid), false)
	await e.api('DELETE', `tasks/${nt.id}`); await e.sync()
	ok('deleting a commitment reaches the other phone')
	console.log('all engine checks passed')
})().catch((err) => { console.error('✘', err); process.exit(1) })
