// Backups on the Nextcloud server with blocks: exported from the commitments'
// calendars (a repeat once, its moved and deleted occurrences kept) and imported
// for another user: their commitments get calendars there, the blocks become
// events in them; importing twice adds nothing.
// node tests/backup-server.test.js (needs the test Nextcloud)
process.env.TZ = 'Europe/Zurich'
const assert = require('node:assert/strict')
const B = process.env.NC || 'http://localhost:8080'
const H = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64'), 'OCS-APIRequest': 'true', 'Content-Type': 'application/json', Accept: 'application/json' })
const USERS = { admin: H('admin', 'admin-test-pw-123'), bob: H('bob', 'bob-test-pw-12345') }
const api = async (user, m, p, body) => {
	const r = await fetch(`${B}/index.php/apps/tracker/api/${p}`, { method: m, headers: USERS[user], body: body === undefined ? undefined : JSON.stringify(body) })
	const data = await r.json().catch(() => null)
	if (r.status >= 400) throw new Error(`${m} ${p}: ${r.status} ${JSON.stringify(data)}`)
	return data
}
const ok = (n) => console.log('  ✔', n)
const tz = 'Europe/Zurich'
// Next Monday, local time
const monday = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return d })()
const at = (dayOffset, h) => { const d = new Date(monday); d.setDate(d.getDate() + dayOffset); d.setHours(h); return Math.floor(d / 1000) }
const view = (list) => list.map((x) => `${x.title}@${new Date(x.start * 1000).toISOString().slice(5, 16)}`).sort()

;(async () => {
	const stamp = Date.now().toString(36)
	const a = await api('admin', 'POST', 'commitments', { name: `Backup A ${stamp}`, color: '#3b6fd8' })
	const b = await api('admin', 'POST', 'commitments', { name: `Backup B ${stamp}`, color: '#d8643b' })
	const mine = (list, ids) => list.filter((x) => ids.includes(x.commitmentId))
	let bobIds = []
	try {
		const w = await api('admin', 'POST', 'blocks', { commitmentId: a.id, title: 'Write', start: at(0, 9), end: at(0, 11), repeat: 'weekdays', tz })
		await api('admin', 'POST', 'blocks', { commitmentId: b.id, title: 'Run', start: at(2, 18), end: at(2, 19), tz })
		await api('admin', 'PUT', `blocks/${w.series}/${at(1, 9)}`, { start: at(1, 14), end: at(1, 16), scope: 'this', tz })
		await api('admin', 'DELETE', `blocks/${w.series}/${at(3, 9)}?scope=this`)
		const week = mine((await api('admin', 'GET', `blocks?from=${at(0, 0)}&to=${at(7, 0)}`)).blocks, [a.id, b.id])
		assert.equal(week.length, 5, 'four weekdays (one moved, one deleted) and the run')

		// Export: the blocks with their commitments
		const { records } = await api('admin', 'GET', 'backup')
		const st = await api('admin', 'GET', 'state')
		const uuids = st.commitments.filter((c) => c.id === a.id || c.id === b.id).map((c) => c.uuid)
		assert.equal(uuids.length, 2)
		const ours = records.filter((r) => (r.type === 'commitment' && uuids.includes(r.id)) || (r.type === 'block' && uuids.includes(r.fields.commitment)))
		const blocks = ours.filter((r) => r.type === 'block')
		const series = blocks.find((r) => r.fields.repeat === 'weekdays')
		assert.ok(series, 'the repeat, once')
		assert.deepEqual(series.fields.skip, [at(1, 9), at(3, 9)], 'the moved and deleted occurrences out of it')
		assert.ok(blocks.some((r) => r.fields.title === 'Write' && r.fields.start === at(1, 14) && !r.fields.repeat), 'the moved one on its own')
		assert.ok(blocks.some((r) => r.fields.title === 'Run'))
		assert.ok(blocks.every((r) => Object.keys(r.fields).every((k) => typeof r.clock[k] === 'string')), 'each field with its clock')
		ok('export: commitments and their blocks from the calendars')

		// Import for bob, as from another server (ids are unique on a server: new ones for the test)
		const { randomUUID } = require('node:crypto')
		const ids = new Map(uuids.map((u) => [u, randomUUID()]))
		const theirs = ours.map((x) => x.type === 'commitment' ? { ...x, id: ids.get(x.id) } : { ...x, fields: { ...x.fields, commitment: ids.get(x.fields.commitment) } })
		const r = await api('bob', 'POST', 'backup', { records: theirs })
		assert.equal(r.calendars, 2, 'a calendar per commitment')
		assert.equal(r.blocks, blocks.length)
		const bst = await api('bob', 'GET', 'state')
		bobIds = bst.commitments.filter((c) => [...ids.values()].includes(c.uuid)).map((c) => c.id)
		assert.equal(bobIds.length, 2)
		assert.ok(bst.commitments.filter((c) => bobIds.includes(c.id)).every((c) => c.calendarId !== null), 'each with its calendar')
		const bobWeek = mine((await api('bob', 'GET', `blocks?from=${at(0, 0)}&to=${at(7, 0)}`)).blocks, bobIds)
		assert.deepEqual(view(bobWeek), view(week), 'the same week, in bob\'s calendars')
		const again = await api('bob', 'POST', 'backup', { records: theirs })
		assert.equal(again.blocks, 0, 'not again')
		assert.equal(mine((await api('bob', 'GET', `blocks?from=${at(0, 0)}&to=${at(7, 0)}`)).blocks, bobIds).length, week.length)
		ok('import for another user: a calendar per commitment, the blocks in it, once')
	} finally {
		for (const id of bobIds) await api('bob', 'DELETE', `commitments/${id}?calendar=1`).catch(() => {})
		await api('admin', 'DELETE', `commitments/${a.id}?calendar=1`).catch(() => {})
		await api('admin', 'DELETE', `commitments/${b.id}?calendar=1`).catch(() => {})
	}
	console.log('server backup tests passed')
})().catch((e) => { console.error('✘', e); process.exit(1) })
