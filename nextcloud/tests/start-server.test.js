// The same rule on the Nextcloud server. node tests/start-server.test.js (needs the test Nextcloud)
const assert = require('node:assert/strict')
const B = process.env.NC || 'http://localhost:8080'
const H = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64'), 'OCS-APIRequest': 'true', 'Content-Type': 'application/json', Accept: 'application/json' })
const USERS = { admin: H('admin', 'admin-test-pw-123'), bob: H('bob', 'bob-test-pw-12345') }
const raw = async (u, m, p, body) => { const r = await fetch(`${B}/index.php/apps/tracker/api/${p}`, { method: m, headers: USERS[u], body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) } }
const api = async (u, m, p, body) => { const r = await raw(u, m, p, body); if (r.status >= 400) throw new Error(`${m} ${p}: ${r.status} ${JSON.stringify(r.data)}`); return r.data }
const ok = (n) => console.log('  ✔', n)
;(async () => {
	const c = await api('admin', 'POST', 'commitments', { name: `Start ${Date.now().toString(36)}`, color: '#3b6fd8' })
	const made = []
	try {
		await api('admin', 'POST', 'sessions/stop', {})
		// Leftovers of an earlier run would be "the session before"
		const t = Math.floor(Date.now() / 1000)
		for (const s of await api('admin', 'GET', `sessions?from=${t - 13 * 3600}&to=${t + 10}`)) if (s.end !== null && s.end > t - 13 * 3600) await api('admin', 'DELETE', `sessions/${s.id}`)
		const s1 = await api('admin', 'POST', 'sessions/start', { commitmentId: c.id })
		made.push(s1.id)
		let r = await api('admin', 'PUT', `sessions/${s1.id}`, { start: s1.start - 600 })
		assert.equal(r.start, s1.start - 600)
		assert.equal(r.clamped, false)
		ok('the running session starts 10 minutes earlier')
		const s2 = await api('admin', 'POST', 'sessions/start', {})
		made.push(s2.id)
		r = await api('admin', 'PUT', `sessions/${s2.id}`, { start: s2.start - 300 })
		const prev = (await api('admin', 'GET', `sessions?from=${s2.start - 7200}&to=${s2.start + 10}`)).find((x) => x.id === s1.id)
		assert.equal(prev.end, r.start, 'right after a switch: the one before ends then')
		ok('after a switch: the session before ends earlier too')
		r = await api('admin', 'PUT', `sessions/${s2.id}`, { start: s1.start - 99999 })
		assert.equal(r.start, prev.start + 60, 'the one before keeps a minute')
		assert.equal(r.clamped, true)
		ok('can\'t reach into the session before')
		assert.equal((await raw('admin', 'PUT', `sessions/${s1.id}`, { start: 1 })).status, 400, 'only the running one')
		assert.equal((await raw('bob', 'PUT', `sessions/${s2.id}`, { start: s2.start - 60 })).status, 404, 'not another user\'s')
		assert.equal((await raw('admin', 'PUT', `sessions/${s2.id}`, { start: 'x' })).status, 400)
		ok('only the running session, only your own, only times')
		await api('admin', 'POST', 'sessions/stop', {})
		console.log('\nall start-time server tests passed')
	} finally {
		await api('admin', 'POST', 'sessions/stop', {}).catch(() => {})
		for (const id of made) await api('admin', 'DELETE', `sessions/${id}`).catch(() => {})
		await api('admin', 'DELETE', `commitments/${c.id}`).catch(() => {})
	}
})().catch((e) => { console.error('✘', e); process.exit(1) })
