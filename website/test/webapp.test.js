// The web app (app/) in a real browser, served as a static site: first run in
// this browser only, the data encrypted in IndexedDB, the account sheet, one
// tab at a time, and two browsers syncing through a stand-in Dropbox
// (login with PKCE and state, a passphrase, end-to-end encrypted files).
// node build.js && node test/webapp.test.js   (Playwright from ../mac)
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const { chromium } = require(require.resolve('playwright', { paths: [path.join(__dirname, '../../mac')] }))
const ok = (n) => console.log('  ✔', n)
const ROOT = path.resolve(__dirname, '..')
const SHOTS = path.join(__dirname, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' }

/**
 * The website as a static host serves it. pretty: as Cloudflare Pages and
 * Netlify do ("pretty URLs"): /app/setup.html redirects to /app/setup, which
 * serves setup.html.
 */
function serve(pretty) {
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, 'http://x')
		const p = decodeURIComponent(url.pathname)
		if (pretty && p.endsWith('.html')) { res.writeHead(308, { Location: p.replace(/(index)?\.html$/, '') + url.search }).end(); return }
		let f = path.join(ROOT, p)
		if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return }
		if (p.endsWith('/')) f = path.join(f, 'index.html')
		else if (pretty && !path.extname(f)) f += '.html'
		fs.readFile(f, (err, data) => {
			if (err) { res.writeHead(404).end(); return }
			res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' })
			res.end(data)
		})
	})
	return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)))
}

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const APP_KEY = 'webtestkey12'

/** A stand-in Dropbox, answered inside the browser's requests (CORS as Dropbox does it) */
function dropbox() {
	const codes = new Map()
	const refresh = new Set()
	const access = new Set()
	const files = new Map()
	let version = 0
	const seen = { tokenBodies: [], authorize: [] }
	const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Dropbox-API-Arg', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Expose-Headers': 'Dropbox-API-Result' }
	async function handle(route) {
		const req = route.request()
		const url = new URL(req.url())
		const json = (status, o) => route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(o) })
		if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
		if (url.host === 'www.dropbox.com' && url.pathname === '/oauth2/authorize') {
			const q = url.searchParams
			seen.authorize.push(Object.fromEntries(q))
			assert.equal(q.get('client_id'), APP_KEY)
			assert.equal(q.get('code_challenge_method'), 'S256')
			assert.equal(q.get('token_access_type'), 'offline')
			const code = 'code-' + crypto.randomBytes(6).toString('hex')
			codes.set(code, { challenge: q.get('code_challenge'), redirect: q.get('redirect_uri') })
			return route.fulfill({ status: 302, headers: { Location: `${q.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(q.get('state'))}` } })
		}
		const auth = /^Bearer (.+)$/.exec(req.headers().authorization || '')
		const authed = auth && access.has(auth[1])
		const body = req.postDataBuffer() || Buffer.alloc(0)
		const p = url.host + url.pathname
		if (p === 'api.dropboxapi.com/oauth2/token') {
			const f = Object.fromEntries(new URLSearchParams(body.toString()))
			seen.tokenBodies.push(f)
			if (f.client_secret) return json(400, { error: 'no secret expected' })
			if (f.grant_type === 'authorization_code') {
				const c = codes.get(f.code)
				codes.delete(f.code)
				if (!c || c.redirect !== f.redirect_uri || b64url(crypto.createHash('sha256').update(f.code_verifier || '').digest()) !== c.challenge) return json(400, { error: 'invalid_grant' })
				const r = 'ref-' + crypto.randomBytes(8).toString('hex')
				refresh.add(r)
				const a = 'acc-' + crypto.randomBytes(8).toString('hex')
				access.add(a)
				return json(200, { access_token: a, refresh_token: r, expires_in: 14400, account_id: 'dbid:AAAweb' })
			}
			if (f.grant_type === 'refresh_token' && refresh.has(f.refresh_token)) {
				const a = 'acc-' + crypto.randomBytes(8).toString('hex')
				access.add(a)
				return json(200, { access_token: a, expires_in: 14400 })
			}
			return json(400, { error: 'invalid_grant' })
		}
		if (p === 'notify.dropboxapi.com/2/files/list_folder/longpoll') {
			const { cursor } = JSON.parse(body.toString())
			// Answers at once with "changed" when behind, else after a moment "no change"
			if (Number(String(cursor).slice(1)) < version) return json(200, { changes: true })
			await new Promise((r) => setTimeout(r, 300))
			return json(200, { changes: Number(String(cursor).slice(1)) < version })
		}
		if (!authed) return json(401, { error: 'expired_access_token' })
		const arg = () => JSON.parse(req.headers()['dropbox-api-arg'] || '{}')
		const name = (pth) => String(pth).replace(/^\//, '')
		switch (p) {
			case 'api.dropboxapi.com/2/files/list_folder':
				return json(200, { entries: [...files.keys()].map((n) => ({ '.tag': 'file', name: n })), has_more: false, cursor: 'c' })
			case 'api.dropboxapi.com/2/files/list_folder/get_latest_cursor':
				return json(200, { cursor: 'v' + version })
			case 'api.dropboxapi.com/2/files/delete_v2': {
				const n = name(JSON.parse(body.toString()).path)
				if (!files.delete(n)) return json(409, { error: 'not_found' })
				version++
				return json(200, {})
			}
			case 'api.dropboxapi.com/2/auth/token/revoke':
				access.delete(auth[1])
				return json(200, {})
			case 'content.dropboxapi.com/2/files/download': {
				const n = name(arg().path)
				if (!files.has(n)) return json(409, { error: 'path/not_found' })
				return route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/octet-stream' }, body: files.get(n) })
			}
			case 'content.dropboxapi.com/2/files/upload': {
				const a = arg()
				const n = name(a.path)
				if (a.mode === 'add' && files.has(n)) return json(409, { error: 'path/conflict' })
				files.set(n, Buffer.from(body))
				version++
				return json(200, { name: n })
			}
		}
		return json(404, { error: 'unknown ' + p })
	}
	return { handle, files, seen }
}

async function suite(pretty) {
	console.log(pretty ? 'With pretty URLs (/app/setup.html → /app/setup):' : 'Plain static host:')
	const server = await serve(pretty)
	const base = `http://127.0.0.1:${server.address().port}/app/`
	const browser = await chromium.launch()
	const errors = []
	const open = async (ctx) => {
		const page = await ctx.newPage()
		page.on('pageerror', (e) => errors.push(e.message))
		page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
		return page
	}
	try {
		// --- only in this browser --------------------------------------------------------
		const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US' })
		const a = await open(ctxA)
		await a.goto(base)
		await a.waitForURL(/\/setup(\.html)?$/)
		await a.locator('#local').waitFor({ state: 'visible' })
		assert.equal(await a.locator('#local').textContent(), 'Start in this browser')
		assert.equal(await a.locator('#nextcloud').isHidden(), true, 'no Nextcloud in the browser')
		assert.equal(await a.locator('#drives').isHidden(), true, 'no drive without an app key')
		ok('first run: start in this browser; no Nextcloud, no drive without an app key')

		await a.click('#local')
		await a.waitForURL(/\/app\/#now$/)
		await a.locator('.imp-nav__main').waitFor()
		const tabs = await a.locator('.imp-nav__main > li').allTextContents()
		assert.ok(tabs.some((t) => /Account/.test(t)), 'an Account tab: ' + tabs.join('|'))
		assert.equal(await a.locator('body.desktop.web').count(), 1)
		ok('the app, in the desktop layout, with an Account tab')

		const made = await a.evaluate(() => window.trackerApp.api('POST', 'commitments', { name: 'Thesis', color: '#3b6fd8' }))
		assert.ok(made.id)
		await a.evaluate(() => window.trackerApp.api('GET', 'state').then((s) => s.commitments))
		// Saved encrypted: nothing readable in IndexedDB
		await new Promise((r) => setTimeout(r, 1500)) // the engine saves after a moment
		const stored = await a.evaluate(() => new Promise((resolve) => {
			const r = indexedDB.open('blockwise')
			r.onsuccess = () => {
				const t = r.result.transaction('kv').objectStore('kv')
				const all = t.getAll()
				const keys = t.getAllKeys()
				all.onsuccess = () => keys.onsuccess = () => resolve({ keys: keys.result, values: all.result.map((v) => (v && v.data ? new TextDecoder('latin1').decode(v.data) : typeof v === 'object' ? '[key]' : String(v))) })
			}
		}))
		const stored2 = await a.evaluate(() => new Promise((resolve) => {
			const r = indexedDB.open('blockwise')
			r.onsuccess = () => {
				const all = r.result.transaction('kv').objectStore('kv').getAll()
				all.onsuccess = () => resolve(all.result.map((v) => (v && v.data ? new TextDecoder('latin1').decode(v.data) : '')).join(''))
			}
		}))
		assert.ok(stored.keys.includes('key') && stored.keys.includes('v:db'), 'stored: ' + stored.keys)
		assert.ok(!/Thesis/.test(stored2), 'the data is encrypted in IndexedDB')
		const keyInfo = await a.evaluate(() => new Promise((resolve) => {
			const r = indexedDB.open('blockwise')
			r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('key'); g.onsuccess = () => resolve({ type: g.result.type, extractable: g.result.extractable }) }
		}))
		assert.deepEqual(keyInfo, { type: 'secret', extractable: false })
		ok('saved in IndexedDB, encrypted with a key the page can\'t read out')

		await a.reload()
		await a.locator('.imp-nav__main').waitFor()
		const after = await a.evaluate(() => window.trackerApp.api('GET', 'state').then((s) => s.commitments))
		assert.deepEqual(after.map((c) => c.name), ['Thesis'])
		ok('still there after a reload')

		// A second tab: kept out of the data
		const a2 = await open(ctxA)
		await a2.goto(base)
		await a2.getByText('Blockwise is open in another tab').waitFor()
		await a2.close()
		ok('a second tab says so instead of overwriting the first')

		// The account sheet leads to Settings → Your data
		await a.locator('.imp-nav__main a', { hasText: 'Account' }).click()
		await a.locator('dialog.w-sheet').waitFor()
		assert.match(await a.locator('dialog.w-sheet h2').textContent(), /Only in this browser/)
		await a.screenshot({ path: path.join(SHOTS, 'account.png') }).catch(() => {})
		await a.getByText('Back up or import your data').click()
		await a.locator('.imp-backup').waitFor()
		assert.match(a.url(), /#settings$/)
		ok('the account sheet: to the backup in Settings')

		// A backup, encrypted: nothing readable in the file
		await a.evaluate(() => window.trackerApp.api('GET', 'state').then((s) => window.trackerApp.api('POST', 'tasks', { commitmentId: s.commitments[0].id, title: 'Chapter 3', subtasks: ['Draft 45m'] })))
		const sec = a.locator('.imp-backup')
		await sec.locator('input[type="password"]').nth(0).fill('correct horse battery')
		await sec.locator('input[type="password"]').nth(1).fill('correct horse batterz')
		await sec.getByRole('button', { name: 'Export', exact: true }).click()
		await a.getByText('The two passphrases are not the same.').waitFor()
		await sec.locator('input[type="password"]').nth(1).fill('correct horse battery')
		const [dl] = await Promise.all([a.waitForEvent('download'), sec.getByRole('button', { name: 'Export', exact: true }).click()])
		const sealedText = fs.readFileSync(await dl.path(), 'utf8')
		assert.match(dl.suggestedFilename(), /^Blockwise-\d{4}-\d{2}-\d{2}-encrypted\.json$/)
		const sealed = JSON.parse(sealedText)
		assert.equal(sealed.format, 'blockwise-backup')
		assert.equal(sealed.encrypted.cipher, 'AES-256-GCM')
		assert.ok(!sealed.records && !/Thesis|Chapter/.test(sealedText), 'nothing readable in an encrypted backup')
		// Not encrypted: the records as sync sends them
		await sec.locator('#imp-backup-enc').uncheck()
		const [dl2] = await Promise.all([a.waitForEvent('download'), sec.getByRole('button', { name: 'Export', exact: true }).click()])
		const plain = JSON.parse(fs.readFileSync(await dl2.path(), 'utf8'))
		assert.ok(plain.records.some((r) => r.type === 'commitment' && r.fields.name === 'Thesis'))
		assert.ok(plain.records.some((r) => r.type === 'task' && r.fields.title === 'Chapter 3'))
		ok('backup: encrypted (nothing readable) or plain, after checking the passphrase')

		// Worked without pressing play: the last hour, added on the Done page
		await a.evaluate(() => { location.hash = '#done' })
		await a.getByRole('button', { name: '+ Add tracked time' }).click()
		const panel = a.getByRole('dialog', { name: 'Add tracked time' })
		await panel.locator('select').selectOption({ label: 'Thesis' })
		await panel.getByRole('button', { name: 'Add', exact: true }).click()
		await a.getByText('Tracked time added').waitFor()
		const added = await a.evaluate(() => window.trackerApp.api('GET', `sessions?from=${Math.floor(Date.now() / 1000) - 7200}&to=${Math.floor(Date.now() / 1000)}`))
		assert.equal(added.length, 1)
		assert.equal(added[0].end - added[0].start, 3600)
		await a.getByRole('button', { name: '+ Add tracked time' }).click()
		await a.getByRole('dialog', { name: 'Add tracked time' }).getByRole('button', { name: 'Add', exact: true }).click()
		await a.getByText('This overlaps time you tracked already').waitFor()
		await a.keyboard.press('Escape')
		ok('done page: an hour you forgot to track is added, the same hour again is refused')

		// Into a fresh browser: a wrong passphrase is refused, the right one brings everything back
		const ctxR = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US', acceptDownloads: true })
		const r = await open(ctxR)
		await r.goto(base)
		await r.click('#local')
		await r.locator('.imp-nav__main').waitFor()
		await r.goto(base + '#settings')
		await r.locator('.imp-backup').waitFor()
		const pick = async () => {
			const [chooser] = await Promise.all([r.waitForEvent('filechooser'), r.getByRole('button', { name: 'Import a backup…' }).click()])
			await chooser.setFiles({ name: 'Blockwise-encrypted.json', mimeType: 'application/json', buffer: Buffer.from(sealedText) })
		}
		await pick()
		// (the export form has passphrase fields too: wait for the import's)
		await r.locator('.imp-backup .imp-backup__form input[autocomplete="current-password"]').waitFor()
		await r.locator('.imp-backup input[type="password"]').fill('wrong passphrase')
		await r.getByRole('button', { name: 'Open' }).click()
		await r.getByText('Wrong passphrase, or the file was changed.').waitFor()
		await r.locator('.imp-backup input[type="password"]').fill('correct horse battery')
		await r.getByRole('button', { name: 'Open' }).click()
		await r.getByText(/Import from Blockwise-encrypted\.json: 1 commitment, 1 task, 1 subtask/).waitFor()
		await r.locator('.imp-backup').getByRole('button', { name: 'Import', exact: true }).click()
		await r.getByText(/Imported \d+ items\./).waitFor()
		const restored = await r.evaluate(async () => {
			const st = await window.trackerApp.api('GET', 'state')
			const tasks = await window.trackerApp.api('GET', 'tasks')
			return { commitments: st.commitments.map((c) => c.name), tasks: (Array.isArray(tasks) ? tasks : tasks.tasks).map((t) => t.title) }
		})
		assert.deepEqual(restored, { commitments: ['Thesis'], tasks: ['Chapter 3'] })
		// Something that isn't a backup
		const [chooser2] = await Promise.all([r.waitForEvent('filechooser'), r.getByRole('button', { name: 'Import a backup…' }).click()])
		await chooser2.setFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') })
		await r.getByText('This is not a Blockwise backup.').waitFor()
		await r.screenshot({ path: path.join(SHOTS, 'backup.png') }).catch(() => {})
		await ctxR.close()
		ok('import: a wrong passphrase refused, the right one brings everything back; other files refused')
		await a.screenshot({ path: path.join(SHOTS, 'now.png') }).catch(() => {})
		await ctxA.close()

		// --- syncing through Dropbox ---------------------------------------------------------
		const box = dropbox()
		const withDropbox = async () => {
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US' })
			await ctx.route(/^https:\/\/(www\.dropbox\.com|[a-z]+\.dropboxapi\.com)\//, box.handle)
			await ctx.route(/\/app\/providers\.js$/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: `window.__blockwiseProviders = Object.freeze({"dropboxAppKey":"${APP_KEY}"})` }))
			return ctx
		}
		const ctxB = await withDropbox()
		const b = await open(ctxB)
		await b.goto(base)
		await b.locator('#dropbox').waitFor({ state: 'visible' })
		assert.equal(await b.locator('#gdrive').isHidden(), true)
		await b.click('#dropbox')
		// To "Dropbox", back with a code: the passphrase
		await b.locator('#pass1').waitFor({ state: 'visible' })
		assert.equal(new URL(b.url()).search, '', 'the code left the address bar')
		assert.equal(box.seen.authorize[0].redirect_uri, base + 'setup.html')
		assert.ok(!box.seen.tokenBodies.some((f) => f.client_secret), 'no app secret')
		await b.fill('#pass1', 'correct horse battery')
		await b.fill('#pass2', 'correct horse battery')
		await b.click('#pass-submit')
		await b.waitForURL(/\/app\/#now$/)
		await b.locator('.imp-nav__main').waitFor()
		await b.evaluate(() => window.trackerApp.api('POST', 'commitments', { name: 'Garden', color: '#2f9e44' }))
		// Synced soon after the change
		const deadline = Date.now() + 15000
		while (Date.now() < deadline && box.files.size < 2) await new Promise((r) => setTimeout(r, 300))
		const raw = Buffer.concat([...box.files.values()]).toString('latin1')
		assert.ok(box.files.size >= 2, 'files on the drive: ' + [...box.files.keys()])
		assert.ok(!/Garden/.test(raw), 'end-to-end encrypted on the drive')
		ok('Dropbox: PKCE login with state, no secret, a passphrase, encrypted files')

		// Another browser: the same Dropbox, the same passphrase, the same data
		const ctxC = await withDropbox()
		const c = await open(ctxC)
		await c.goto(base)
		await c.locator('#dropbox').waitFor({ state: 'visible' })
		await c.click('#dropbox')
		await c.locator('#pass1').waitFor({ state: 'visible' })
		assert.equal(await c.locator('#pass2-box').isHidden(), true, 'joining: the passphrase once')
		await c.fill('#pass1', 'wrong passphrase!')
		await c.click('#pass-submit')
		await c.locator('#pass-error').waitFor({ state: 'visible' })
		await c.fill('#pass1', 'correct horse battery')
		await c.click('#pass-submit')
		await c.waitForURL(/\/app\/#now$/)
		await c.locator('.imp-nav__main').waitFor()
		const names = await c.evaluate(() => window.trackerApp.api('GET', 'state').then((s) => s.commitments).then((l) => l.map((x) => x.name)))
		assert.deepEqual(names, ['Garden'])
		ok('another browser joins with the passphrase (a wrong one is refused) and gets the data')

		// A change in one browser reaches the other while both are open
		await c.evaluate(() => window.trackerApp.api('POST', 'commitments', { name: 'Piano', color: '#1971c2' }))
		const until = Date.now() + 25000
		let seenB = []
		while (Date.now() < until) {
			seenB = await b.evaluate(() => window.trackerApp.api('GET', 'state').then((s) => s.commitments).then((l) => l.map((x) => x.name)))
			if (seenB.includes('Piano')) break
			await new Promise((r) => setTimeout(r, 500))
		}
		assert.ok(seenB.includes('Piano'), 'reached the other browser: ' + seenB)
		ok('a change in one browser shows up in the other (watching the drive)')

		// Stop syncing: keeps the data here, forgets the drive
		await b.locator('.imp-nav__main a', { hasText: 'Account' }).click()
		await b.locator('dialog.w-sheet').waitFor()
		assert.match(await b.locator('dialog.w-sheet h2').textContent(), /Synced with Dropbox/)
		await b.getByRole('button', { name: 'Stop syncing' }).click()
		await Promise.all([b.waitForEvent('load'), b.getByRole('button', { name: 'Stop, keep my data here' }).click()])
		await b.locator('.imp-nav__main').waitFor()
		const kept = await b.evaluate(() => window.trackerApp.api('GET', 'state').then((s) => s.commitments).then((l) => l.map((x) => x.name)))
		assert.ok(kept.includes('Garden'))
		const st = await b.evaluate(() => window.trackerApp.getState())
		assert.equal(st.mode, 'local')
		ok('stop syncing: the data stays in this browser, the drive is forgotten')

		// A code this tab didn't ask for (a link from someone else): refused, nothing exchanged
		const ctxD = await withDropbox()
		const d = await open(ctxD)
		const before = box.seen.tokenBodies.length
		await d.goto(base + 'setup.html?code=forged&state=forged')
		await d.locator('#choose-error').waitFor({ state: 'visible' })
		assert.match(await d.locator('#choose-error').textContent(), /not started here/)
		assert.equal(box.seen.tokenBodies.length, before)
		assert.equal(new URL(d.url()).search, '')
		ok('a login this tab didn\'t start is refused')

		await ctxB.close()
		await ctxC.close()
		await ctxD.close()
		assert.deepEqual(errors, [], 'no errors in the pages')
		ok('no errors in the pages')
	} finally {
		await browser.close()
		server.close()
	}
}

;(async () => {
	await suite(false)
	await suite(true)
})().catch((e) => { console.error(e); process.exit(1) })
