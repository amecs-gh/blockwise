// Sync API test against a Nextcloud test server: node tests/sync.test.js
// (expects admin/admin-test-pw-123 and bob/bob-test-pw-12345 on localhost:8080)
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const B = process.env.NC || 'http://localhost:8080'
const H = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64'), 'OCS-APIRequest': 'true', 'Content-Type': 'application/json', Accept: 'application/json' })
const admin = H('admin', 'admin-test-pw-123'), bob = H('bob', 'bob-test-pw-12345')
const api = async (h, m, p, body) => { const r = await fetch(`${B}/index.php/apps/tracker/api/${p}`, { method: m, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); const d = await r.json().catch(() => null); return { status: r.status, d } }
const uuid = () => crypto.randomUUID()
let tick = 0
const clock = (ms = Date.now(), node = 'phone1') => `${String(ms).padStart(13, '0')}-${(tick++ % 65536).toString(16).padStart(4, '0')}-${node}`
const ok = (name) => console.log('  ✔', name)

async function pullAll(h, since = 0, limit = 1000) {
	const out = []
	let cursor = since, more = true, pages = 0
	while (more) {
		const { status, d } = await api(h, 'GET', `sync?since=${cursor}&limit=${limit}`)
		assert.equal(status, 200, JSON.stringify(d))
		assert.ok(d.cursor >= cursor, 'cursor never goes back')
		out.push(...d.records); cursor = d.cursor; more = d.more; pages++
		if (pages > 500) throw new Error('paging does not end')
	}
	return { records: out, cursor, pages }
}
const latest = (records, id) => records.filter((r) => r.id === id).pop()

;(async () => {
	console.log('pull')
	const full = await pullAll(admin)
	const paged = await pullAll(admin, 0, 7)
	const ids = (rs) => new Set(rs.map((r) => r.type + r.id))
	assert.deepEqual(ids(paged.records), ids(full.records), 'paging gives the same records')
	assert.ok(paged.pages > 3); ok(`full pull = paged pull (${full.records.length} records, ${paged.pages} pages)`)
	const types = new Set(full.records.map((r) => r.type))
	for (const t of ['commitment', 'task', 'subtask', 'session', 'settings']) assert.ok(types.has(t), 'has ' + t)
	const someTask = full.records.find((r) => r.type === 'task' && !r.deleted)
	assert.match(someTask.fields.commitment, /^[0-9a-f-]{36}$/, 'references are uuids')
	const cm = full.records.find((r) => r.type === 'commitment' && r.fields.calendarUrl)
	assert.match(cm.fields.calendarUrl, /^\/remote\.php\/dav\/calendars\/admin\/.+\/$/); ok('commitments carry their calendar address')
	const again = await pullAll(admin, full.cursor)
	assert.equal(again.records.length, 0); ok('nothing new since the cursor')

	console.log('changes from the web app')
	const st = await api(admin, 'GET', 'state')
	const c1 = st.d.commitments[0]
	const created = await api(admin, 'POST', 'tasks', { commitmentId: c1.id, title: 'Sync test web', subtasks: [{ title: 'one', estimate: 20 }, { title: 'two' }] })
	assert.equal(created.status, 200)
	let p = await pullAll(admin, full.cursor)
	const webTask = latest(p.records, created.d.uuid)
	assert.equal(webTask.fields.title, 'Sync test web')
	assert.equal(p.records.filter((r) => r.type === 'subtask' && r.fields.task === created.d.uuid).length, 2)
	assert.match(webTask.clock.title, /-srv$/); ok('a task made in the web app appears with server clocks')
	let cur = p.cursor
	await api(admin, 'PUT', `tasks/${created.d.id}`, { note: 'from web' })
	p = await pullAll(admin, cur)
	const t2 = latest(p.records, created.d.uuid)
	assert.equal(t2.fields.note, 'from web')
	assert.ok(t2.clock.note > webTask.clock.title && t2.clock.title === webTask.clock.title); ok('only the changed field gets a new clock')
	cur = p.cursor

	console.log('push from a phone (offline work)')
	const cId = uuid(), tId = uuid(), s1 = uuid(), s2 = uuid(), sessId = uuid()
	const t0 = Date.now()
	let r = await api(admin, 'POST', 'sync', { records: [
		{ type: 'subtask', id: s1, fields: { task: tId, title: 'Draft', position: 0, done: false, estimate: 45, created: 1 }, clock: { task: clock(), title: clock(), position: clock(), done: clock(), estimate: clock(), created: clock() } },
		{ type: 'task', id: tId, fields: { commitment: cId, title: 'Offline task', position: 0, done: false, created: 1 }, clock: { commitment: clock(), title: clock(), position: clock(), done: clock(), created: clock() } },
		{ type: 'commitment', id: cId, fields: { name: 'Phone commitment', color: '#336699', position: 9, goal: 120 }, clock: { name: clock(), color: clock(), position: clock(), goal: clock() } },
		{ type: 'subtask', id: s2, fields: { task: tId, title: 'Review', position: 1, done: true, doneAt: Math.floor(t0 / 1000) }, clock: { task: clock(), title: clock(), position: clock(), done: clock(), doneAt: clock() } },
		{ type: 'session', id: sessId, fields: { commitment: cId, start: Math.floor(t0 / 1000) - 3600, end: Math.floor(t0 / 1000) - 1800, pomodoro: false }, clock: { commitment: clock(), start: clock(), end: clock(), pomodoro: clock() } },
	] })
	assert.equal(r.status, 200, JSON.stringify(r.d)); assert.deepEqual(r.d.rejected, []); assert.equal(r.d.applied, 5)
	ok('records arrive in any order (parents first)')
	const st2 = await api(admin, 'GET', 'state')
	const phoneC = st2.d.commitments.find((c) => c.uuid === cId)
	assert.ok(phoneC && phoneC.calendarId, 'commitment created with a calendar')
	assert.match(phoneC.calendarUrl, /\/remote\.php\/dav\/calendars\/admin\/phone-commitment/); ok('a commitment made offline gets its Nextcloud calendar')
	const tl = await api(admin, 'GET', `tasks?commitmentId=${phoneC.id}&status=open`)
	assert.equal(tl.d[0].title, 'Offline task'); assert.equal(tl.d[0].subtasks.length, 2); assert.equal(tl.d[0].subtasks[0].estimate, 45)
	ok('the web app shows the phone\'s task and subtasks')
	p = await pullAll(admin, cur)
	assert.ok(latest(p.records, cId).fields.calendarUrl, 'the calendar address comes back to the phone'); cur = p.cursor

	console.log('latest change wins, per field')
	const old = clock(t0 - 60 * 60 * 1000), newer = clock(Date.now() + 1000)
	r = await api(admin, 'POST', 'sync', { records: [{ type: 'task', id: tId, fields: { title: 'Stale title' }, clock: { title: old } }] })
	assert.equal((await api(admin, 'GET', `tasks?commitmentId=${phoneC.id}&status=open`)).d[0].title, 'Offline task'); ok('an older change loses')
	await api(admin, 'PUT', `tasks/${tl.d[0].id}`, { note: 'web note' }) // web edits another field meanwhile
	r = await api(admin, 'POST', 'sync', { records: [{ type: 'task', id: tId, fields: { title: 'Renamed on phone' }, clock: { title: newer } }] })
	const tl2 = (await api(admin, 'GET', `tasks?commitmentId=${phoneC.id}&status=open`)).d[0]
	assert.equal(tl2.title, 'Renamed on phone'); assert.equal(tl2.note, 'web note'); ok('different fields edited on two devices: both survive')
	await api(admin, 'PUT', `tasks/${tl.d[0].id}`, { title: 'Renamed on web, later' })
	p = await pullAll(admin, cur)
	assert.equal(latest(p.records, tId).fields.title, 'Renamed on web, later')
	assert.ok(latest(p.records, tId).clock.title > newer, 'the server clock comes after the clocks it has seen'); ok('server clocks follow device clocks (no going back)')
	cur = p.cursor

	console.log('carried over: a set of blocks')
	r = await api(admin, 'POST', 'sync', { records: [{ type: 'task', id: tId, fields: { carriedBlocks: ['blockA@100', 'blockB@200'] }, clock: { carriedBlocks: clock() } }] })
	r = await api(admin, 'POST', 'sync', { records: [{ type: 'task', id: tId, fields: { carriedBlocks: ['blockB@200', 'blockC@300'] }, clock: { carriedBlocks: clock(t0 - 99999) } }] })
	const tl3 = (await api(admin, 'GET', `tasks?commitmentId=${phoneC.id}&status=open`)).d[0]
	assert.equal(tl3.carried, 3); ok('two devices marking blocks: union, no double counting (3 blocks)')

	console.log('deletions')
	r = await api(admin, 'POST', 'sync', { records: [{ type: 'subtask', id: s2, deleted: true }] })
	p = await pullAll(admin, cur)
	assert.ok(p.records.some((x) => x.id === s2 && x.deleted)); ok('a deletion from the phone reaches the others')
	r = await api(admin, 'POST', 'sync', { records: [{ type: 'subtask', id: s2, fields: { title: 'zombie' }, clock: { title: clock(Date.now() + 5000) } }] })
	assert.equal((await api(admin, 'GET', `tasks?commitmentId=${phoneC.id}&status=open`)).d[0].subtasks.length, 1); ok('deleted stays deleted (a later edit does not bring it back)')
	const sub1 = (await api(admin, 'GET', `tasks?commitmentId=${phoneC.id}&status=open`)).d[0].subtasks[0]
	await api(admin, 'POST', `tasks/${tl.d[0].id}/subtasks`, { title: 'keep one' })
	await api(admin, 'DELETE', `subtasks/${sub1.id}`)
	p = await pullAll(admin, p.cursor)
	assert.ok(p.records.some((x) => x.id === sub1.uuid && x.deleted)); ok('a deletion in the web app becomes a tombstone for devices')
	cur = p.cursor

	console.log('settings')
	r = await api(admin, 'POST', 'sync', { records: [{ type: 'settings', id: 'settings', fields: { focusMinutes: 30, pomodoro: true }, clock: { focusMinutes: clock(Date.now() + 2000), pomodoro: clock(Date.now() + 2000) } }] })
	let sd = (await api(admin, 'GET', 'state')).d.settings
	assert.equal(sd.focusMinutes, 30); assert.equal(sd.pomodoro, true)
	r = await api(admin, 'POST', 'sync', { records: [{ type: 'settings', id: 'settings', fields: { focusMinutes: 50 }, clock: { focusMinutes: clock(t0 - 100000) } }] })
	assert.equal((await api(admin, 'GET', 'state')).d.settings.focusMinutes, 30); ok('settings: later wins, older ignored')
	await new Promise((res) => setTimeout(res, 2200))
	await api(admin, 'PUT', 'settings', { focusMinutes: 25, pomodoro: false })
	p = await pullAll(admin, cur)
	assert.equal(latest(p.records, 'settings').fields.focusMinutes, 25); ok('settings changed in the web app reach devices')
	cur = p.cursor

	console.log('timers on two devices')
	await api(admin, 'POST', 'sessions/stop', {})
	await api(admin, 'POST', 'sessions/start', { commitmentId: phoneC.id })
	const phoneSess = uuid()
	r = await api(admin, 'POST', 'sync', { records: [{ type: 'session', id: phoneSess, fields: { commitment: cId, start: Math.floor(Date.now() / 1000) - 600, end: null, pomodoro: false }, clock: { commitment: clock(), start: clock(), end: clock(), pomodoro: clock() } }] })
	const sess = (await api(admin, 'GET', `sessions?from=${Math.floor(Date.now() / 1000) - 7200}&to=${Math.floor(Date.now() / 1000) + 60}`)).d
	const running = sess.filter((x) => x.end === null)
	assert.equal(running.length, 1, 'one running session'); assert.notEqual(running[0].uuid, phoneSess)
	assert.ok(sess.find((x) => x.uuid === phoneSess).end !== null); ok('two timers started on two devices: the newer keeps running, the older ends')
	await api(admin, 'POST', 'sessions/stop', {})

	console.log('safety')
	r = await api(admin, 'POST', 'sync', { records: [{ type: 'task', id: tId, fields: { title: 'from the future' }, clock: { title: clock(Date.now() + 3 * 86400000) } }] })
	assert.match(r.d.rejected[0].reason, /too far ahead/); ok('clocks days ahead are refused')
	r = await api(bob, 'POST', 'sync', { records: [{ type: 'task', id: tId, fields: { title: 'bob was here' }, clock: { title: clock(Date.now() + 9000) } }] })
	assert.equal(r.d.rejected[0].reason, 'Not found')
	const bobPull = await pullAll(bob)
	assert.ok(!bobPull.records.some((x) => x.id === tId || x.id === cId)); ok('another user can\'t change or see your records')
	r = await api(bob, 'POST', 'sync', { records: [{ type: 'task', id: uuid(), fields: { commitment: cId, title: 'into admin' }, clock: { commitment: clock(), title: clock() } }] })
	assert.match(r.d.rejected[0].reason, /Unknown commitment/); ok('nor attach records to yours')
	r = await api(admin, 'POST', 'sync', { records: [{ type: 'task', id: 'not-a-uuid', fields: {}, clock: {} }, { type: 'evil', id: uuid() }, { type: 'subtask', id: uuid(), fields: { task: tId, title: 7 }, clock: { task: clock(), title: clock() } }] })
	assert.equal(r.d.rejected.length, 3); ok('malformed records are refused, one by one')
	r = await api(admin, 'POST', 'sync', { records: Array.from({ length: 2001 }, () => ({ type: 'task' })) })
	assert.equal(r.status, 400); ok('too many changes at once refused')

	console.log('deleting a commitment from the phone')
	const before = await pullAll(admin, 0)
	r = await api(admin, 'POST', 'sync', { records: [{ type: 'commitment', id: cId, deleted: true }] })
	const after = await pullAll(admin, before.cursor)
	const gone = new Set(after.records.filter((x) => x.deleted).map((x) => x.id))
	assert.ok(gone.has(cId) && gone.has(tId))
	const keepOne = before.records.filter((x) => x.type === 'subtask' && !x.deleted && x.fields.task === tId).map((x) => x.id)
	assert.ok(keepOne.length >= 1 && keepOne.every((id) => gone.has(id)), 'its remaining subtasks are deleted too')
	const unlinked = after.records.filter((x) => x.type === 'session' && x.id === sessId)
	assert.equal(unlinked.pop().fields.commitment, null); ok('its tasks and subtasks are deleted, its tracked time stays (unplanned)')
	assert.ok(!(await api(admin, 'GET', 'state')).d.commitments.some((c) => c.uuid === cId)); ok('gone in the web app too')

	await api(admin, 'DELETE', `tasks/${created.d.id}`)
	console.log('✔ sync tests passed')
})().catch((e) => { console.error('✘', e.message); process.exit(1) })
