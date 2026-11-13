// The Android app's page (app.html, setup.html) in Chromium at phone size, with a
// stand-in for the Java bridge: the engine's data in memory (the app keeps it
// encrypted), sync requests forwarded to the test Nextcloud, no phone calendars
// (so blocks come from the server), and an "offline" switch.
const { chromium } = require('playwright')
const path = require('node:path')
const assert = require('node:assert/strict')
const SERVER = 'http://localhost:8080'
const AUTH = 'Basic ' + Buffer.from('admin:admin-test-pw-123').toString('base64')
const ASSETS = path.join(__dirname, '..', 'app/src/main/assets')
const shots = process.env.SHOTS || '/tmp/claude-0/android'
require('node:fs').mkdirSync(shots, { recursive: true })

// What the app sends after loading: dark mode and bar sizes
const THEME = (dark) => ({ dark, insets: { top: 32, bottom: 24, left: 0, right: 0 } })

const device = { db: null, snapshot: null, offline: false, remoteCalls: [] }
const GUARD = /^(sync\?since=\d{1,18}&limit=\d{1,5}|state|blocks\?from=\d{1,12}&to=\d{1,12})$/ // = core ApiGuard

/** On phone A (its own page): add a commitment and wait until it is on the drive */
async function a2b(dev, name) {
	const n = folder.size
	const p = await phone(sharedBrowser, 'app.html', { mode: 'dropbox', dev, hash: '#now' })
	await p.page.waitForSelector('.imp-page', { timeout: 15000 })
	await p.page.evaluate((name) => window.trackerApp.api('POST', 'commitments', { name, color: '#0fa37f' }), name)
	for (let i = 0; i < 100 && folder.size === n; i++) await p.page.waitForTimeout(100)
	await p.ctx.close()
}
let sharedBrowser = null

// A stand-in Dropbox folder (what the app's Drives.Folder does), shared by the phones
const folder = new Map()
let folderVersion = 0
const folderWaits = new Set()
const folderChanged = () => { folderVersion++; for (const w of [...folderWaits]) w() }

async function phone(browser, file, { dark = false, locale = 'en-US', hash = '', mode = 'nextcloud', dev = device, resend = false, connecting = false, theme = true } = {}) {
	const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, colorScheme: dark ? 'dark' : 'light', locale })
	const page = await ctx.newPage()
	const errors = []
	page.on('pageerror', (e) => errors.push(e.message))
	page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
	const calls = []
	await page.exposeFunction('__native', async (id, channel, argsJson) => {
		const args = JSON.parse(argsJson)
		calls.push(channel)
		let env
		try {
			if (channel === 'state') env = { data: { platform: 'android', locale, mode, connecting, drives: { dropbox: true, gdrive: false } } }
			else if (channel === 'connectDrive') env = { data: folder.has('blockwise.json') }
			else if (channel === 'saveDrive') { dev.key = args[0]; env = { data: null } }
			else if (channel === 'driveKey') env = { data: dev.key || null }
			else if (channel === 'driveStateLoad') env = { data: dev.driveState || null }
			else if (channel === 'driveStateSave') { dev.driveState = args[0]; env = { data: null } }
			else if (channel === 'drive') {
				const [op, name, b64, create] = args
				if (name && !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$/.test(name)) throw new Error('Invalid file name')
				if (op === 'list') env = { data: [...folder.keys()] }
				else if (op === 'read') env = { data: folder.has(name) ? folder.get(name) : null }
				else if (op === 'write') { if (create && folder.has(name)) env = { error: 'exists', status: 409 }; else { folder.set(name, b64); folderChanged(); env = { data: null } } }
				else if (op === 'remove') { folder.delete(name); folderChanged(); env = { data: null } }
			} else if (channel === 'driveWatch') {
				// Like Dropbox's long poll: answers at the next change (or after a while)
				dev.watchCalls = (dev.watchCalls || 0) + 1
				const [op, cursor] = args
				if (op === 'cursor') env = { data: 'v' + folderVersion }
				else if (Number(String(cursor).slice(1)) < folderVersion) env = { data: { changed: true, cursor: 'v' + folderVersion, retryAfter: 0 } }
				else {
					const changed = await new Promise((resolve) => { const w = () => { folderWaits.delete(w); clearTimeout(t); resolve(true) }; const t = setTimeout(() => { folderWaits.delete(w); resolve(false) }, 3000); folderWaits.add(w) })
					env = { data: { changed, cursor: 'v' + folderVersion, retryAfter: 0 } }
				}
			}
			else if (channel === 'dbLoad') env = { data: dev.db }
			else if (channel === 'dbSave') { dev.db = args[0]; env = { data: null } }
			else if (channel === 'snapshot') { dev.snapshot = args[0]; env = { data: null } }
			else if (channel === 'takeResend') { env = { data: resend }; resend = false }
			else if (channel === 'outbox' || channel === 'calendars' || channel === 'events') env = { data: [] }
			else if (channel === 'calendarAccess') env = { data: false }
			else if (channel === 'createEvent') env = { error: 'This commitment\'s calendar is not on this phone. Turn it on in DAVx5.', status: 0 }
			else if (channel === 'remote') {
				const [method, p, body] = args
				dev.remoteCalls.push(`${method} ${p}`)
				if (mode === 'local') throw new Error('no server on this phone only')
				if (!(method === 'GET' ? GUARD.test(p) : method === 'POST' && p === 'sync')) throw new Error('refused by ApiGuard: ' + method + ' ' + p)
				if (dev.offline) throw new Error('offline')
				if (dev.slow) await new Promise((r) => setTimeout(r, dev.slow))
				const r = await fetch(`${SERVER}/index.php/apps/tracker/api/${p}`, { method, headers: { Authorization: AUTH, 'OCS-APIRequest': 'true', 'Content-Type': 'application/json' }, body: body === null ? undefined : JSON.stringify(body) })
				const d = await r.json().catch(() => null)
				env = r.ok ? { data: d } : { error: (d && d.message) || `HTTP ${r.status}`, status: r.status }
			} else env = { data: null }
		} catch (e) { env = { error: e.message } }
		await page.evaluate(([i, e]) => window.__trackerAndroid.resolve(i, e), [id, JSON.stringify(env)])
	})
	await page.addInitScript(() => { window.TrackerAndroid = { call: (id, ch, a) => { window.__native(id, ch, a) } } })
	await page.goto('file://' + path.join(ASSETS, file) + hash)
	if (theme) await page.evaluate((t) => window.__trackerAndroidTheme(t), THEME(dark))
	return { page, errors, calls, ctx }
}

;(async () => {
	const browser = await chromium.launch()
	sharedBrowser = browser
	const s = await phone(browser, 'setup.html', { mode: null })
	await s.page.waitForSelector('#choose:not([hidden])')
	assert.match(await s.page.textContent('#local'), /Start on this phone/)
	await s.page.screenshot({ path: `${shots}/setup.png` })
	await s.page.click('#nextcloud')
	assert.match(await s.page.textContent('#intro'), /stored encrypted on this phone/)
	await s.page.screenshot({ path: `${shots}/setup-nextcloud.png` })
	await s.page.click('#back')
	await s.page.click('#local')
	await s.page.waitForTimeout(200)
	assert.ok(s.calls.includes('useLocal'), 'start on this phone')
	const sc = await phone(browser, 'setup.html', { mode: 'local', connecting: true, hash: '#connect' })
	await sc.page.waitForSelector('#choose:not([hidden])')
	assert.ok(await sc.page.locator('#local').isHidden(), 'already on this phone: only the syncs')
	await sc.page.click('#nextcloud')
	assert.match(await sc.page.textContent('#intro'), /go along to Nextcloud/)
	await sc.page.click('#back')
	await sc.page.click('#choose-back')
	await sc.page.waitForTimeout(200)
	assert.ok(sc.calls.includes('backToApp'))
	console.log('setup ok')

	// Dropbox: allow in the browser, choose a passphrase; two phones sync through the encrypted folder
	{
		const devA = { db: null, snapshot: null, offline: false, remoteCalls: [] }
		const d = await phone(browser, 'setup.html', { mode: null, dev: devA })
		await d.page.waitForSelector('#dropbox:not([hidden])')
		assert.ok(await d.page.locator('#gdrive').isHidden(), 'a drive without app keys is not offered')
		await d.page.click('#dropbox')
		await d.page.waitForSelector('#pass:not([hidden])')
		assert.match(await d.page.textContent('#title'), /Choose a passphrase/)
		await d.page.fill('#pass1', 'correct horse battery')
		await d.page.fill('#pass2', 'correct horse batter')
		await d.page.click('#pass-submit')
		assert.match(await d.page.textContent('#pass-error'), /not the same/)
		await d.page.fill('#pass2', 'correct horse battery')
		await d.page.screenshot({ path: `${shots}/setup-passphrase.png` })
		await d.page.click('#pass-submit')
		await d.page.waitForFunction(() => true)
		for (let i = 0; i < 100 && !devA.key; i++) await d.page.waitForTimeout(100)
		assert.ok(devA.key && folder.has('blockwise.json'), 'folder set up, key kept by the app')
		assert.ok(!/correct horse/.test(atob(folder.get('blockwise.json'))), 'no passphrase on the drive')
		await d.ctx.close()

		const a = await phone(browser, 'app.html', { mode: 'dropbox', dev: devA, hash: '#now' })
		await a.page.waitForSelector('.imp-page', { timeout: 15000 })
		const name = 'Drive sync ' + Date.now()
		await a.page.evaluate(async (name) => {
			const api = window.trackerApp.api
			const c = await api('POST', 'commitments', { name, color: '#e8590c' })
			const now = Math.floor(Date.now() / 1000)
			await api('POST', 'blocks', { commitmentId: c.id, start: now + 3600, end: now + 7200, repeat: 'weekly' })
		}, name)
		for (let i = 0; i < 80 && ![...folder.keys()].some((k) => k.startsWith('log-')); i++) await a.page.waitForTimeout(100)
		const logs = [...folder.keys()].filter((k) => k.startsWith('log-'))
		assert.ok(logs.length, 'changes written to the drive')
		assert.ok(!logs.some((k) => atob(folder.get(k)).includes(name)), 'encrypted: the drive never sees the name')
		assert.deepEqual(devA.remoteCalls, [], 'nothing sent to a server')
		await a.ctx.close()

		// Another phone with the same passphrase
		const devB = { db: null, snapshot: null, offline: false, remoteCalls: [] }
		const s2 = await phone(browser, 'setup.html', { mode: null, dev: devB })
		await s2.page.waitForSelector('#dropbox:not([hidden])')
		await s2.page.click('#dropbox')
		await s2.page.waitForSelector('#pass:not([hidden])')
		assert.match(await s2.page.textContent('#title'), /Enter your passphrase/)
		assert.ok(await s2.page.locator('#pass2-box').isHidden())
		await s2.page.fill('#pass1', 'wrong passphrase')
		await s2.page.click('#pass-submit')
		await s2.page.waitForSelector('#pass-error:not([hidden])', { timeout: 15000 })
		assert.match(await s2.page.textContent('#pass-error'), /Wrong passphrase/)
		await s2.page.fill('#pass1', 'correct horse battery')
		await s2.page.click('#pass-submit')
		for (let i = 0; i < 100 && !devB.key; i++) await s2.page.waitForTimeout(100)
		assert.equal(devB.key, devA.key, 'same key from the same passphrase')
		await s2.ctx.close()
		const b = await phone(browser, 'app.html', { mode: 'dropbox', dev: devB, hash: '#now' })
		await b.page.waitForSelector('.imp-page', { timeout: 15000 })
		await b.page.waitForFunction((name) => [...document.querySelectorAll('.imp-ring__name')].some((x) => x.textContent.includes(name)), name, { timeout: 15000 })
		// Both phones open: what one adds shows on the other within moments (no waiting for the 3-minute round)
		const a2 = await phone(browser, 'app.html', { mode: 'dropbox', dev: devA, hash: '#now' })
		await a2.page.waitForSelector('.imp-page', { timeout: 15000 })
		await b.page.waitForTimeout(1500)
		const t0 = Date.now()
		await a2.page.evaluate(() => window.trackerApp.api('POST', 'commitments', { name: 'Live one', color: '#0fa37f' }))
		await b.page.waitForFunction(() => [...document.querySelectorAll('.imp-ring__name')].some((x) => x.textContent.includes('Live one')), null, { timeout: 15000 })
		assert.ok(Date.now() - t0 < 10000, `arrived in ${Date.now() - t0} ms`)
		assert.ok(devB.watchCalls > 0, 'the open app watches the drive')
		await a2.ctx.close()
		const blocks = await b.page.evaluate(async () => { const now = Math.floor(Date.now() / 1000); return (await window.trackerApp.api('GET', `blocks?from=${now}&to=${now + 86400 * 8}`)).blocks })
		assert.equal(blocks.length, 2, 'the weekly block came along (built-in calendar)')
		await b.page.screenshot({ path: `${shots}/drive-second-phone.png` })
		assert.deepEqual(b.errors, [])
		await b.ctx.close()
		// The background sync page (BackgroundSync.java): one round, saved, the notification's snapshot, done
		{
			const before = JSON.parse(devB.db)
			await a2b(devA, 'Background one')
			const bg = await phone(browser, 'sync.html', { mode: 'dropbox', dev: devB, theme: false })
			for (let i = 0; i < 100 && !bg.calls.includes('bgDone'); i++) await bg.page.waitForTimeout(100)
			assert.ok(bg.calls.includes('bgDone'), 'done')
			assert.ok(JSON.stringify(JSON.parse(devB.db).records).includes('Background one') || Object.values(JSON.parse(devB.db).records.commitment).some((r) => r.f.name === 'Background one'), 'pulled and saved')
			assert.ok(devB.snapshot && devB.snapshot.commitments.some((c) => c.name === 'Background one'), 'the notification knows')
			assert.ok(!bg.calls.includes('driveWatch') || bg.calls.filter((c) => c === 'driveWatch').length === 0, 'no watching in the background')
			assert.ok(!bg.calls.includes('calendarAccess'))
			assert.ok(before)
			await bg.ctx.close()
		}
		console.log('  ✔ Dropbox: passphrase, encrypted folder, a second phone gets everything; background sync')
	}

	// Without encryption, when chosen: a warning, no passphrase; the next phone isn't asked for one
	{
		folder.clear()
		const devC = { db: null, snapshot: null, offline: false, remoteCalls: [] }
		const c = await phone(browser, 'setup.html', { mode: null, dev: devC })
		await c.page.waitForSelector('#dropbox:not([hidden])')
		await c.page.click('#dropbox')
		await c.page.waitForSelector('#pass:not([hidden])')
		await c.page.click('#no-encrypt')
		await c.page.waitForSelector('#plain:not([hidden])')
		assert.match(await c.page.textContent('#plain-warning'), /can read your commitments/)
		await c.page.screenshot({ path: `${shots}/setup-plain.png` })
		await c.page.click('#plain-go')
		for (let i = 0; i < 50 && !devC.key; i++) await c.page.waitForTimeout(100)
		assert.equal(atob(devC.key), 'BLOCKWISE-UNENCRYPTED-FOLDER-V01')
		assert.equal(JSON.parse(atob(folder.get('blockwise.json'))).encryption, 'none')
		await c.ctx.close()
		const a = await phone(browser, 'app.html', { mode: 'dropbox', dev: devC, hash: '#now' })
		await a.page.waitForSelector('.imp-page', { timeout: 15000 })
		await a.page.evaluate(() => window.trackerApp.api('POST', 'commitments', { name: 'Open book', color: '#0fa37f' }))
		for (let i = 0; i < 80 && ![...folder.keys()].some((k) => k.startsWith('log-')); i++) await a.page.waitForTimeout(100)
		assert.ok([...folder.keys()].filter((k) => k.startsWith('log-')).some((k) => atob(folder.get(k)).includes('Open book')), 'plain JSON on the drive')
		await a.ctx.close()
		const devD = { db: null, snapshot: null, offline: false, remoteCalls: [] }
		const d2 = await phone(browser, 'setup.html', { mode: null, dev: devD })
		await d2.page.waitForSelector('#dropbox:not([hidden])')
		await d2.page.click('#dropbox')
		for (let i = 0; i < 50 && !devD.key; i++) await d2.page.waitForTimeout(100)
		assert.equal(devD.key, devC.key, 'joined without a passphrase')
		assert.ok(await d2.page.locator('#pass').isHidden())
		await d2.ctx.close()
		folder.clear()
		console.log('  ✔ without encryption: a warning first, no passphrase, the next phone just joins')
	}

	// On this phone only: no server, the built-in calendar; then Nextcloud, and the data comes along
	{
		const dev = { db: null, snapshot: null, offline: false, remoteCalls: [] }
		const l = await phone(browser, 'app.html', { mode: 'local', dev, hash: '#now' })
		await l.page.waitForSelector('.imp-page', { timeout: 15000 })
		const name = 'Phone only ' + Date.now()
		const c = await l.page.evaluate(async (name) => {
			const api = window.trackerApp.api
			const c = await api('POST', 'commitments', { name, color: '#0fa37f' })
			const now = Math.floor(Date.now() / 1000)
			await api('POST', 'blocks', { commitmentId: c.id, start: now - 600, end: now + 3000 })
			await api('POST', 'tasks', { commitmentId: c.id, title: 'Read 20m' })
			return c
		}, name)
		assert.equal((await l.page.evaluate(() => window.trackerApp.api('GET', 'state'))).features.builtinCalendar, true)
		await l.page.waitForFunction(() => true)
		await l.page.waitForTimeout(800)
		assert.ok(dev.snapshot && dev.snapshot.blocks.some((b) => b.commitmentId === c.id), 'the notification gets the built-in blocks')
		assert.deepEqual(dev.remoteCalls, [], 'nothing sent anywhere')
		assert.ok(!l.calls.includes('calendarAccess'), 'no calendar permission asked')
		await l.page.screenshot({ path: `${shots}/local-now.png` })
		await l.ctx.close()
		const n = await phone(browser, 'app.html', { mode: 'nextcloud', dev, resend: true, hash: '#tasks' })
		// The first sync with a server can take a while (the app waits up to 20 s for it)
		await n.page.waitForSelector('.imp-ptasks .imp-tcol', { timeout: 30000 })
		await n.page.waitForTimeout(1500)
		const r = await fetch(`${SERVER}/index.php/apps/tracker/api/sync?since=0&limit=5000`, { headers: { Authorization: AUTH, 'OCS-APIRequest': 'true' } })
		const recs = (await r.json()).records
		assert.ok(recs.some((x) => x.type === 'commitment' && x.id === c.uuid && x.fields?.name === name), 'the commitment reached Nextcloud')
		assert.ok(recs.some((x) => x.type === 'task' && x.fields?.title === 'Read' && x.fields?.commitment === c.uuid), 'its task too')
		assert.ok(!recs.some((x) => x.type === 'block'), 'built-in blocks stay on the phone')
		await n.page.evaluate((id) => window.trackerApp.api('DELETE', 'commitments/' + id), c.id)
		await n.page.waitForTimeout(4000)
		await n.ctx.close()
		console.log('  ✔ on this phone only, then Nextcloud: the data comes along')
	}

	for (const [dark, locale] of [[false, 'en-US'], [true, 'en-US'], [false, 'it-IT'], [true, 'it-IT']]) {
		const a = await phone(browser, 'app.html', { dark, locale, hash: '#now' })
		await a.page.waitForSelector('.imp-page', { timeout: 15000 })
		const tag = `${dark ? 'dark' : 'light'}-${locale.slice(0, 2)}`
		await a.page.waitForSelector('.imp-ring__name', { timeout: 15000 })
		const firstC = await a.page.evaluate(() => document.querySelector('.imp-ring__name')?.getAttribute('href')?.slice(1))
		for (const pg of ['now', 'tasks', 'done', 'time', 'settings', firstC]) {
			await a.page.evaluate((h) => { location.hash = h }, '#' + pg)
			// wait until the page has loaded (some make several requests)
			await a.page.waitForFunction((pg) => {
				const q = (s) => !!document.querySelector(s)
				return pg === 'now' ? q('.imp-pnow .imp-timer') && q('.imp-ptoday h2') && !q('.imp-ptoday [aria-busy]')
					: pg === 'tasks' ? q('.imp-ptasks .imp-tcol')
						: pg === 'done' ? q('.imp-pdone .imp-pdays')
							: pg === 'time' ? q('.imp-ptime .imp-pweeks')
								: pg === 'settings' ? q('.imp-psettings .imp-settings__section')
									: q('.imp-pcommit .imp-ptabs')
			}, pg, { timeout: 15000 })
			await a.page.waitForTimeout(400)
			const info = await a.page.evaluate(() => {
				const m = document.querySelector('.imp-main')
				const tabs = document.querySelector('.imp-tabbar').getBoundingClientRect()
				return { overflow: document.documentElement.scrollWidth - innerWidth, tabsBottom: Math.round(tabs.bottom), h: innerHeight, tabs: document.querySelectorAll('.imp-tabbar a').length, top: document.querySelectorAll('.imp-pbar__me, .imp-pbar__back').length, failed: !!document.querySelector('.imp-empty')?.textContent.includes('could not be loaded') }
			})
			assert.ok(info.overflow <= 1, `no sideways scroll on ${pg} (${info.overflow})`)
			assert.equal(info.tabsBottom, info.h, 'tab bar at the bottom')
			assert.equal(info.tabs, 5, 'Now, Tasks, Calendar, Done, Time')
			assert.equal(info.top, 1, 'Settings (or Back) at the top')
			assert.ok(!info.failed, `page ${pg} loads`)
			if (!dark || pg === 'now' || pg === 'tasks' || pg === 'notes') await a.page.screenshot({ path: `${shots}/${tag}-${pg.replace('/', '')}.png` })
		}
		if (tag === 'light-en') {
			// Notes: on the commitment's page
			await a.page.click('.imp-ptabs button:has-text("Notes")')
			await a.page.waitForSelector('button#imp-note-new')
			await a.page.click('button#imp-note-new')
			const pn = 'Phone note ' + Date.now()
			await a.page.fill('textarea#imp-note-new', '## ' + pn + '\n\n**Bold** and *italic*\n- [ ] first\n- [x] second')
			await a.page.screenshot({ path: `${shots}/${tag}-notes-editor.png` })
			await a.page.click('.imp-ned__foot .imp-button--primary')
			await a.page.waitForSelector(`.imp-note .imp-md__h2:has-text("${pn}")`)
			assert.match(await a.page.locator(`.imp-note:has-text("${pn}") .imp-note__progress`).innerText(), /1 of 2/)
			await a.page.screenshot({ path: `${shots}/${tag}-notes-added.png` })
			if (await a.page.locator('.imp-ned').count()) await a.page.click('.imp-ned__foot .imp-button:not(.imp-button--primary)')
			await a.page.locator(`.imp-note:has-text("${pn}") .imp-note__tick`).check()
			await a.page.waitForSelector('.imp-notes__ticked')
			const note = await a.page.evaluate(async (pn) => (await window.trackerApp.api('GET', 'notes')).find((n) => n.text.includes(pn)), pn)
			assert.ok(note && note.done, 'note ticked on the phone')
			await a.page.evaluate((id) => window.trackerApp.api('DELETE', 'notes/' + id), note.id)
		}
		// The commitment's overview: planning a block
		await a.page.click('.imp-ptabs button >> nth=2')
		await a.page.waitForSelector('.imp-pcommit .imp-cpage')
		assert.ok(await a.page.$('.imp-newblock button'), 'Plan a block on the commitment page')
		await a.page.click('.imp-newblock button')
		await a.page.locator('.imp-newblock').scrollIntoViewIfNeeded()
		await a.page.screenshot({ path: `${shots}/${tag}-newblock.png` })
		await a.page.click('.imp-newblock__form button[type=submit]')
		await a.page.waitForTimeout(400)
		// The form stays open (the calendar isn't on this phone) unless a sync redrew the page meanwhile
		if (await a.page.$('.imp-newblock__actions button[type=button]')) await a.page.click('.imp-newblock__actions button[type=button]')
		// Account (in Settings) and Calendar (a tab) reach the app
		await a.page.evaluate(() => { location.hash = '#settings' })
		await a.page.click('.imp-paccount')
		await a.page.click('.imp-tabbar a[href="#calendar"]')
		await a.page.waitForTimeout(300)
		assert.ok(a.calls.includes('account') && a.calls.includes('openCalendar'), 'account/calendar calls')
		assert.deepEqual(a.errors, [], 'no console errors')
		console.log(tag, 'ok')
		await a.ctx.close()
	}
	// Everything came from the phone's engine; the server only saw sync requests
	assert.ok(device.remoteCalls.every((c) => /^(GET sync|POST sync|GET state|GET blocks)/.test(c)), 'only sync endpoints')
	assert.ok(device.snapshot && Array.isArray(device.snapshot.commitments) && device.snapshot.node, 'snapshot for the notifications')

	// A slow Nextcloud: tabs switch at once, the parts that wait for it show placeholders and fill in
	{
		device.slow = 2500
		const sl = await phone(browser, 'app.html', { hash: '#now' })
		await sl.page.waitForSelector('.imp-pnow .imp-timer', { timeout: 30000 })
		const t0 = Date.now()
		await sl.page.evaluate(() => { location.hash = '#done' })
		await sl.page.waitForSelector('.imp-tabbar a.active[href="#done"]', { timeout: 5000 })
		const switched = Date.now() - t0
		assert.ok(switched < 800, `the tab switched in ${switched} ms`)
		await sl.page.waitForSelector('.imp-updating:not([hidden])', { timeout: 5000 })
		await sl.page.waitForSelector('.imp-updating[hidden]', { state: 'attached', timeout: 15000 })
		// A day not seen yet: its blocks wait for Nextcloud (placeholders), then show
		await sl.page.evaluate(() => { location.hash = '#now' })
		await sl.page.waitForSelector('.imp-pnow .imp-ptoday', { timeout: 5000 })
		await sl.page.waitForFunction(() => !document.querySelector('.imp-ptoday [aria-busy]'), null, { timeout: 15000 })
		assert.deepEqual(sl.errors, [], 'no console errors')
		await sl.ctx.close()
		device.slow = 0
		console.log(`  ✔ slow Nextcloud: the tab switched in ${switched} ms, placeholders until the answer`)
	}

	console.log('offline')
	device.offline = true
	const o = await phone(browser, 'app.html', { hash: '#tasks' })
	await o.page.waitForSelector('.imp-ptasks .imp-tcol', { timeout: 15000 })
	const before = JSON.parse(device.db)
	const pendingBefore = Object.keys(before.dirty).length
	// a task added offline, in the composer at the bottom
	const title = 'Offline task ' + Date.now()
	await o.page.click('.imp-tq__composer, .imp-compose, [class*="compose"] >> nth=0').catch(() => {})
	const added = await o.page.evaluate(async (title) => {
		const st = await window.trackerApp.api('GET', 'state')
		return window.trackerApp.api('POST', 'tasks', { commitmentId: st.commitments[0].id, title: title + ' 20m' })
	}, title)
	assert.equal(added.estimate, 20)
	await o.page.waitForTimeout(600)
	assert.ok(Object.keys(JSON.parse(device.db).dirty).length > pendingBefore, 'change saved on the phone, waiting to sync')
	assert.deepEqual(o.errors.filter((e) => !/offline/.test(e)), [], 'no console errors offline')
	await o.ctx.close()
	console.log('  ✔ works offline from the phone\'s data')

	device.offline = false
	const back = await phone(browser, 'app.html', { hash: '#tasks' })
	await back.page.waitForSelector('.imp-ptasks .imp-tcol', { timeout: 15000 })
	await back.page.waitForFunction(() => true)
	await back.page.waitForTimeout(1500)
	const r = await fetch(`${SERVER}/index.php/apps/tracker/api/sync?since=0&limit=1000`, { headers: { Authorization: AUTH, 'OCS-APIRequest': 'true' } })
	const all = (await r.json()).records
	const onServer = all.find((x) => x.type === 'task' && x.id === added.uuid)
	assert.ok(onServer && onServer.fields.title === title, 'the offline task reached the server when back online')
	assert.equal(Object.keys(JSON.parse(device.db).dirty).length, 0, 'nothing left to sync')
	await back.page.evaluate((id) => window.trackerApp.api('DELETE', 'tasks/' + id), added.id)
	await back.page.waitForTimeout(4500)
	// Idle with the app open: no more requests (a sync must not schedule the next one)
	const idleFrom = device.remoteCalls.length
	await back.page.waitForTimeout(8000)
	assert.deepEqual(device.remoteCalls.slice(idleFrom).filter((c) => /sync/.test(c)), [], 'no syncing while idle')
	await back.ctx.close()
	console.log('  ✔ synced when back online')

	await browser.close()
	console.log('✔ android ui ok')
})().catch((e) => { console.error('✘', e.message); process.exit(1) })
