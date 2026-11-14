// OneDrive and Outlook (src/drives.js) against a stand-in Microsoft: the browser
// login (PKCE, state, localhost), rotated refresh tokens, the app folder, watching
// it, and Outlook only for Blockwise's own calendars, with nothing but a title,
// times and a repeat in an event. node test/onedrive.test.js
'use strict'
process.env.TZ = 'UTC'
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const drives = require('../src/drives')
const { createCloudCalendar } = require('../../nextcloud/js/cloudcal.js')
const { fakeGraph } = require('../../nextcloud/tests/fake-graph.js')
const ok = (name) => console.log('  ✔', name)
const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const EP = { ...drives.MICROSOFT, authorize: 'https://login.test/authorize', token: 'https://login.test/token', graph: 'https://graph.test/v1.0/', download: /^https:\/\/files\.test\/\S*$/ }

function microsoft() {
	const codes = new Map()
	const refresh = new Map() // token -> scopes
	const access = new Map() // token -> scopes
	const folder = new Map() // name -> {bytes, eTag}
	const graph = fakeGraph({ pageSize: 100 })
	const marks = new Map() // calendar id -> mark value
	const seen = { calls: [], bodies: [] }
	let v = 0
	const res = (status, body, headers = {}) => new Response(body === null || body === undefined ? null : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
	async function fetch(url, init = {}) {
		const u = new URL(url)
		seen.calls.push(`${init.method || 'GET'} ${u.host}${u.pathname}${u.search}`)
		if (u.host === 'files.test') {
			assert.ok(!init.headers || !init.headers.Authorization, 'no login sent to the download link')
			const f = folder.get(u.pathname.slice(1))
			return f ? res(200, f.bytes, { 'Content-Type': 'application/octet-stream' }) : res(404, null)
		}
		if (u.host === 'login.test' && u.pathname === '/token') {
			const f = Object.fromEntries(new URLSearchParams(init.body))
			assert.equal(f.client_id, '00000000-0000-4000-8000-000000000001')
			assert.ok(!f.client_secret, 'a public client: no secret')
			let scopes
			if (f.grant_type === 'authorization_code') {
				const c = codes.get(f.code)
				codes.delete(f.code)
				if (!c || c.redirect !== f.redirect_uri || b64url(crypto.createHash('sha256').update(f.code_verifier || '').digest()) !== c.challenge) return res(400, { error: 'invalid_grant' })
				scopes = c.scope
			} else {
				scopes = refresh.get(f.refresh_token)
				if (!scopes) return res(400, { error: 'invalid_grant' })
				for (const s of f.scope.split(' ')) if (!scopes.includes(s)) return res(400, { error: 'invalid_scope' })
				refresh.delete(f.refresh_token) // (rotated: each one works once here, stricter than Microsoft)
			}
			const r = 'ref-' + crypto.randomBytes(6).toString('hex')
			const a = 'acc-' + crypto.randomBytes(6).toString('hex')
			refresh.set(r, scopes)
			access.set(a, scopes)
			return res(200, { access_token: a, refresh_token: r, expires_in: 3600, scope: scopes.filter((s) => s !== 'offline_access').join(' ') })
		}
		if (u.host !== 'graph.test') return res(404, null)
		const m = /^Bearer (.+)$/.exec((init.headers && init.headers.Authorization) || '')
		const scopes = m && access.get(m[1])
		if (!scopes) return res(401, { error: { message: 'no' } })
		const p = decodeURIComponent(u.pathname.replace(/^\/v1\.0\//, ''))
		let x
		if (p.startsWith('me/drive')) {
			if (!scopes.includes('Files.ReadWrite.AppFolder')) return res(403, null)
			if (p === 'me/drive') return res(200, { id: 'b!drive-1' })
			if (p === 'me/drive/special/approot/children') return res(200, { value: [...folder].map(([name, f]) => ({ name, eTag: f.eTag, file: {} })) })
			if ((x = /^me\/drive\/special\/approot:\/([^:]+):\/content$/.exec(p)) && init.method === 'PUT') {
				if (folder.has(x[1]) && u.searchParams.get('@microsoft.graph.conflictBehavior') === 'fail') return res(409, { error: { message: 'exists' } })
				folder.set(x[1], { bytes: new Uint8Array(init.body), eTag: `"v${++v}"` })
				return res(201, { name: x[1] })
			}
			if ((x = /^me\/drive\/special\/approot:\/([^:]+)$/.exec(p))) {
				if (!folder.has(x[1])) return res(404, { error: { message: 'Not found' } })
				if (init.method === 'DELETE') { folder.delete(x[1]); return res(204, null) }
				return res(200, { id: x[1], '@microsoft.graph.downloadUrl': `https://files.test/${x[1]}` })
			}
			return res(400, null)
		}
		if (!scopes.includes('Calendars.ReadWrite')) return res(403, { error: { message: 'Access is denied.' } })
		const body = init.body ? JSON.parse(init.body) : undefined
		seen.bodies.push(body)
		// The mark: kept apart (the stand-in Graph takes names and colors only)
		if (init.method === 'POST' && p === 'me/calendars') {
			const mark = body.singleValueExtendedProperties
			const made = await graph.request('POST', p, { name: body.name, color: body.color })
			if (mark) marks.set(made.id, mark[0])
			return res(201, made)
		}
		if ((x = /^me\/calendars\/([^/]+)$/.exec(p)) && (init.method || 'GET') === 'GET') {
			if (!graph.cals.has(x[1])) return res(404, { error: { message: 'Not found' } })
			const mk = marks.get(x[1])
			const want = /id eq '([^']+)'/.exec(u.searchParams.get('$expand') || '')
			return res(200, { id: x[1], singleValueExtendedProperties: mk && want && want[1] === mk.id ? [mk] : [] })
		}
		try {
			const out = await graph.request(init.method || 'GET', `${u.pathname.replace(/^\/v1\.0\//, '')}${u.search}`, body)
			return res(out === null ? 204 : 200, out)
		} catch (e) {
			return res(e.status || 500, { error: { message: e.message } })
		}
	}
	/** The browser: Microsoft's page says yes and sends you to the app's address */
	const browser = (urls) => async (url) => {
		const q = new URL(url).searchParams
		urls.push(url)
		assert.equal(q.get('code_challenge_method'), 'S256')
		assert.match(q.get('redirect_uri'), /^http:\/\/localhost:\d+$/, 'the registered localhost address, any port')
		const code = 'code-' + crypto.randomBytes(6).toString('hex')
		codes.set(code, { challenge: q.get('code_challenge'), redirect: q.get('redirect_uri'), scope: q.get('scope').split(' ') })
		const back = new URL(q.get('redirect_uri').replace('localhost', '127.0.0.1') + '/')
		back.searchParams.set('code', code)
		back.searchParams.set('state', q.get('state'))
		await globalThis.fetch(back)
	}
	return { fetch, browser, folder, graph, marks, seen, refresh }
}

module.exports = { microsoft, EP }
if (require.main === module) (async () => {
	const ms = microsoft()
	const clientId = '00000000-0000-4000-8000-000000000001'
	assert.throws(() => drives.connectMicrosoft({ clientId: '', fetch: ms.fetch, openBrowser: () => {} }), /no Microsoft client id/)
	const urls = []
	const login = await drives.connectMicrosoft({ clientId, fetch: ms.fetch, openBrowser: ms.browser(urls), endpoints: EP })
	assert.equal(new URL(urls[0]).searchParams.get('scope'), 'offline_access Files.ReadWrite.AppFolder', 'only the app folder at first')
	assert.equal(login.calendar, false)
	ok('login: PKCE, state, http://localhost, the app folder only')

	let kept = login.refreshToken
	let calendarOn = false
	const known = new Set()
	const store = drives.onedriveStore({ clientId, refreshToken: login.refreshToken, fetch: ms.fetch, endpoints: EP, onRotate: (t) => { kept = t }, calendar: () => calendarOn, known: { has: (x) => known.has(x), add: (x) => known.add(x), remove: (x) => known.delete(x) } })
	assert.deepEqual(await store.list(), [])
	assert.notEqual(kept, login.refreshToken, 'the new refresh token kept')
	assert.ok(ms.refresh.has(kept))
	const cursor = await store.changeCursor()
	await store.write('blockwise.json', new TextEncoder().encode('{"v":1}'), { create: true })
	await assert.rejects(store.write('blockwise.json', new Uint8Array([1]), { create: true }), (e) => e.exists === true, 'made by another device first')
	assert.equal(new TextDecoder().decode(await store.read('blockwise.json')), '{"v":1}')
	assert.equal(await store.read('nope.json'), null)
	await store.write('blockwise.json', new TextEncoder().encode('{"v":2}'))
	assert.equal(new TextDecoder().decode(await store.read('blockwise.json')), '{"v":2}')
	assert.deepEqual(await store.list(), ['blockwise.json'])
	assert.equal(await store.account(), 'bdrive-1')
	let w = await store.waitForChanges(cursor, { interval: 0 })
	assert.equal(w.changed, true, 'a change seen')
	assert.equal((await store.waitForChanges(w.cursor, { interval: 0 })).changed, false, 'and then none')
	await store.remove('blockwise.json')
	assert.equal(await store.read('blockwise.json'), null)
	await assert.rejects(store.read('../x'), /Invalid file name/)
	ok('the app folder: list, read (from the download link, without the login), write, made once, remove, watch')

	// Outlook: not before it's allowed
	await assert.rejects(store.calendar('POST', 'me/calendars', { name: 'X' }), (e) => e.status === 400)
	const urls2 = []
	const again = await drives.connectMicrosoft({ clientId, fetch: ms.fetch, openBrowser: ms.browser(urls2), endpoints: EP, calendar: true })
	assert.match(new URL(urls2[0]).searchParams.get('scope'), /Calendars\.ReadWrite/)
	assert.equal(again.calendar, true)
	calendarOn = true
	const cal = drives.onedriveStore({ clientId, refreshToken: again.refreshToken, fetch: ms.fetch, endpoints: EP, calendar: () => calendarOn, known: { has: (x) => known.has(x), add: (x) => known.add(x), remove: (x) => known.delete(x) } })
	const cc = createCloudCalendar({ provider: 'microsoft', request: (m, p, b) => cal.calendar(m, p, b) })
	const url = await cc.createCalendar({ name: 'Thesis', color: '#3b6fd8' })
	const id = cc.calOf(url)
	assert.equal(ms.marks.get(id).value, 'blockwise', 'marked as Blockwise\'s')
	assert.ok(known.has(id))
	const day = Math.floor(Date.UTC(2026, 10, 16) / 1000)
	await cc.createEvent({ url, title: 'Write', start: day + 9 * 3600, end: day + 11 * 3600, repeat: 'weekdays' })
	await cc.flush()
	assert.equal(ms.graph.events(id).length, 1, 'in Outlook')
	ok('Outlook: asked for when switched on; a marked calendar per commitment; blocks there')

	// Another device: the mark is looked up once
	known.clear()
	const other = createCloudCalendar({ provider: 'microsoft', request: (m, p, b) => cal.calendar(m, p, b) })
	await other.events(day, day + 7 * 86400, [url])
	await new Promise((r) => setTimeout(r, 100))
	assert.equal((await other.events(day, day + 7 * 86400, [url])).length, 5)
	assert.ok(known.has(id), 'known after the look')

	// Someone else's calendar (made without Blockwise): refused, read or written
	const theirs = (await ms.graph.request('POST', 'me/calendars', { name: 'Private', color: 'auto' })).id
	await ms.graph.request('POST', `me/calendars/${encodeURIComponent(theirs)}/events`, { subject: 'Doctor', start: { dateTime: '2026-11-16T08:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-16T09:00:00', timeZone: 'UTC' } })
	const enc = encodeURIComponent(theirs)
	await assert.rejects(cal.calendar('GET', `me/calendars/${enc}/calendarView?startDateTime=2026-11-16T00:00:00Z&endDateTime=2026-11-23T00:00:00Z&$top=500&$select=id,subject`), (e) => e.status === 403)
	await assert.rejects(cal.calendar('POST', `me/calendars/${enc}/events`, { subject: 'x' }), (e) => e.status === 403)
	await assert.rejects(cal.calendar('DELETE', `me/calendars/${enc}`), (e) => e.status === 403)
	assert.ok(ms.graph.cals.has(theirs), 'untouched')
	for (const [m, p] of [['GET', 'me/calendars'], ['GET', 'me/messages'], ['POST', 'me/sendMail'], ['GET', 'me/events'], ['POST', `me/calendars/${encodeURIComponent(id)}/events/x/forward`], ['GET', `me/calendars/${encodeURIComponent(id)}/events`], ['GET', 'me/drive/root/children']]) {
		await assert.rejects(cal.calendar(m, p), (e) => e.status === 400, `${m} ${p}`)
	}
	ok('other calendars, mail and files: refused')

	// Only a title, times and a repeat: no attendees (nothing is ever sent to anyone)
	ms.seen.bodies.length = 0
	await cal.calendar('POST', `me/calendars/${encodeURIComponent(id)}/events`, { subject: 'Hi', start: { dateTime: '2026-11-17T09:00:00', timeZone: 'UTC', extra: 1 }, end: { dateTime: '2026-11-17T10:00:00', timeZone: 'UTC' }, attendees: [{ emailAddress: { address: 'a@example.com' } }], body: { content: 'x' }, isOnlineMeeting: true })
	assert.deepEqual(Object.keys(ms.seen.bodies[0]).sort(), ['end', 'start', 'subject'])
	assert.deepEqual(ms.seen.bodies[0].start, { dateTime: '2026-11-17T09:00:00', timeZone: 'UTC' })
	await cal.calendar('POST', 'me/calendars', { name: 'Gym', color: 'lightGreen', owner: 'x', singleValueExtendedProperties: [{ id: 'fake', value: 'x' }] })
	assert.deepEqual(ms.seen.bodies[1].singleValueExtendedProperties, [{ id: EP.mark, value: 'blockwise' }], 'only the app sets the mark')
	assert.ok(!('owner' in ms.seen.bodies[1]))
	ok('events carry a title, times and a repeat only; only the app marks calendars')
	console.log('onedrive tests passed')
	process.exit(0)
})().catch((e) => { console.error('✘', e); process.exit(1) })
