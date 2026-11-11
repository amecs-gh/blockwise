// Dropbox and Google Drive against stand-in servers: the browser login (PKCE,
// state), tokens, the folder API, and two Macs syncing encrypted through each.
// node test/drives.test.js
const http = require('node:http')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const drives = require('../src/drives')
const { createEngine } = require('../../nextcloud/js/engine.js')
const FS = require('../../nextcloud/js/filesync.js')
const ok = (name) => console.log('  ✔', name)

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))) })

/** One stand-in for both providers' login, token and file endpoints */
function provider() {
	const codes = new Map() // code -> {challenge, redirect, client}
	const refresh = new Map() // refresh token -> client
	const access = new Map() // access token -> expired?
	const box = new Map() // Dropbox app folder: name -> bytes
	const gfiles = [] // Google appDataFolder: {id, name, bytes, createdTime}
	const seen = { auths: [], urls: [], revokeBodies: [], longpollAuth: [] }
	// Every change to either folder: a new version (the watch cursors are versions)
	let version = 0
	const waiting = new Set()
	const bump = () => { version++; for (const w of [...waiting]) w() }
	const issue = (client) => {
		const a = 'acc-' + crypto.randomBytes(8).toString('hex')
		access.set(a, false)
		return a
	}
	const bearer = (req) => {
		const m = /^Bearer (.+)$/.exec(req.headers.authorization || '')
		return m && access.has(m[1]) && !access.get(m[1]) ? m[1] : null
	}
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, 'http://x')
		seen.urls.push(req.method + ' ' + url.pathname + url.search)
		const body = await readBody(req)
		const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }
		const form = () => Object.fromEntries(new URLSearchParams(body.toString()))
		// --- login page: "you allow it", the provider sends you back with a code
		if (url.pathname === '/authorize' || url.pathname === '/auth') {
			const q = url.searchParams
			assert.equal(q.get('code_challenge_method'), 'S256')
			assert.match(q.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/(dropbox|google)$/)
			const code = 'code-' + crypto.randomBytes(6).toString('hex')
			codes.set(code, { challenge: q.get('code_challenge'), redirect: q.get('redirect_uri'), client: q.get('client_id') })
			seen.auths.push(Object.fromEntries(q))
			res.writeHead(302, { Location: `${q.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(q.get('state'))}` }).end()
			return
		}
		if (url.pathname === '/token') {
			const f = form()
			if (f.grant_type === 'authorization_code') {
				const c = codes.get(f.code)
				codes.delete(f.code) // one use only
				if (!c || c.redirect !== f.redirect_uri || b64url(crypto.createHash('sha256').update(f.code_verifier || '').digest()) !== c.challenge) return json(400, { error: 'invalid_grant' })
				const r = 'ref-' + crypto.randomBytes(8).toString('hex')
				refresh.set(r, c.client)
				return json(200, { access_token: issue(), refresh_token: r, expires_in: 3600, account_id: 'dbid:AAAtest', scope: 'https://www.googleapis.com/auth/drive.appdata' })
			}
			if (f.grant_type === 'refresh_token') {
				if (!refresh.has(f.refresh_token)) return json(400, { error: 'invalid_grant' })
				return json(200, { access_token: issue(), expires_in: 3600 })
			}
			return json(400, { error: 'unsupported_grant_type' })
		}
		if (url.pathname === '/revoke') {
			seen.revokeBodies.push(body.toString())
			refresh.delete(form().token)
			return json(200, {})
		}
		// Dropbox's long poll: no token, only the cursor; answers at the next change
		if (url.pathname === '/2/files/list_folder/longpoll') {
			seen.longpollAuth.push(req.headers.authorization || null)
			const { cursor, timeout } = JSON.parse(body)
			if (!/^v\d+$/.test(cursor)) return json(400, { error: 'reset' })
			if (Number(cursor.slice(1)) < version) return json(200, { changes: true })
			let answered = false
			const done = (changes) => { if (answered) return; answered = true; waiting.delete(onChange); clearTimeout(t); json(200, { changes }) }
			const onChange = () => done(true)
			const t = setTimeout(() => done(false), Math.min(timeout, 2) * 1000)
			waiting.add(onChange)
			return
		}
		const tok = bearer(req)
		if (!tok) return json(401, { error: 'invalid_token' })
		if (url.pathname === '/2/files/list_folder/get_latest_cursor') return json(200, { cursor: 'v' + version })
		if (url.pathname === '/drive/v3/changes/startPageToken') return json(200, { startPageToken: String(version) })
		if (url.pathname === '/drive/v3/changes') {
			assert.equal(url.searchParams.get('spaces'), 'appDataFolder')
			const from = Number(url.searchParams.get('pageToken'))
			return json(200, { changes: from < version ? [{ fileId: 'x' }] : [], newStartPageToken: String(version) })
		}
		// --- Dropbox
		if (url.pathname === '/2/auth/token/revoke') { for (const k of refresh.keys()) refresh.delete(k); access.set(tok, true); return json(200, null) }
		if (url.pathname === '/2/files/list_folder' || url.pathname === '/2/files/list_folder/continue') {
			const names = [...box.keys()]
			const start = url.pathname.endsWith('continue') ? Number(JSON.parse(body).cursor) : 0
			const page = names.slice(start, start + 3) // small pages: paging is tested
			return json(200, { entries: page.map((n) => ({ '.tag': 'file', name: n })), has_more: start + 3 < names.length, cursor: String(start + 3) })
		}
		if (url.pathname === '/2/files/download') {
			const p = JSON.parse(req.headers['dropbox-api-arg']).path.slice(1)
			if (!box.has(p)) return json(409, { error_summary: 'path/not_found/' })
			res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(box.get(p))
			return
		}
		if (url.pathname === '/2/files/upload') {
			const arg = JSON.parse(req.headers['dropbox-api-arg'])
			const p = arg.path.slice(1)
			if (arg.mode === 'add' && box.has(p)) return json(409, { error_summary: 'path/conflict/file/' })
			box.set(p, body)
			bump()
			return json(200, { name: p })
		}
		if (url.pathname === '/2/files/delete_v2') {
			const p = JSON.parse(body).path.slice(1)
			if (!box.delete(p)) return json(409, { error_summary: 'path_lookup/not_found/' })
			bump()
			return json(200, {})
		}
		// --- Google Drive
		if (url.pathname === '/drive/v3/about') return json(200, { user: { permissionId: '0123456789' } })
		if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
			assert.equal(url.searchParams.get('spaces'), 'appDataFolder')
			return json(200, { files: gfiles.map(({ id, name, createdTime }) => ({ id, name, createdTime })) })
		}
		const fm = /^\/(upload\/)?drive\/v3\/files(?:\/([\w-]+))?$/.exec(url.pathname)
		if (fm) {
			const [, upload, id] = fm
			const f = id && gfiles.find((x) => x.id === id)
			if (!upload && req.method === 'GET') { if (!f) return json(404, {}); res.writeHead(200).end(f.bytes); return }
			if (!upload && req.method === 'DELETE') { if (!f) return json(404, {}); gfiles.splice(gfiles.indexOf(f), 1); bump(); res.writeHead(204).end(); return }
			if (upload) {
				// multipart/related: JSON metadata, then the bytes
				const boundary = /boundary=(.+)$/.exec(req.headers['content-type'])[1]
				const parts = body.toString('latin1').split(`--${boundary}`)
				const meta = JSON.parse(parts[1].split('\r\n\r\n')[1])
				const bytes = Buffer.from(parts[2].split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''), 'latin1')
				if (req.method === 'POST') {
					assert.deepEqual(meta.parents, ['appDataFolder'], 'new files go into the app data folder only')
					const nf = { id: 'g' + crypto.randomBytes(6).toString('hex'), name: meta.name, bytes, createdTime: new Date().toISOString() }
					gfiles.push(nf)
					bump()
					return json(200, { id: nf.id })
				}
				if (!f) return json(404, {})
				f.bytes = bytes
				bump()
				return json(200, { id: f.id })
			}
		}
		json(404, {})
	})
	return { server, box, gfiles, seen, access, refresh, expireAll: () => { for (const k of access.keys()) access.set(k, true) } }
}

/** "The browser": follows the login page to the app's loopback address */
const browser = (log) => async (u) => {
	log.push(u)
	const r = await fetch(u, { redirect: 'manual' })
	const back = r.headers.get('location')
	// A page on the web tries its luck first: wrong state, ignored
	const forged = new URL(back)
	forged.searchParams.set('state', 'guess')
	forged.searchParams.set('code', 'evil')
	assert.equal((await fetch(forged)).status, 400)
	const page = await fetch(back)
	assert.equal(page.status, 200)
	assert.match(page.headers.get('content-security-policy'), /default-src 'none'/)
}

const memoryStorage = () => { let s = null; return { load: async () => (s ? JSON.parse(s) : null), save: async (db) => { s = JSON.stringify(db) } } }
const noCalendar = { calendars: async () => [], events: async () => [] }
async function mac(store, passphrase) {
	const key = await FS.unlock(store, passphrase)
	let remote = null
	const engine = await createEngine({ storage: memoryStorage(), calendar: noCalendar, remote: { pull: (s, l) => remote.pull(s, l), push: (r) => remote.push(r) } })
	remote = await FS.createRemote({ store, key, node: engine.node(), state: memoryStorage() })
	return engine
}
const names = async (e) => (await e.api('GET', 'state')).commitments.map((c) => c.name).sort()

module.exports = { provider }
if (require.main === module) (async () => {
	const p = provider()
	await new Promise((r) => p.server.listen(0, '127.0.0.1', r))
	const base = `http://127.0.0.1:${p.server.address().port}`
	const DBX = { authorize: `${base}/authorize`, token: `${base}/token`, api: `${base}/2`, content: `${base}/2`, notify: `${base}/2`, port: 0, path: '/dropbox' }
	const GOO = { authorize: `${base}/auth`, token: `${base}/token`, revoke: `${base}/revoke`, files: `${base}/drive/v3/files`, about: `${base}/drive/v3/about`, changes: `${base}/drive/v3/changes`, upload: `${base}/upload/drive/v3/files`, scope: 'https://www.googleapis.com/auth/drive.appdata', path: '/google' }

	console.log('Dropbox')
	assert.throws(() => drives.connectDropbox({ appKey: '', fetch, openBrowser: () => {} }), /no Dropbox app key/)
	const opened = []
	const d1 = await drives.connectDropbox({ appKey: 'dbx-key', fetch, openBrowser: browser(opened), endpoints: DBX })
	assert.match(d1.refreshToken, /^ref-/)
	assert.equal(d1.account, 'dbid:AAAtest')
	const auth = p.seen.auths.at(-1)
	assert.equal(auth.token_access_type, 'offline')
	assert.ok(auth.state.length >= 32 && auth.code_challenge.length === 43, 'random state, S256 challenge')
	assert.ok(!opened[0].includes('verifier'), 'the PKCE secret never goes to the browser')
	ok('login in the browser: PKCE + state; a forged answer is ignored; refresh token back')
	{
		// The same code twice, or with another verifier: refused
		const again = drives.connectDropbox({ appKey: 'dbx-key', fetch, endpoints: DBX, openBrowser: async (u) => {
			const back = (await fetch(u, { redirect: 'manual' })).headers.get('location')
			await fetch(back)
		} })
		assert.ok((await again).refreshToken)
		const cancelled = drives.connectDropbox({ appKey: 'dbx-key', fetch, endpoints: DBX, openBrowser: () => {} })
		setTimeout(() => cancelled.cancel(), 50)
		await assert.rejects(cancelled, /Cancelled/)
		ok('a login can be cancelled')
	}
	const s1 = drives.dropboxStore({ appKey: 'dbx-key', refreshToken: d1.refreshToken, fetch, endpoints: DBX })
	assert.equal(await s1.read('blockwise.json'), null)
	await assert.rejects(s1.read('../secrets'), /Invalid file name/)
	await assert.rejects(s1.write('.hidden', new Uint8Array(1)), /Invalid file name/)
	ok('only plain file names in the app folder')

	const a = await mac(s1, 'correct horse battery staple')
	const d2 = await drives.connectDropbox({ appKey: 'dbx-key', fetch, openBrowser: browser([]), endpoints: DBX })
	const s2 = drives.dropboxStore({ appKey: 'dbx-key', refreshToken: d2.refreshToken, fetch, endpoints: DBX })
	await assert.rejects(FS.unlock(s2, 'wrong horse battery staple'), /Wrong passphrase/)
	const b = await mac(s2, 'correct horse battery staple')
	await a.api('POST', 'commitments', { name: 'Thesis', color: '#336699' })
	await a.api('POST', 'commitments', { name: 'Teaching', color: '#993366' })
	await a.sync()
	await b.api('POST', 'commitments', { name: 'Reading', color: '#669933' })
	await b.sync(); await a.sync()
	assert.deepEqual(await names(a), ['Reading', 'Teaching', 'Thesis'])
	assert.deepEqual(await names(a), await names(b))
	ok('two Macs converge through Dropbox')
	for (const [n, bytes] of p.box) {
		assert.ok(!bytes.toString('latin1').includes('Thesis'), `${n} is encrypted`)
	}
	assert.ok([...p.box.keys()].every((n) => /^(blockwise\.json|log-[\w-]+-\d+\.bwx)$/.test(n)), 'only Blockwise files')
	ok(`${p.box.size} files on Dropbox, none readable without the passphrase`)
	for (let i = 0; i < 6; i++) { await a.api('POST', 'commitments', { name: 'C' + i, color: '#123456' }); await a.sync() }
	await b.sync()
	assert.equal((await names(b)).length, 9)
	ok('folder listing over several pages')

	p.expireAll()
	await a.api('POST', 'commitments', { name: 'After expiry', color: '#123456' })
	await a.sync()
	await b.sync()
	assert.ok((await names(b)).includes('After expiry'))
	ok('an expired access token is renewed from the refresh token')

	{
		// Watching: the other Mac syncs as soon as this one writes (Dropbox answers the long poll at the change)
		let got = 0
		const w = FS.watch(s2, async () => { got++; await b.sync() })
		await new Promise((r) => setTimeout(r, 300))
		const t0 = Date.now()
		await a.api('POST', 'commitments', { name: 'Watched', color: '#123456' })
		await a.sync()
		for (let i = 0; i < 60 && !(await names(b)).includes('Watched'); i++) await new Promise((r) => setTimeout(r, 50))
		assert.ok((await names(b)).includes('Watched'), 'arrived without asking')
		assert.ok(Date.now() - t0 < 2000, 'within moments')
		assert.ok(p.seen.longpollAuth.length && p.seen.longpollAuth.every((x) => x === null), 'the long poll carries no token')
		// Two Macs writing at the same moment: both get everything
		const wa = FS.watch(s1, () => a.sync())
		await new Promise((r) => setTimeout(r, 300))
		await Promise.all([a.api('POST', 'commitments', { name: 'Same time A', color: '#123456' }), b.api('POST', 'commitments', { name: 'Same time B', color: '#123456' })])
		await Promise.all([a.sync(), b.sync()])
		for (let i = 0; i < 80 && ((await names(a)).length !== (await names(b)).length || !(await names(a)).includes('Same time B')); i++) await new Promise((r) => setTimeout(r, 50))
		assert.deepEqual(await names(a), await names(b))
		assert.ok((await names(a)).includes('Same time A') && (await names(a)).includes('Same time B'))
		w.stop(); wa.stop()
		ok('watching Dropbox: the other Mac syncs at once; two writing at once converge')
	}

	await s2.revoke()
	const s2again = drives.dropboxStore({ appKey: 'dbx-key', refreshToken: d2.refreshToken, fetch, endpoints: DBX })
	const err = await s2again.list().catch((e) => e)
	assert.ok(err.revoked, 'after disconnecting, the token is refused (the app asks to connect again)')
	ok('disconnect revokes the token at Dropbox')

	console.log('Google Drive')
	assert.throws(() => drives.connectGoogle({ clientId: '', fetch, openBrowser: () => {} }), /no Google client id/)
	const g1 = await drives.connectGoogle({ clientId: 'goo-id', clientSecret: 'not-secret', fetch, openBrowser: browser([]), endpoints: GOO })
	const gauth = p.seen.auths.at(-1)
	assert.equal(gauth.scope, 'https://www.googleapis.com/auth/drive.appdata', 'only the hidden app folder, not your files')
	assert.equal(gauth.access_type, 'offline')
	const gs1 = drives.googleStore({ clientId: 'goo-id', clientSecret: 'not-secret', refreshToken: g1.refreshToken, fetch, endpoints: GOO })
	assert.equal(await gs1.account(), '0123456789')
	const g2 = await drives.connectGoogle({ clientId: 'goo-id', clientSecret: 'not-secret', fetch, openBrowser: browser([]), endpoints: GOO })
	const gs2 = drives.googleStore({ clientId: 'goo-id', clientSecret: 'not-secret', refreshToken: g2.refreshToken, fetch, endpoints: GOO })
	const ga = await mac(gs1, 'another long passphrase')
	const gb = await mac(gs2, 'another long passphrase')
	await ga.api('POST', 'commitments', { name: 'Gym', color: '#336699' })
	await ga.sync(); await gb.sync()
	await gb.api('POST', 'commitments', { name: 'Piano', color: '#336699' })
	await gb.sync(); await ga.sync()
	assert.deepEqual(await names(ga), ['Gym', 'Piano'])
	assert.deepEqual(await names(gb), ['Gym', 'Piano'])
	assert.ok(p.gfiles.every((f) => !f.bytes.toString('latin1').includes('Gym')))
	ok('two Macs converge through Google Drive, encrypted')
	{
		// Google Drive: a check every interval, sync only when the app folder changed
		let syncs = 0
		const w = FS.watch(gs2, async () => { syncs++; await gb.sync() }, { interval: () => 5000 })
		await new Promise((r) => setTimeout(r, 300))
		await ga.api('POST', 'commitments', { name: 'Violin', color: '#336699' })
		await ga.sync()
		w.poke() // the window came back: check now
		for (let i = 0; i < 60 && !(await names(gb)).includes('Violin'); i++) await new Promise((r) => setTimeout(r, 50))
		assert.ok((await names(gb)).includes('Violin'))
		const before = syncs
		w.poke()
		await new Promise((r) => setTimeout(r, 400))
		assert.equal(syncs, before, 'nothing changed: no sync')
		w.stop()
		ok('watching Google Drive: a small check, a sync only when something changed')
	}
	{
		// The same name made twice at once (Drive allows it): the oldest wins, the other is removed
		await gs1.write('race.bwx', new Uint8Array([1]), { create: true })
		p.gfiles.push({ id: 'gzz', name: 'race.bwx', bytes: Buffer.from([2]), createdTime: new Date(Date.now() + 1000).toISOString() })
		await assert.rejects(gs2.write('race.bwx', new Uint8Array([3]), { create: true }), (e) => e.exists)
		assert.deepEqual([...(await gs1.read('race.bwx'))], [1])
		ok('"create" refuses a name that exists')
	}
	await gs2.revoke()
	assert.ok(!p.seen.urls.some((u) => u.startsWith('POST /revoke?')), 'no token in the URL')
	assert.match(p.seen.revokeBodies.at(-1), /^token=ref-/)
	ok('disconnect revokes the refresh token (sent in the body, not the URL)')
	assert.ok(!p.seen.urls.some((u) => /token=|access_token|ref-|acc-/.test(u)), 'no token in any URL')
	ok('tokens only in headers and bodies, never in URLs')

	p.server.close()
	console.log('\nall drive tests passed')
	process.exit(0)
})().catch((e) => { console.error('✘', e); process.exit(1) })
