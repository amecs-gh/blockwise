// Notes (Notes tab): node tests/notes.test.js (needs the test Nextcloud)
const assert = require('node:assert/strict')
const { createEngine } = require('../js/engine.js')
const B = process.env.NC || 'http://localhost:8080'
const H = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64'), 'OCS-APIRequest': 'true', 'Content-Type': 'application/json', Accept: 'application/json' })
const USERS = { admin: H('admin', 'admin-test-pw-123'), bob: H('bob', 'bob-test-pw-12345') }
const raw = async (user, m, p, body) => {
	const r = await fetch(`${B}/index.php/apps/tracker/api/${p}`, { method: m, headers: USERS[user], body: body === undefined ? undefined : JSON.stringify(body) })
	return { status: r.status, data: await r.json().catch(() => null) }
}
const server = async (user, m, p, body) => {
	const r = await raw(user, m, p, body)
	if (r.status >= 400) throw Object.assign(new Error(`${m} ${p}: ${r.status} ${JSON.stringify(r.data)}`), { status: r.status })
	return r.data
}
const ok = (name) => console.log('  ✔', name)
const memoryStorage = () => { let saved = null; return { load: async () => (saved ? JSON.parse(saved) : null), save: async (db) => { saved = JSON.stringify(db) } } }
const device = async (user) => {
	const net = { online: true }
	const remote = {
		pull: (since, limit) => { if (!net.online) throw new Error('offline'); return server(user, 'GET', `sync?since=${since}&limit=${limit}`) },
		push: (records) => { if (!net.online) throw new Error('offline'); return server(user, 'POST', 'sync', { records }) },
	}
	const calendar = { calendars: async () => [], events: async () => [] }
	return { engine: await createEngine({ storage: memoryStorage(), remote, calendar }), net }
}
const view = (n) => ({ uuid: n.uuid, text: n.text, done: n.done, doneAt: n.doneAt, position: n.position })

;(async () => {
	console.log('notes on the server')
	const c = await server('bob', 'POST', 'commitments', { name: 'Notes test ' + Date.now(), color: '#aa5500' })
	const n1 = await server('bob', 'POST', 'notes', { commitmentId: c.id, text: '  Call the supervisor\nabout chapter 2  ' })
	assert.equal(n1.text, 'Call the supervisor\nabout chapter 2'); assert.equal(n1.done, false); assert.equal(n1.position, 1)
	const n2 = await server('bob', 'POST', 'notes', { commitmentId: c.id, text: 'Buy printer paper' })
	assert.equal(n2.position, 2)
	assert.equal((await raw('bob', 'POST', 'notes', { commitmentId: c.id, text: '   ' })).status, 400)
	assert.equal((await raw('bob', 'POST', 'notes', { commitmentId: c.id, text: { x: 1 } })).status, 400)
	assert.equal((await server('bob', 'POST', 'notes', { commitmentId: c.id, text: 'x'.repeat(25000) })).text.length, 20000)
	ok('create: trimmed, required, at most 20000 characters')

	const ticked = await server('bob', 'PUT', `notes/${n1.id}`, { done: true })
	assert.equal(ticked.done, true); assert.ok(ticked.doneAt > 0)
	assert.deepEqual((await server('bob', 'GET', `notes?commitmentId=${c.id}&status=open`)).map((n) => n.id).includes(n1.id), false)
	assert.deepEqual((await server('bob', 'GET', `notes?commitmentId=${c.id}&status=done`)).map((n) => n.id), [n1.id])
	const t0 = Math.floor(Date.now() / 1000)
	const done = await server('bob', 'GET', `done?from=${t0 - 3600}&to=${t0 + 3600}`)
	const item = done.find((x) => x.kind === 'note' && x.id === n1.id)
	assert.ok(item, 'ticked note in Done'); assert.equal(item.title, 'Call the supervisor'); assert.equal(item.commitmentId, c.id); assert.equal(item.task, null)
	const unticked = await server('bob', 'PUT', `notes/${n1.id}`, { done: false })
	assert.equal(unticked.doneAt, null)
	assert.ok(!(await server('bob', 'GET', `done?from=${t0 - 3600}&to=${t0 + 3600}`)).some((x) => x.kind === 'note' && x.id === n1.id))
	ok('tick: leaves the open list, shows in Done (first line as title); untick removes it')

	await server('bob', 'POST', 'notes-order', { commitmentId: c.id, ids: [n2.id, n1.id] })
	assert.deepEqual((await server('bob', 'GET', `notes?commitmentId=${c.id}&status=open`)).slice(0, 2).map((n) => n.id), [n2.id, n1.id])
	ok('reorder')

	// Someone else's notes
	assert.equal((await raw('admin', 'PUT', `notes/${n1.id}`, { text: 'pwned' })).status, 404)
	assert.equal((await raw('admin', 'DELETE', `notes/${n1.id}`)).status, 404)
	assert.equal((await raw('admin', 'GET', `notes?commitmentId=${c.id}`)).status, 404)
	assert.equal((await raw('admin', 'POST', 'notes', { commitmentId: c.id, text: 'x' })).status, 404)
	const ac = (await server('admin', 'GET', 'state')).commitments[0]
	assert.equal((await raw('bob', 'PUT', `notes/${n1.id}`, { commitmentId: ac.id })).status, 404)
	assert.ok(!(await server('admin', 'GET', 'notes')).some((n) => n.id === n1.id))
	assert.equal((await server('bob', 'GET', `notes?commitmentId=${c.id}`)).find((n) => n.id === n1.id).text, n1.text)
	ok("other users can't read, change, move into their commitment, or delete your notes")

	console.log('notes on the phone (engine)')
	const p1 = await device('bob')
	const p2 = await device('bob')
	await p1.engine.sync(); await p2.engine.sync()
	const ec = (await p1.engine.api('GET', 'state')).commitments.find((x) => x.uuid === c.uuid)
	const sNotes = await server('bob', 'GET', `notes?commitmentId=${c.id}`)
	const eNotes = await p1.engine.api('GET', `notes?commitmentId=${ec.id}`)
	assert.deepEqual(eNotes.map(view), sNotes.map(view)); ok('the phone has the same notes, same order')

	p1.net.online = false
	const offline = await p1.engine.api('POST', 'notes', { commitmentId: ec.id, text: 'Written offline' })
	await p1.engine.api('PUT', `notes/${offline.id}`, { done: true })
	const tickedOnPhone = eNotes.find((n) => n.uuid === n2.uuid)
	await p1.engine.api('PUT', `notes/${tickedOnPhone.id}`, { done: true, text: 'Buy printer paper (A4)' })
	const pd = await p1.engine.api('GET', `done?from=${t0 - 3600}&to=${t0 + 3600}`)
	assert.ok(pd.some((x) => x.kind === 'note' && x.title === 'Written offline'), 'in Done on the phone, offline')
	p1.net.online = true
	await p1.engine.sync()
	assert.equal(p1.engine.pending(), 0)
	const after = await server('bob', 'GET', `notes?commitmentId=${c.id}`)
	assert.ok(after.some((n) => n.uuid === offline.uuid && n.done && n.text === 'Written offline'))
	assert.equal(after.find((n) => n.uuid === n2.uuid).text, 'Buy printer paper (A4)')
	const sd = await server('bob', 'GET', `done?from=${t0 - 3600}&to=${t0 + 3600}`)
	const ed = await p1.engine.api('GET', `done?from=${t0 - 3600}&to=${t0 + 3600}`)
	const doneView = (list) => list.filter((x) => x.kind === 'note').map((x) => [x.title, x.doneAt]).sort()
	assert.deepEqual(doneView(ed), doneView(sd)); ok('written and ticked offline: on the server after syncing; Done is the same')

	// both phones edit the same note offline: per field, the later change wins
	await p2.engine.sync()
	const onP2 = (await p2.engine.api('GET', `notes?commitmentId=${(await p2.engine.api('GET', 'state')).commitments.find((x) => x.uuid === c.uuid).id}`)).find((n) => n.uuid === n1.uuid)
	const onP1 = (await p1.engine.api('GET', `notes?commitmentId=${ec.id}`)).find((n) => n.uuid === n1.uuid)
	p1.net.online = p2.net.online = false
	await p2.engine.api('PUT', `notes/${onP2.id}`, { text: 'Edited on phone 2' })
	await new Promise((r) => setTimeout(r, 5))
	await p1.engine.api('PUT', `notes/${onP1.id}`, { done: true })
	p1.net.online = p2.net.online = true
	await p1.engine.sync(); await p2.engine.sync(); await p1.engine.sync()
	const a = (await p1.engine.api('GET', `notes?commitmentId=${ec.id}`)).find((n) => n.uuid === n1.uuid)
	assert.equal(a.text, 'Edited on phone 2'); assert.equal(a.done, true)
	assert.deepEqual(view((await server('bob', 'GET', `notes?commitmentId=${c.id}`)).find((n) => n.uuid === n1.uuid)), view(a))
	ok('the same note edited on two phones offline: both changes kept')

	// deleted on one phone: gone everywhere
	await p2.engine.api('DELETE', `notes/${onP2.id}`)
	await p2.engine.sync(); await p1.engine.sync()
	assert.ok(!(await p1.engine.api('GET', `notes?commitmentId=${ec.id}`)).some((n) => n.uuid === n1.uuid))
	assert.ok(!(await server('bob', 'GET', `notes?commitmentId=${c.id}`)).some((n) => n.uuid === n1.uuid))
	ok('a note deleted on one phone is gone everywhere')

	// bad note records from a device are refused
	const crypto = require('node:crypto')
	const bad = await server('bob', 'POST', 'sync', { records: [
		{ type: 'note', id: crypto.randomUUID(), fields: { commitment: ac.uuid, text: 'into admin' }, clock: { commitment: '1800000000000-0000-x', text: '1800000000000-0000-x' } },
		{ type: 'note', id: crypto.randomUUID(), fields: { commitment: c.uuid, text: '' }, clock: { commitment: '1700000000000-0000-x', text: '1700000000000-0000-x' } },
	] })
	assert.equal(bad.rejected.length, 2); ok("sync refuses notes in someone else's commitment, and empty notes")

	// deleting the commitment deletes its notes, on the phones too
	await p1.engine.api('DELETE', `commitments/${ec.id}`)
	await p1.engine.sync(); await p2.engine.sync()
	assert.equal((await raw('bob', 'GET', `notes?commitmentId=${c.id}`)).status, 404)
	assert.ok(!(await server('bob', 'GET', 'notes')).some((n) => n.commitmentId === c.id))
	assert.deepEqual((await p2.engine.api('GET', 'notes')).filter((n) => n.uuid === offline.uuid), [])
	ok('deleting a commitment deletes its notes everywhere')
	console.log('all note checks passed')
})().catch((err) => { console.error('✘', err); process.exit(1) })
