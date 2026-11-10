// Sync through a drive folder (Dropbox / Google Drive), no server: node tests/filesync.test.js
const assert = require('node:assert/strict')
const { createEngine } = require('../js/engine.js')
const FS = require('../js/filesync.js')
const ok = (name) => console.log('  ✔', name)

/** A drive folder in memory, like the Dropbox / Google Drive stores of the apps */
function memoryDrive() {
	const files = new Map()
	return {
		files,
		list: async () => [...files.keys()],
		read: async (name) => (files.has(name) ? new Uint8Array(files.get(name)) : null),
		write: async (name, bytes, opts = {}) => {
			if (opts.create && files.has(name)) throw Object.assign(new Error('exists'), { exists: true })
			files.set(name, new Uint8Array(bytes))
		},
		remove: async (name) => { files.delete(name) },
	}
}
const memoryStorage = () => { let s = null; return { load: async () => (s ? JSON.parse(s) : null), save: async (db) => { s = JSON.stringify(db) } } }
const noCalendar = { calendars: async () => [], events: async () => [] }

async function device(drive, passphrase, extra = {}) {
	const key = await FS.unlock(drive, passphrase)
	const storage = memoryStorage()
	let remote = null
	const engine = await createEngine({
		storage,
		calendar: extra.calendar || noCalendar,
		remote: { pull: (s, l) => remote.pull(s, l), push: (r) => remote.push(r) },
		nowMs: extra.nowMs,
	})
	remote = await FS.createRemote({ store: drive, key, node: engine.node(), state: memoryStorage() })
	return { engine, remote, key }
}
const view = async (e) => {
	const st = await e.api('GET', 'state')
	const out = { settings: st.settings, running: st.running && st.running.uuid, commitments: [] }
	for (const c of st.commitments) {
		const tasks = await e.api('GET', `tasks?commitmentId=${c.id}`)
		const notes = await e.api('GET', `notes?commitmentId=${c.id}`)
		out.commitments.push({ uuid: c.uuid, name: c.name, tasks: tasks.map((t) => [t.uuid, t.title, t.note, t.done, t.subtasks.map((s) => [s.uuid, s.title, s.done])]), notes: notes.map((n) => [n.uuid, n.text, n.done]) })
	}
	return out
}

;(async () => {
	console.log('the folder and the passphrase')
	const drive = memoryDrive()
	await assert.rejects(FS.unlock(drive, 'short'), /at least 8/)
	const a = await device(drive, 'correct horse battery')
	const info = JSON.parse(new TextDecoder().decode(drive.files.get('blockwise.json')))
	assert.equal(info.kdf.iterations, 600000); assert.equal(info.kdf.name, 'PBKDF2')
	ok('first device sets up the folder (salt, check value; no secrets)')
	await assert.rejects(FS.unlock(drive, 'wrong horse battery'), /Wrong passphrase/)
	ok('another passphrase is refused')

	console.log('two devices')
	const b = await device(drive, 'correct horse battery')
	const ca = await a.engine.api('POST', 'commitments', { name: 'Thesis', color: '#336699' })
	const t = await a.engine.api('POST', 'tasks', { commitmentId: ca.id, title: 'Write chapter 2', subtasks: [{ title: 'Outline', estimate: 30 }, { title: 'Draft 1h' }] })
	const note = await a.engine.api('POST', 'notes', { commitmentId: ca.id, text: '## Ask Prof. Rossi\n- [ ] deadline\n- [ ] format' })
	await a.engine.api('PUT', 'settings', { focusMinutes: 50 })
	await a.engine.sync()
	assert.equal(a.engine.pending(), 0)
	await b.engine.sync()
	assert.deepEqual(await view(b.engine), await view(a.engine))
	ok('what one device makes, the other gets')

	const secret = ['Thesis', 'Write chapter 2', 'Rossi', 'Outline']
	for (const [name, bytes] of drive.files) {
		const text = Buffer.from(bytes).toString('latin1')
		for (const s of secret) assert.ok(!text.includes(s), `"${s}" readable in ${name}`)
	}
	ok(`the drive holds only encrypted files (${drive.files.size - 1} sync files, nothing readable)`)

	// both offline: per field the later change wins
	const tb = (await b.engine.api('GET', `tasks?commitmentId=${(await b.engine.api('GET', 'state')).commitments[0].id}`))[0]
	await a.engine.api('PUT', `tasks/${t.id}`, { title: 'Write chapter 2 (methods)' })
	await new Promise((r) => setTimeout(r, 5))
	await b.engine.api('PUT', `tasks/${tb.id}`, { note: 'Use the 2025 data' })
	await b.engine.api('PUT', `subtasks/${tb.subtasks[0].id}`, { done: true })
	await a.engine.api('DELETE', `subtasks/${t.subtasks[1].id}`)
	await b.engine.api('PUT', `subtasks/${tb.subtasks[1].id}`, { title: 'Draft (edited)' }) // deleted on a: stays deleted
	await a.engine.sync(); await b.engine.sync(); await a.engine.sync()
	const va = await view(a.engine)
	assert.deepEqual(va, await view(b.engine))
	const task = va.commitments[0].tasks[0]
	assert.equal(task[1], 'Write chapter 2 (methods)'); assert.equal(task[2], 'Use the 2025 data')
	assert.equal(task[4].length, 1); assert.equal(task[4][0][2], true)
	ok('edits on both devices merge field by field; deleted stays deleted')

	// two timers started offline: only the newest keeps running
	const cb = (await b.engine.api('GET', 'state')).commitments[0]
	await a.engine.api('POST', 'sessions/start', { commitmentId: ca.id })
	await new Promise((r) => setTimeout(r, 1100))
	const later = await b.engine.api('POST', 'sessions/start', { commitmentId: cb.id })
	await a.engine.sync(); await b.engine.sync(); await a.engine.sync(); await b.engine.sync()
	const ra = (await a.engine.api('GET', 'state')).running
	assert.equal(ra && ra.uuid, later.uuid)
	assert.equal((await b.engine.api('GET', 'state')).running.uuid, later.uuid)
	const sessions = await a.engine.api('GET', 'sessions')
	assert.equal(sessions.filter((x) => x.end === null).length, 1)
	ok('two timers started offline: one keeps running, the other ends where it started')
	await b.engine.api('POST', 'sessions/stop', {})

	console.log('many changes, a new device')
	for (let i = 0; i < 45; i++) {
		await a.engine.api('PUT', `notes/${note.id}`, { text: `## Ask Prof. Rossi\n- [ ] deadline\n- [ ] format\n\nversion ${i}` })
		await a.engine.sync()
	}
	const aFiles = [...drive.files.keys()].filter((n) => n.startsWith(`log-${a.engine.node()}-`))
	assert.ok(aFiles.length <= 10, `own files merged: ${aFiles.length} left`)
	await b.engine.sync(); await a.engine.sync()
	const c = await device(drive, 'correct horse battery')
	await c.engine.sync()
	assert.deepEqual(await view(c.engine), await view(a.engine))
	assert.deepEqual(await view(b.engine), await view(a.engine))
	ok(`a device's old files are merged into one (${aFiles.length} left); a new device gets everything`)

	// a deleted commitment disappears everywhere, with its tasks and notes
	await c.engine.api('DELETE', `commitments/${(await c.engine.api('GET', 'state')).commitments[0].id}`)
	await c.engine.sync(); await a.engine.sync(); await b.engine.sync()
	for (const d of [a, b, c]) assert.equal((await d.engine.api('GET', 'state')).commitments.length, 0)
	assert.equal((await a.engine.api('GET', 'notes')).length, 0)
	ok('deleting a commitment reaches every device')

	console.log('attacks on the drive')
	const victim = [...drive.files.keys()].find((n) => n.startsWith('log-'))
	const bytes = drive.files.get(victim)
	const flipped = new Uint8Array(bytes); flipped[flipped.length - 3] ^= 1
	drive.files.set(victim, flipped)
	const d = await device(drive, 'correct horse battery')
	await assert.rejects(d.engine.sync(), /could not be decrypted/)
	drive.files.set(victim, bytes)
	ok('a changed byte is noticed (sync stops, nothing is merged)')

	const names = [...drive.files.keys()].filter((n) => n.startsWith('log-'))
	if (names.length >= 2) {
		const [x, y] = names
		const bx = drive.files.get(x), by = drive.files.get(y)
		drive.files.set(x, by); drive.files.set(y, bx)
		const e = await device(drive, 'correct horse battery')
		await assert.rejects(e.engine.sync(), /could not be decrypted|does not match/)
		drive.files.set(x, bx); drive.files.set(y, by)
		ok('swapped files are noticed (the name is part of the encryption)')
	}
	const stranger = memoryDrive()
	for (const [n, v] of drive.files) stranger.files.set(n, v)
	const otherKey = await FS.unlock(memoryDrive(), 'another passphrase here')
	const spy = await FS.createRemote({ store: stranger, key: otherKey, node: 'spy' })
	await assert.rejects(spy.pull(0), /could not be decrypted/)
	ok('with another key nothing can be read')

	// forged record types and fields are ignored by the engine like the server's
	const forger = await FS.createRemote({ store: drive, key: a.key, node: 'forger' })
	await forger.push([{ type: '__proto__', id: 'x', fields: { polluted: true } }, { type: 'task', id: 'not-a-uuid', fields: { title: 'x' } }, { type: 'note', id: '11111111-1111-4111-8111-111111111111', fields: { constructor: 'x', text: { evil: 1 } }, clock: {} }])
	await a.engine.sync()
	assert.equal(({}).polluted, undefined)
	assert.equal((await a.engine.api('GET', 'notes')).length, 0)
	ok('malformed records from the folder are ignored')
	console.log('all file sync checks passed')
})().catch((err) => { console.error('✘', err); process.exit(1) })
