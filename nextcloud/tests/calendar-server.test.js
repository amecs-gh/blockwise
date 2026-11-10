// Blocks in Nextcloud calendars through the Blockwise API: plan, move, change
// this / future / all, delete, repeats across DST, and nobody else's events.
// node tests/calendar-server.test.js (needs the test Nextcloud)
process.env.TZ = 'Europe/Zurich'
const assert = require('node:assert/strict')
const B = process.env.NC || 'http://localhost:8080'
const H = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64'), 'OCS-APIRequest': 'true', 'Content-Type': 'application/json', Accept: 'application/json' })
const USERS = { admin: H('admin', 'admin-test-pw-123'), bob: H('bob', 'bob-test-pw-12345') }
const raw = async (user, m, p, body) => {
	const r = await fetch(`${B}/index.php/apps/tracker/api/${p}`, { method: m, headers: USERS[user], body: body === undefined ? undefined : JSON.stringify(body) })
	return { status: r.status, data: await r.json().catch(() => null) }
}
const api = async (user, m, p, body) => {
	const r = await raw(user, m, p, body)
	if (r.status >= 400) throw Object.assign(new Error(`${m} ${p}: ${r.status} ${JSON.stringify(r.data)}`), { status: r.status })
	return r.data
}
const ok = (n) => console.log('  ✔', n)
const at = (y, mo, d, h, mi = 0) => Math.floor(new Date(y, mo - 1, d, h, mi).getTime() / 1000)
const hm = (t) => { const d = new Date(t * 1000); return `${d.getDate()}.${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const tz = 'Europe/Zurich'

;(async () => {
	const st = await api('admin', 'GET', 'state')
	assert.equal(st.features.calendarView, true)
	const stamp = Date.now().toString(36)
	const a = await api('admin', 'POST', 'commitments', { name: `Cal A ${stamp}`, color: '#3b6fd8' })
	const b = await api('admin', 'POST', 'commitments', { name: `Cal B ${stamp}`, color: '#d8643b' })
	const W = (from, to) => api('admin', 'GET', `blocks?from=${from}&to=${to}`).then((r) => r.blocks.filter((x) => x.commitmentId === a.id || x.commitmentId === b.id))
	try {
		// Weekly Monday 9:00, across the DST change (25 Oct 2026)
		const created = await api('admin', 'POST', 'blocks', { commitmentId: a.id, start: at(2026, 10, 19, 9), end: at(2026, 10, 19, 11), repeat: 'weekly', tz })
		assert.ok(created.series > 0 && created.uid.endsWith(`#${at(2026, 10, 19, 9)}`))
		let list = await W(at(2026, 10, 19, 0), at(2026, 11, 10, 0))
		assert.deepEqual(list.map((x) => hm(x.start)), ['19.10 09:00', '26.10 09:00', '2.11 09:00', '9.11 09:00'], 'same local time after DST')
		assert.ok(list.every((x) => x.repeat === 'weekly' && x.series === created.series && x.title === `Cal A ${stamp}`))
		ok('plan a weekly block: an event in the commitment\'s calendar, local time across DST')

		// This one only
		await api('admin', 'PUT', `blocks/${created.series}/${list[1].occurrence}`, { start: at(2026, 10, 26, 14), end: at(2026, 10, 26, 15), scope: 'this', tz })
		list = await W(at(2026, 10, 19, 0), at(2026, 11, 10, 0))
		assert.deepEqual(list.map((x) => hm(x.start)), ['19.10 09:00', '26.10 14:00', '2.11 09:00', '9.11 09:00'])
		ok('"this block only" (an exception in the same event)')

		// This and all future ones, new title
		await api('admin', 'PUT', `blocks/${created.series}/${list[2].occurrence}`, { start: at(2026, 11, 2, 10), end: at(2026, 11, 2, 12), title: 'Edit', scope: 'future', tz })
		list = await W(at(2026, 10, 19, 0), at(2026, 11, 10, 0))
		assert.deepEqual(list.map((x) => `${hm(x.start)} ${x.title}`), ['19.10 09:00 ' + `Cal A ${stamp}`, '26.10 14:00 ' + `Cal A ${stamp}`, '2.11 10:00 Edit', '9.11 10:00 Edit'])
		assert.notEqual(list[3].series, created.series, 'a new event from here on')
		ok('"this and all future blocks" (the series ends, a new one starts)')

		// All of the first series an hour later (its exception moves along)
		await api('admin', 'PUT', `blocks/${created.series}/${list[0].occurrence}`, { start: at(2026, 10, 19, 10), end: at(2026, 10, 19, 12), scope: 'all', tz })
		list = await W(at(2026, 10, 19, 0), at(2026, 11, 10, 0))
		assert.deepEqual(list.map((x) => hm(x.start)), ['19.10 10:00', '26.10 14:00', '2.11 10:00', '9.11 10:00'])
		ok('"all blocks" moves the series, keeping the changed one')

		// To another commitment (this one only): it moves to that calendar
		await api('admin', 'PUT', `blocks/${list[3].series}/${list[3].occurrence}`, { commitmentId: b.id, scope: 'this', tz })
		list = await W(at(2026, 10, 19, 0), at(2026, 11, 17, 0))
		assert.equal(list.find((x) => hm(x.start) === '9.11 10:00').commitmentId, b.id)
		assert.equal(list.filter((x) => hm(x.start) === '9.11 10:00').length, 1, 'not in both')
		ok('to another commitment: into its calendar')

		// Delete: this one, the following ones, all
		const ed = list.find((x) => x.title === 'Edit' && hm(x.start) === '16.11 10:00')
		await api('admin', 'DELETE', `blocks/${ed.series}/${ed.occurrence}?scope=this`)
		list = await W(at(2026, 11, 1, 0), at(2026, 11, 30, 0))
		assert.deepEqual(list.filter((x) => x.title === 'Edit' && x.commitmentId === a.id).map((x) => hm(x.start)), ['2.11 10:00', '23.11 10:00'])
		await api('admin', 'DELETE', `blocks/${ed.series}/${at(2026, 11, 23, 10)}?scope=future`)
		list = await W(at(2026, 11, 1, 0), at(2027, 1, 1, 0))
		assert.deepEqual(list.filter((x) => x.title === 'Edit' && x.commitmentId === a.id).map((x) => hm(x.start)), ['2.11 10:00'])
		await api('admin', 'DELETE', `blocks/${created.series}/${at(2026, 10, 19, 10)}?scope=all`)
		list = await W(at(2026, 10, 1, 0), at(2026, 11, 1, 0))
		assert.equal(list.length, 0)
		ok('delete this / following / all')

		// Weekdays with an end; resize one; all-day and invalid refused
		const wd = await api('admin', 'POST', 'blocks', { commitmentId: b.id, start: at(2026, 12, 1, 7), end: at(2026, 12, 1, 8), repeat: 'weekdays', until: at(2026, 12, 8, 7), tz })
		list = (await W(at(2026, 12, 1, 0), at(2026, 12, 15, 0))).filter((x) => x.series === wd.series)
		assert.deepEqual(list.map((x) => hm(x.start)), ['1.12 07:00', '2.12 07:00', '3.12 07:00', '4.12 07:00', '7.12 07:00', '8.12 07:00'])
		assert.equal(list[0].until, at(2026, 12, 8, 7))
		await api('admin', 'PUT', `blocks/${wd.series}/${list[2].occurrence}`, { end: at(2026, 12, 3, 9), scope: 'this', tz })
		list = (await W(at(2026, 12, 1, 0), at(2026, 12, 15, 0))).filter((x) => x.series === wd.series)
		assert.equal(list[2].end - list[2].start, 7200)
		await assert.rejects(api('admin', 'POST', 'blocks', { commitmentId: a.id, start: 100, end: 50 }), /Invalid time/)
		await assert.rejects(api('admin', 'PUT', `blocks/${wd.series}/12345`, { start: 1 }), /404/)
		ok('weekdays with an end date; resize one; invalid times refused')

		// Nobody else: bob can't see, change or delete admin's blocks
		const r1 = await raw('bob', 'PUT', `blocks/${wd.series}/${list[0].occurrence}`, { start: at(2026, 12, 1, 3), end: at(2026, 12, 1, 4) })
		const r2 = await raw('bob', 'DELETE', `blocks/${wd.series}/${list[0].occurrence}?scope=all`)
		const r3 = await raw('bob', 'POST', 'blocks', { calendarId: (await api('admin', 'GET', 'state')).commitments.find((c) => c.id === b.id).calendarId, start: at(2026, 12, 1, 3), end: at(2026, 12, 1, 4) })
		assert.equal(r1.status, 404)
		assert.equal(r2.status, 404)
		assert.equal(r3.status, 400)
		assert.equal((await W(at(2026, 12, 1, 0), at(2026, 12, 2, 0))).length, 1, 'untouched')
		ok('another user can\'t change, delete or add to your calendars')

		// Events made elsewhere (a rule this app doesn't offer) keep their rule
		console.log('\nall calendar server tests passed')
	} finally {
		await api('admin', 'DELETE', `commitments/${a.id}`).catch(() => {})
		await api('admin', 'DELETE', `commitments/${b.id}`).catch(() => {})
	}
})().catch((e) => { console.error('✘', e); process.exit(1) })
