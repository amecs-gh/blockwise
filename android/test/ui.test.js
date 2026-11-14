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
const GUARD_PUT = /^blocks\/\d{1,12}\/\d{1,12}$/
const GUARD_DELETE = /^blocks\/\d{1,12}\/\d{1,12}(\?scope=(this|future|all))?$/
const guarded = (method, p) => method === 'GET' ? GUARD.test(p) : method === 'PUT' ? GUARD_PUT.test(p) : method === 'DELETE' ? GUARD_DELETE.test(p) : method === 'POST' && (p === 'sync' || p === 'blocks')

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
// Google Calendar (the account's calendar with Google Drive), in memory
const gcal = require('../../nextcloud/tests/fake-gcal.js').fakeGoogle()
const graph = require('../../nextcloud/tests/fake-graph.js').fakeGraph()
let folderVersion = 0
const folderWaits = new Set()
const folderChanged = () => { folderVersion++; for (const w of [...folderWaits]) w() }

/** Every page of the server's records (it sends at most 1000 at a time) */
async function serverRecords() {
	const recs = []
	for (let since = 0, more = true; more;) {
		const page = await (await fetch(`${SERVER}/index.php/apps/tracker/api/sync?since=${since}&limit=1000`, { headers: { Authorization: AUTH, 'OCS-APIRequest': 'true' } })).json()
		recs.push(...page.records)
		more = page.more && page.cursor > since
		since = page.cursor
	}
	return recs
}

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
			else if (channel === 'outbox') env = { data: [] }
			// Nextcloud's blocks as last known (the app keeps them encrypted)
			else if (channel === 'blockCacheLoad') env = { data: mode !== 'local' ? dev.blockCache || null : null }
			// Google Calendar through the drive's login (the app's CloudGuard: same requests)
			else if (channel === 'calendarAllowed') env = { data: !!dev.calAllowed }
			else if (channel === 'allowCalendar') { dev.calAllowed = true; env = { data: true } }
			else if (channel === 'cloudCal') {
				if (!dev.calAllowed) env = { error: 'Invalid request.', status: 400 }
				else {
					dev.calCalls = (dev.calCalls || 0) + 1
					try { env = { data: (await (mode === 'onedrive' ? graph : gcal).request(args[0], args[1], args[2] === null ? undefined : args[2])) ?? null } } catch (e) { env = { error: e.message, status: e.status || 0 } }
				}
			}
			else if (channel === 'blockCacheSave') { dev.blockCache = args[0]; env = { data: null } }
			// The phone's calendars (CalendarContract through DAVx5): none, unless a test puts some there
			else if (channel === 'calendars') env = { data: dev.phoneCals || [] }
			else if (channel === 'events') {
				const [from, to, urls] = args
				env = { data: (dev.phoneEvents || []).filter((e) => urls.includes(e.url) && e.end > from && e.start < to)
					.map((e) => ({ uid: `u${e.series}#${e.start}`, title: e.title, start: e.start, end: e.end, url: e.url, series: e.series, occurrence: e.start, repeat: '', until: null })) }
			}
			else if (channel === 'calendarAccess') env = { data: !!dev.phoneCals }
			else if (channel === 'createEvent') {
				const ev = args[0]
				const cal = (dev.phoneCals || []).find((c) => c.url === ev.url)
				if (!cal) env = { error: 'This commitment\'s calendar is not on this phone. Turn it on in DAVx5.', status: 0 }
				else { const series = (dev.nextId = (dev.nextId || 100) + 1); dev.phoneEvents.push({ series, url: ev.url, title: ev.title, start: ev.start, end: ev.end, repeat: ev.repeat }); env = { data: { uid: `u${series}#${ev.start}` } } }
			}
			else if (channel === 'updateEvent') {
				const [series, occ, ch] = args
				const e = (dev.phoneEvents || []).find((x) => x.series === series && x.start === occ)
				if (!e) env = { error: 'This block is gone. Pull to refresh.', status: 0 }
				else { const len = e.end - e.start; Object.assign(e, { start: ch.start ?? e.start, title: ch.title ?? e.title, url: ch.url ?? e.url }); e.end = ch.end ?? e.start + len; env = { data: { ok: true, series, occurrence: e.start } } }
			}
			else if (channel === 'deleteEvent') { dev.phoneEvents = (dev.phoneEvents || []).filter((x) => !(x.series === args[0] && x.start === args[1])); env = { data: { ok: true } } }
			else if (channel === 'otherCalendars') env = { data: dev.phoneCals ? [{ id: 7, name: 'Work', account: 'you@example.com', color: '#8e24aa' }] : [] }
			else if (channel === 'busy') env = { data: args[2].includes(7) ? (dev.busyEvents || []).filter((e) => e.end > args[0] && e.start < args[1]) : [] }
			else if (channel === 'remote') {
				const [method, p, body] = args
				dev.remoteCalls.push(`${method} ${p}`)
				if (mode === 'local') throw new Error('no server on this phone only')
				if (!guarded(method, p)) throw new Error('refused by ApiGuard: ' + method + ' ' + p)
				// (a server that's down: no answer for a while, then the connection fails)
				if (dev.offline) { if (dev.downDelay) await new Promise((r) => setTimeout(r, dev.downDelay)); throw new Error('offline') }
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

		// Google Drive: the same login puts the blocks in Google Calendar, a calendar per commitment
		{
			const g1 = await phone(browser, 'app.html', { mode: 'gdrive', dev: devA, hash: '#settings' })
			g1.page.on('dialog', (d) => d.accept())
			await g1.page.waitForSelector('.imp-paccal input[role=switch]', { timeout: 15000 })
			assert.ok(!(await g1.page.isChecked('.imp-paccal input[role=switch]')), 'off until turned on')
			const builtinBefore = await g1.page.evaluate(async () => { const now = Math.floor(Date.now() / 1000); return (await window.trackerApp.api('GET', `blocks?from=${now}&to=${now + 86400 * 8}`)).blocks.length })
			assert.ok(builtinBefore >= 2, 'built-in blocks to move')
			await g1.page.click('.imp-paccal input[role=switch]')
			await g1.page.waitForFunction(() => document.querySelector('.imp-paccal input[role=switch]')?.checked && !document.querySelector('.imp-paccal input[role=switch]').disabled, null, { timeout: 15000 })
			assert.ok(devA.calAllowed, 'asked for Google Calendar')
			const calIds = [...gcal.cals.keys()]
			const st = await g1.page.evaluate(() => window.trackerApp.api('GET', 'state'))
			assert.equal(st.features.calendarHome, 'google')
			assert.equal(st.features.calendarKind, 'google', 'blocks from Google Calendar now')
			assert.equal(calIds.length, st.commitments.length, 'a calendar per commitment')
			assert.ok(st.commitments.every((c) => c.calendarId !== null), 'each linked to its calendar')
			for (let i = 0; i < 50 && ![...gcal.cals.values()].some((c) => c.events.size); i++) await g1.page.waitForTimeout(100)
			const copied = [...gcal.cals.values()].flatMap((c) => [...c.events.values()])
			assert.ok(copied.some((e) => e.recurrence && e.recurrence[0] === 'RRULE:FREQ=WEEKLY'), 'the weekly block, as a weekly event')
			const inCloud = await g1.page.evaluate(async () => {
				const now = Math.floor(Date.now() / 1000)
				await window.trackerApp.api('GET', `blocks?from=${now}&to=${now + 86400 * 8}`)
				await new Promise((r) => setTimeout(r, 500))
				return (await window.trackerApp.api('GET', `blocks?from=${now}&to=${now + 86400 * 8}`)).blocks.length
			})
			assert.equal(inCloud, builtinBefore, 'the same blocks, now from Google Calendar')
			await g1.page.screenshot({ path: `${shots}/settings-google-calendar.png` })
			// Planned on this phone: it reaches Google Calendar
			const planned = await g1.page.evaluate(async () => {
				const st = await window.trackerApp.api('GET', 'state')
				const now = Math.floor(Date.now() / 1000)
				await window.trackerApp.api('POST', 'blocks', { commitmentId: st.commitments[0].id, title: 'Planned for Google', start: now + 2 * 86400, end: now + 2 * 86400 + 3600 })
				return true
			})
			assert.ok(planned)
			for (let i = 0; i < 50 && !copied.concat([...gcal.cals.values()].flatMap((c) => [...c.events.values()])).some((e) => e.summary === 'Planned for Google'); i++) await g1.page.waitForTimeout(100)
			assert.ok([...gcal.cals.values()].flatMap((c) => [...c.events.values()]).some((e) => e.summary === 'Planned for Google'), 'planned here, in Google Calendar')
			await g1.page.waitForTimeout(3500) // (the change to the setting synced through the drive)
			await g1.ctx.close()

			// The other phone follows: asks to allow Google Calendar there too
			const g2 = await phone(browser, 'app.html', { mode: 'gdrive', dev: devB, hash: '#settings' })
			// (it learns at its first sync: then Calendar asks)
			for (let i = 0; i < 40 && !(await g2.page.evaluate(async () => (await window.trackerApp.accountCalendar()).home === 'google')); i++) await g2.page.waitForTimeout(250)
			await g2.page.evaluate(() => { location.hash = '#calendar' })
			await g2.page.waitForSelector('.imp-paccal__ask button', { timeout: 15000 })
			await g2.page.screenshot({ path: `${shots}/calendar-google-ask.png` })
			await g2.page.click('.imp-paccal__ask button')
			await g2.page.waitForSelector('.imp-pcal .imp-cv__grid', { timeout: 15000 })
			const seen = await g2.page.evaluate(async () => {
				const now = Math.floor(Date.now() / 1000)
				await window.trackerApp.api('GET', `blocks?from=${now}&to=${now + 86400 * 8}`)
				await new Promise((r) => setTimeout(r, 600))
				return (await window.trackerApp.api('GET', `blocks?from=${now}&to=${now + 86400 * 8}`)).blocks.map((b) => b.title)
			})
			assert.ok(seen.includes('Planned for Google'), 'the other phone shows Google Calendar\'s blocks')
			// Offline there: planned anyway, sent when Google answers again
			gcal.setDown(true)
			await g2.page.evaluate(async () => {
				const st = await window.trackerApp.api('GET', 'state')
				const now = Math.floor(Date.now() / 1000)
				await window.trackerApp.api('POST', 'blocks', { commitmentId: st.commitments[0].id, title: 'Offline for Google', start: now + 3 * 86400, end: now + 3 * 86400 + 3600 })
			})
			const shown = await g2.page.evaluate(async () => { const now = Math.floor(Date.now() / 1000); return (await window.trackerApp.api('GET', `blocks?from=${now}&to=${now + 86400 * 8}`)).blocks.map((b) => b.title) })
			assert.ok(shown.includes('Offline for Google'), 'shown at once, offline')
			await g2.page.waitForTimeout(800)
			gcal.setDown(false)
			await g2.page.evaluate(() => window.trackerApp.api('GET', 'state'))
			for (let i = 0; i < 100 && ![...gcal.cals.values()].flatMap((c) => [...c.events.values()]).some((e) => e.summary === 'Offline for Google'); i++) {
				// (a change here: the drive syncs 3 s later, and what waits for the calendar goes with it)
				if (i % 25 === 0) await g2.page.evaluate(() => window.trackerApp.api('PUT', 'settings', {})).catch(() => {})
				await g2.page.waitForTimeout(200)
			}
			assert.ok([...gcal.cals.values()].flatMap((c) => [...c.events.values()]).some((e) => e.summary === 'Offline for Google'), 'reached Google Calendar when back')
			assert.deepEqual(g2.errors, [])
			await g2.ctx.close()

			// Back into Blockwise: Google Calendar's blocks copied in
			const g3 = await phone(browser, 'app.html', { mode: 'gdrive', dev: devA, hash: '#settings' })
			g3.page.on('dialog', (d) => d.accept())
			await g3.page.waitForSelector('.imp-paccal input[role=switch]:checked', { timeout: 15000 })
			await g3.page.click('.imp-paccal input[role=switch]')
			await g3.page.waitForFunction(() => !document.querySelector('.imp-paccal input[role=switch]')?.checked && !document.querySelector('.imp-paccal input[role=switch]').disabled, null, { timeout: 15000 })
			const back = await g3.page.evaluate(async () => {
				const st = await window.trackerApp.api('GET', 'state')
				const now = Math.floor(Date.now() / 1000)
				return { home: st.features.calendarHome, kind: st.features.calendarKind, titles: (await window.trackerApp.api('GET', `blocks?from=${now}&to=${now + 86400 * 8}`)).blocks.map((b) => b.title) }
			})
			assert.equal(back.home, 'builtin')
			assert.equal(back.kind, 'builtin')
			assert.ok(back.titles.includes('Planned for Google') && back.titles.includes('Offline for Google'), 'copied into Blockwise')
			assert.deepEqual(g3.errors, [])
			await g3.ctx.close()
			console.log('  ✔ Google Drive + Google Calendar: moved there, planned there (offline too), another phone follows, and back')
		}

		// OneDrive: the same with Outlook
		{
			devA.calAllowed = false
			const o1 = await phone(browser, 'app.html', { mode: 'onedrive', dev: devA, hash: '#settings' })
			o1.page.on('dialog', (d) => d.accept())
			await o1.page.waitForSelector('.imp-paccal input[role=switch]', { timeout: 15000 })
			assert.match(await o1.page.textContent('.imp-paccal'), /Outlook/, 'named Outlook')
			await o1.page.click('.imp-paccal input[role=switch]')
			await o1.page.waitForFunction(() => document.querySelector('.imp-paccal input[role=switch]')?.checked && !document.querySelector('.imp-paccal input[role=switch]').disabled, null, { timeout: 15000 })
			assert.ok(devA.calAllowed, 'asked for Outlook')
			const st = await o1.page.evaluate(() => window.trackerApp.api('GET', 'state'))
			assert.equal(st.features.calendarHome, 'microsoft')
			assert.equal(graph.cals.size, st.commitments.length, 'a calendar per commitment')
			assert.ok(st.commitments.every((c) => c.calendarId !== null))
			const all = () => [...graph.cals.values()].flatMap((c) => [...c.events.values()])
			for (let i = 0; i < 50 && !all().length; i++) await o1.page.waitForTimeout(100)
			assert.ok(all().some((e) => e.subject === 'Planned for Google'), 'the blocks copied in')
			await o1.page.evaluate(async () => {
				const st = await window.trackerApp.api('GET', 'state')
				const now = Math.floor(Date.now() / 1000)
				await window.trackerApp.api('POST', 'blocks', { commitmentId: st.commitments[0].id, title: 'Planned for Outlook', start: now + 2 * 86400, end: now + 2 * 86400 + 3600 })
			})
			for (let i = 0; i < 50 && !all().some((e) => e.subject === 'Planned for Outlook'); i++) await o1.page.waitForTimeout(100)
			assert.ok(all().some((e) => e.subject === 'Planned for Outlook'), 'planned here, in Outlook')
			const titles = await o1.page.evaluate(async () => {
				const now = Math.floor(Date.now() / 1000)
				await window.trackerApp.api('GET', `blocks?from=${now}&to=${now + 86400 * 8}`)
				await new Promise((r) => setTimeout(r, 600))
				return (await window.trackerApp.api('GET', `blocks?from=${now}&to=${now + 86400 * 8}`)).blocks.map((b) => b.title)
			})
			assert.ok(titles.includes('Planned for Outlook') && titles.includes('Planned for Google'), 'read back from Outlook')
			await o1.page.screenshot({ path: `${shots}/settings-outlook.png` })
			assert.deepEqual(o1.errors, [])
			await o1.ctx.close()
			console.log('  ✔ OneDrive + Outlook: a calendar per commitment, the blocks there, planned there')
		}
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
		// The Calendar tab: the built-in blocks, three days, a tap on a block opens it
		await l.page.evaluate(() => { location.hash = '#calendar' })
		await l.page.waitForSelector('.imp-pcal .imp-cv__ev', { timeout: 15000 })
		assert.equal(await l.page.locator('.imp-pcal .imp-cv__col').count(), 3, 'three days')
		const evBox = await l.page.locator('.imp-pcal .imp-cv__ev').first().boundingBox()
		await l.page.locator('.imp-pcal .imp-cv__ev').first().scrollIntoViewIfNeeded()
		await l.page.locator('.imp-pcal .imp-cv__ev').first().tap()
		await l.page.waitForSelector('.imp-cvpanel--sheet', { timeout: 5000 })
		await l.page.screenshot({ path: `${shots}/local-calendar.png` })
		assert.ok(evBox, 'a block on the calendar')
		await l.ctx.close()
		const n = await phone(browser, 'app.html', { mode: 'nextcloud', dev, resend: true, hash: '#tasks' })
		// The first sync with a server can take a while (the app waits up to 20 s for it)
		await n.page.waitForSelector('.imp-ptasks .imp-tcol', { timeout: 30000 })
		await n.page.waitForTimeout(1500)
		const recs = await serverRecords()
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
		for (const pg of ['now', 'tasks', 'notes', 'progress', 'settings', firstC]) {
			await a.page.evaluate((h) => { location.hash = h }, '#' + pg)
			// wait until the page has loaded (some make several requests)
			await a.page.waitForFunction((pg) => {
				const q = (s) => !!document.querySelector(s)
				return pg === 'now' ? q('.imp-pnow .imp-timer') && q('.imp-ptoday h2') && !q('.imp-ptoday [aria-busy]')
					: pg === 'tasks' ? q('.imp-ptasks .imp-tcol')
						: pg === 'notes' ? q('.imp-ptasks--notes .imp-notes') && location.hash === '#tasks'
							: pg === 'progress' ? q('.imp-pprogress .imp-pdays') && q('.imp-pprogress .imp-pweeks') && q('#imp-pgoals-h')
								: pg === 'settings' ? q('.imp-psettings .imp-settings__section')
									: q('.imp-pcommit .imp-ptabs')
			}, pg, { timeout: 30000 })
			await a.page.waitForTimeout(400)
			const info = await a.page.evaluate(() => {
				const m = document.querySelector('.imp-main')
				const tabs = document.querySelector('.imp-tabbar').getBoundingClientRect()
				return { overflow: document.documentElement.scrollWidth - innerWidth, tabsBottom: Math.round(tabs.bottom), h: innerHeight, tabs: document.querySelectorAll('.imp-tabbar a').length, top: document.querySelectorAll('.imp-pbar__me, .imp-pbar__back').length, failed: !!document.querySelector('.imp-empty')?.textContent.includes('could not be loaded') }
			})
			assert.ok(info.overflow <= 1, `no sideways scroll on ${pg} (${info.overflow})`)
			assert.equal(info.tabsBottom, info.h, 'tab bar at the bottom')
			assert.equal(info.tabs, 4, 'Now, Tasks, Calendar, Progress')
			assert.equal(info.top, 1, 'Settings (or Back) at the top')
			assert.ok(!info.failed, `page ${pg} loads`)
			if (!dark || pg === 'now' || pg === 'tasks' || pg === 'notes' || pg === 'progress') await a.page.screenshot({ path: `${shots}/${tag}-${pg.replace('/', '')}.png`, fullPage: pg === 'progress' })
			// (back to the tasks, for the next round)
			if (pg === 'notes') { await a.page.click('.imp-pseg button >> nth=0'); await a.page.waitForSelector('.imp-ptasks:not(.imp-ptasks--notes) .imp-tcol') }
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
		const ncBlocks = async () => (await (await fetch(`${SERVER}/index.php/apps/tracker/api/blocks?from=${Math.floor(Date.now() / 1000) - 86400}&to=${Math.floor(Date.now() / 1000) + 30 * 86400}`, { headers: { Authorization: AUTH, 'OCS-APIRequest': 'true' } })).json()).blocks
		const beforeUids = new Set((await ncBlocks()).map((b) => b.uid))
		// (a page load or sync finishing just then may redraw the page: then once more)
		for (let i = 0; ; i++) {
			try {
				await a.page.waitForSelector('.imp-updating[hidden]', { state: 'attached', timeout: 15000 }).catch(() => {})
				if (!(await a.page.$('.imp-newblock__form'))) await a.page.click('.imp-newblock button', { timeout: 5000 })
				await a.page.waitForSelector('.imp-newblock__form', { timeout: 4000 })
				await a.page.locator('.imp-newblock').scrollIntoViewIfNeeded({ timeout: 3000 })
				await a.page.screenshot({ path: `${shots}/${tag}-newblock.png` })
				await a.page.click('.imp-newblock__form button[type=submit]', { timeout: 3000 })
				break
			} catch (e) {
				if (i >= 2) throw e
			}
		}
		// Its calendar isn't on this phone: the block goes to Nextcloud (right away when it answers)
		let fresh = []
		for (let i = 0; i < 20 && !fresh.length; i++) {
			await a.page.waitForTimeout(400)
			fresh = (await ncBlocks()).filter((b) => !beforeUids.has(b.uid))
		}
		assert.ok(fresh.length >= 1, 'the planned block reached Nextcloud')
		for (const b of fresh) await fetch(`${SERVER}/index.php/apps/tracker/api/blocks/${b.series}/${b.occurrence}`, { method: 'DELETE', headers: { Authorization: AUTH, 'OCS-APIRequest': 'true' } })
		if (await a.page.$('.imp-newblock__actions button[type=button]')) await a.page.click('.imp-newblock__actions button[type=button]', { timeout: 3000 }).catch(() => {})
		// Account (in Settings) reaches the app; Calendar is the planner, never another app
		await a.page.evaluate(() => { location.hash = '#settings' })
		await a.page.click('.imp-paccount')
		await a.page.click('.imp-tabbar a[href="#calendar"]')
		await a.page.waitForSelector('.imp-pcal .imp-cv__grid', { timeout: 15000 })
		assert.ok(a.calls.includes('account') && !a.calls.includes('openCalendar'), 'account in the app, the planner in Calendar')
		assert.deepEqual(a.errors, [], 'no console errors')
		console.log(tag, 'ok')
		await a.ctx.close()
	}
	// Everything came from the phone's engine; the server only saw sync requests
	assert.ok(device.remoteCalls.every((c) => /^(GET sync|POST sync|GET state|GET blocks|POST blocks)/.test(c)), 'only sync and block endpoints')
	assert.ok(device.snapshot && Array.isArray(device.snapshot.commitments) && device.snapshot.node, 'snapshot for the notifications')

	// A slow Nextcloud: tabs switch at once, the parts that wait for it show placeholders and fill in
	{
		device.slow = 2500
		device.blockCache = null // (a phone that hasn't seen Nextcloud's blocks yet)
		const sl = await phone(browser, 'app.html', { hash: '#now' })
		await sl.page.waitForSelector('.imp-pnow .imp-timer', { timeout: 30000 })
		const t0 = Date.now()
		await sl.page.evaluate(() => { location.hash = '#progress' })
		await sl.page.waitForSelector('.imp-tabbar a.active[href="#progress"]', { timeout: 5000 })
		const switched = Date.now() - t0
		assert.ok(switched < 800, `the tab switched in ${switched} ms`)
		await sl.page.waitForSelector('.imp-updating:not([hidden])', { timeout: 5000 })
		await sl.page.waitForSelector('.imp-updating[hidden]', { state: 'attached', timeout: 15000 })
		// A day not seen yet: its blocks wait for Nextcloud (placeholders), then show
		await sl.page.evaluate(() => { location.hash = '#now' })
		await sl.page.waitForSelector('.imp-pnow .imp-ptoday', { timeout: 5000 })
		await sl.page.waitForFunction(() => !document.querySelector('.imp-ptoday [aria-busy]'), null, { timeout: 15000 })
		// Then quiet: pages that reach "now" don't ask Nextcloud again every second
		await sl.page.waitForSelector('.imp-updating[hidden]', { state: 'attached', timeout: 15000 })
		await sl.page.waitForTimeout(3000)
		const asksFrom = device.remoteCalls.filter((c) => /blocks|state/.test(c)).length
		await sl.page.waitForTimeout(8000)
		const asks = device.remoteCalls.filter((c) => /blocks|state/.test(c)).length - asksFrom
		assert.ok(asks <= 1, `no request storm (${asks} block requests in 8 s)`)
		assert.deepEqual(sl.errors, [], 'no console errors')
		await sl.ctx.close()
		device.slow = 0
		console.log(`  ✔ slow Nextcloud: the tab switched in ${switched} ms, placeholders until the answer`)
	}

	// Blocks in the phone's calendars (Nextcloud through DAVx5): the planner moves and deletes them there;
	// other calendars show as grey busy time when turned on
	{
		const st = await (await fetch(`${SERVER}/index.php/apps/tracker/api/state`, { headers: { Authorization: AUTH, 'OCS-APIRequest': 'true' } })).json()
		const linked = st.commitments.find((c) => c.calendarId)
		const cal = linked && st.calendars.find((c) => c.id === linked.calendarId)
		assert.ok(cal, 'a commitment with a Nextcloud calendar')
		const path = decodeURIComponent(new URL(cal.url, SERVER).pathname)
		const day = new Date(); day.setHours(0, 0, 0, 0)
		const t = (h) => Math.floor(day.getTime() / 1000) + h * 3600
		device.phoneCals = [{ url: path, name: cal.name, color: cal.color, writable: true }]
		device.phoneEvents = [{ series: 42, url: path, title: 'On the phone', start: t(10), end: t(11) }]
		device.busyEvents = [{ title: 'Dentist', start: t(14), end: t(15), calendar: 7 }]
		const pc = await phone(browser, 'app.html', { hash: '#calendar' })
		pc.page.on('dialog', (d) => d.accept())
		await pc.page.waitForSelector('.imp-pcal .imp-cv__ev', { timeout: 15000 })
		assert.equal(await pc.page.locator('.imp-cv__busy').count(), 0, 'no busy time until turned on')
		// Moved by an hour: the event changes in the phone's calendar
		const moved = await pc.page.evaluate(async (t) => {
			const { blocks } = await window.trackerApp.api('GET', `blocks?from=${t.from}&to=${t.to}`)
			const b = blocks.find((x) => x.title === 'On the phone')
			return b && window.trackerApp.api('PUT', `blocks/${b.series}/${b.occurrence}`, { start: b.start + 3600, end: b.end + 3600, scope: 'all' })
		}, { from: t(0), to: t(24) })
		assert.ok(moved && moved.ok && device.phoneEvents[0].start === t(11), 'moved in the phone\'s calendar')
		// Tapped: Edit and Delete, as with the built-in calendar
		await pc.page.evaluate(() => { location.hash = '#now'; setTimeout(() => { location.hash = '#calendar' }, 50) })
		await pc.page.waitForSelector('.imp-pcal .imp-cv__ev', { timeout: 15000 })
		await pc.page.locator('.imp-pcal .imp-cv__ev:has-text("On the phone")').first().tap()
		await pc.page.waitForSelector('.imp-cvpanel button.imp-button--danger', { timeout: 5000 })
		await pc.page.click('.imp-cvpanel button.imp-button--danger')
		await pc.page.waitForFunction(() => ![...document.querySelectorAll('.imp-pcal .imp-cv__ev')].some((e) => e.textContent.includes('On the phone')), null, { timeout: 5000 })
		assert.equal(device.phoneEvents.length, 0, 'deleted from the phone\'s calendar')
		// Settings: other calendars, then Calendar shows them in grey
		await pc.page.evaluate(() => { location.hash = '#settings' })
		await pc.page.click('.imp-pbusy__head input')
		await pc.page.waitForSelector('.imp-pbusy__list input:checked', { timeout: 5000 })
		await pc.page.screenshot({ path: `${shots}/settings-busy.png` })
		await pc.page.evaluate(() => { location.hash = '#calendar' })
		await pc.page.waitForSelector('.imp-cv__busy', { timeout: 15000 })
		assert.match(await pc.page.locator('.imp-cv__busy').first().innerText(), /Dentist/)
		await pc.page.evaluate(() => document.querySelector('.imp-cv__busy').scrollIntoView({ block: 'center' }))
		await pc.page.screenshot({ path: `${shots}/calendar-busy.png` })
		// A sideways swipe: the next three days, then back
		const swipe = async (dx) => {
			const cdp = await pc.page.context().newCDPSession(pc.page)
			const y = 500
			const x0 = dx < 0 ? 330 : 80
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] })
			for (let i = 1; i <= 3; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (dx * i) / 3, y: y + i }] })
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
			await cdp.detach()
		}
		const heading = () => pc.page.locator('.imp-pcal .imp-pbar h1').innerText()
		// (once more if a redraw for new data replaced the grid under the finger)
		const swipeTo = async (dx, ok) => {
			for (let i = 0; i < 3; i++) {
				await pc.page.waitForSelector('.imp-updating[hidden]', { state: 'attached', timeout: 15000 }).catch(() => {})
				await swipe(dx)
				if (await pc.page.waitForFunction(ok, first, { timeout: 5000 }).catch(() => null)) return
			}
			assert.fail(`swiped ${dx}`)
		}
		const first = await heading()
		await swipeTo(-200, (t) => document.querySelector('.imp-pcal .imp-pbar h1')?.innerText !== t)
		await swipeTo(200, (t) => document.querySelector('.imp-pcal .imp-pbar h1')?.innerText === t)
		// No arrows; away from today, Today appears and the title stays on one line
		assert.equal(await pc.page.locator('.imp-pcal .imp-pbar .imp-icon-btn').count(), 0, 'no arrows')
		for (const v of [2, 0, 1]) {
			await pc.page.click(`.imp-pcal__views button >> nth=${v}`)
			await pc.page.waitForSelector('.imp-pcal .imp-pbar')
			await pc.page.evaluate(() => { for (let i = 0; i < 3; i++) document.querySelectorAll('.imp-pbar .imp-sr')[1].click() })
			await pc.page.waitForSelector('.imp-pcal__today', { timeout: 5000 })
			await pc.page.waitForTimeout(400)
			const t = await pc.page.evaluate(() => { const h1 = document.querySelector('.imp-pcal .imp-pbar h1'); return { h: h1.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(h1).lineHeight), text: h1.innerText } })
			assert.ok(t.h < t.lh * 1.5, `one line: ${t.text} (${t.h}px)`)
			await pc.page.click('.imp-pcal__today')
		}
		await pc.page.screenshot({ path: `${shots}/calendar-header.png` })
		// Month: the numbers don't move when the blocks arrive (the second line is always there)
		await pc.page.click('.imp-pcal__views button >> nth=2')
		await pc.page.waitForSelector('.imp-cv__month')
		const tops = await pc.page.evaluate(() => new Promise((res) => {
			const seen = new Set(); const t0 = performance.now()
			document.querySelectorAll('.imp-pbar .imp-sr')[1].click()
			const f = () => { const n = document.querySelectorAll('.imp-cv__mnum')[14]; if (n) seen.add(Math.round(n.getBoundingClientRect().top)); if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res([...seen]) }
			f()
		}))
		assert.equal(tops.length, 1, `month numbers stay put (${tops})`)
		await pc.page.click('.imp-pcal__views button >> nth=1')
		// Planning a block: no keyboard at first; with the keyboard (a shorter page), the sheet stays above it
		await pc.page.click('.imp-pcal__fab')
		await pc.page.waitForSelector('.imp-cvpanel--sheet input[type=time]')
		assert.ok(!(await pc.page.evaluate(() => /INPUT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type === 'text')), 'no text field focused when the sheet opens')
		await pc.page.setViewportSize({ width: 393, height: 480 })
		await pc.page.focus('.imp-cvpanel--sheet input[type=text]')
		await pc.page.waitForTimeout(300)
		const sheet = await pc.page.evaluate(() => { const r = document.querySelector('.imp-cvpanel--sheet').getBoundingClientRect(); const f = document.activeElement.getBoundingClientRect(); return { bottom: r.bottom, top: r.top, field: f.bottom, h: innerHeight } })
		assert.ok(sheet.bottom <= sheet.h + 1 && sheet.top >= 0 && sheet.field <= sheet.h, `the sheet fits above the keyboard (${JSON.stringify(sheet)})`)
		await pc.page.screenshot({ path: `${shots}/newblock-keyboard.png` })
		await pc.page.setViewportSize({ width: 393, height: 852 })
		// Tasks: a sideways swipe goes to the next commitment, and back
		await pc.page.evaluate(() => { location.hash = '#tasks' })
		await pc.page.waitForSelector('.imp-ptasks .imp-tcol', { timeout: 15000 })
		const chosen = () => pc.page.evaluate(() => document.querySelector('.imp-pchip[aria-selected="true"]')?.innerText)
		const firstChip = await chosen()
		const swipeTasks = async (dx, ok) => {
			for (let i = 0; i < 3; i++) {
				await pc.page.waitForSelector('.imp-updating[hidden]', { state: 'attached', timeout: 15000 }).catch(() => {})
				await swipe(dx)
				if (await pc.page.waitForFunction(ok, firstChip, { timeout: 5000 }).catch(() => null)) return
			}
			assert.fail(`tasks swiped ${dx}`)
		}
		await swipeTasks(-200, (t) => document.querySelector('.imp-pchip[aria-selected="true"]')?.innerText !== t)
		await swipeTasks(200, (t) => document.querySelector('.imp-pchip[aria-selected="true"]')?.innerText === t)
		assert.equal(await chosen(), firstChip)
		// A commitment without tasks: swiping on the empty page below works too
		const empty = await pc.page.evaluate(async () => window.trackerApp.api('POST', 'commitments', { name: 'Empty ' + Date.now(), color: '#888888' }))
		await pc.page.evaluate(() => { location.hash = '#now'; setTimeout(() => { location.hash = '#tasks' }, 50) })
		await pc.page.waitForSelector(`.imp-pchip >> text=${empty.name}`, { timeout: 15000 })
		await pc.page.click(`.imp-pchip >> text=${empty.name}`)
		await pc.page.waitForFunction((n) => document.querySelector('.imp-pchip[aria-selected="true"]')?.innerText.includes(n), empty.name)
		const swipeAt = async (dx, y) => {
			const cdp = await pc.page.context().newCDPSession(pc.page)
			const x0 = dx < 0 ? 330 : 80
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] })
			for (let i = 1; i <= 3; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (dx * i) / 3, y: y + i }] })
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
			await cdp.detach()
		}
		let away = false
		for (let i = 0; i < 3 && !away; i++) {
			await swipeAt(i % 2 ? 200 : -200, 700)
			away = !!(await pc.page.waitForFunction((n) => !document.querySelector('.imp-pchip[aria-selected="true"]')?.innerText.includes(n), empty.name, { timeout: 4000 }).catch(() => null))
		}
		assert.ok(away, 'swiped away from an empty commitment, below its (empty) list')
		await pc.page.evaluate((id) => window.trackerApp.api('DELETE', 'commitments/' + id), empty.id)
		// The ⋯ menu: a tap outside closes it, and doesn't start editing what's under it
		await pc.page.evaluate(() => { location.hash = '#now'; setTimeout(() => { location.hash = '#tasks' }, 50) })
		await pc.page.waitForSelector('.imp-pchip', { timeout: 15000 })
		await pc.page.click(`.imp-pchip >> text=${firstChip.trim()}`)
		await pc.page.waitForSelector('.imp-ptasks .imp-tq__more', { timeout: 15000 })
		await pc.page.waitForSelector('.imp-updating[hidden]', { state: 'attached', timeout: 15000 }).catch(() => {})
		await pc.page.locator('.imp-ptasks .imp-tq__more').first().click()
		await pc.page.waitForSelector('.imp-menu', { timeout: 5000 })
		const under = await pc.page.locator('.imp-ptasks .imp-tq__title').nth(1).boundingBox()
		await pc.page.touchscreen.tap(under.x + 20, under.y + under.height / 2)
		await pc.page.waitForTimeout(500)
		const after = await pc.page.evaluate(() => ({ menu: !!document.querySelector('.imp-menu'), editing: !!document.querySelector('.imp-ptasks input[type=text], .imp-ptasks textarea, .imp-ptasks [contenteditable="true"]'), sel: String(getSelection()) }))
		assert.deepEqual(after, { menu: false, editing: false, sel: '' }, 'menu closed, nothing edited or selected')
		// Done: a swipe goes to the previous day, and back
		await pc.page.evaluate(() => { location.hash = '#done' }) // the old link: now Progress
		await pc.page.waitForSelector('.imp-pprogress .imp-pdays', { timeout: 15000 })
		const dayNow = () => pc.page.evaluate(() => document.querySelector('.imp-pday[aria-selected="true"]')?.getAttribute('aria-label').split(':')[0] + document.querySelector('.imp-pprogress .imp-pbar p')?.innerText)
		const d0 = await dayNow()
		const doneSwipe = async (dx, same) => {
			for (let i = 0; i < 3; i++) {
				await pc.page.waitForSelector('.imp-updating[hidden]', { state: 'attached', timeout: 15000 }).catch(() => {})
				await swipeAt(dx, 600)
				await pc.page.waitForTimeout(700)
				if ((await dayNow() === d0) === same) return
			}
			assert.fail(`done swiped ${dx}: ${await dayNow()}`)
		}
		await doneSwipe(200, false)
		await doneSwipe(-200, true)
		await swipeAt(-200, 600)
		await pc.page.waitForTimeout(600)
		assert.equal(await dayNow(), d0, 'not past today')
		assert.deepEqual(pc.errors, [], 'no console errors')
		await pc.ctx.close()
		Object.assign(device, { phoneCals: null, phoneEvents: [], busyEvents: [] })
		console.log('  ✔ blocks in the phone\'s calendars: the planner moves and deletes them; other calendars as busy time; swipes; month holds still; the sheet above the keyboard')
	}

	console.log('offline')
	device.offline = true
	const o = await phone(browser, 'app.html', { hash: '#tasks' })
	await o.page.waitForSelector('.imp-ptasks .imp-tcol', { timeout: 15000 })
	// Said once: Nextcloud can't be reached, the changes stay on the phone
	await o.page.waitForSelector('.imp-updating.is-offline:not([hidden])', { timeout: 15000 })
	assert.match(await o.page.locator('.imp-updating').innerText(), /unreachable/i)
	await o.page.screenshot({ path: `${shots}/offline-note.png` })
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
	// Blocks while Nextcloud is down: the last known are there, and planning works (sent when it's back)
	const day0 = new Date(); day0.setHours(0, 0, 0, 0)
	const T = (d, h) => Math.floor(day0.getTime() / 1000) + d * 86400 + h * 3600
	const fromServer = await (await fetch(`${SERVER}/index.php/apps/tracker/api/blocks?from=${T(-14, 0)}&to=${T(0, 0)}`, { headers: { Authorization: AUTH, 'OCS-APIRequest': 'true' } })).json()
	const offlineBlocks = await o.page.evaluate((r) => window.trackerApp.api('GET', `blocks?from=${r[0]}&to=${r[1]}`), [T(-14, 0), T(0, 0)])
	assert.ok(fromServer.blocks.length > 0, 'the test server has blocks in the last two weeks')
	assert.deepEqual(offlineBlocks.blocks.map((b) => b.uid).sort(), fromServer.blocks.map((b) => b.uid).sort(), 'the last two weeks\' blocks, offline')
	const planned = 'Offline block ' + Date.now()
	const made = await o.page.evaluate(async ([title, s, e]) => {
		const st = await window.trackerApp.api('GET', 'state')
		const c = st.commitments.find((x) => x.calendarId)
		await window.trackerApp.api('POST', 'blocks', { commitmentId: c.id, title, start: s, end: e })
		const { blocks } = await window.trackerApp.api('GET', `blocks?from=${s - 3600}&to=${e + 3600}`)
		const b = blocks.find((x) => x.title === title)
		// moved an hour later, still offline
		const moved = await window.trackerApp.api('PUT', `blocks/${b.series}/${b.occurrence}`, { start: s + 3600, end: e + 3600, scope: 'all' })
		const after = (await window.trackerApp.api('GET', `blocks?from=${s - 3600}&to=${e + 7200}`)).blocks.filter((x) => x.title === title)
		return { moved, after: after.map((x) => [x.start, x.end]) }
	}, [planned, T(1, 10), T(1, 11)])
	assert.deepEqual(made.after, [[T(1, 11), T(1, 12)]], 'planned and moved while Nextcloud is down')
	await o.page.goto(o.page.url())
	await o.page.waitForSelector('.imp-pnow, .imp-ptasks', { timeout: 15000 })
	const kept = await o.page.evaluate(([title, s, e]) => window.trackerApp.api('GET', `blocks?from=${s}&to=${e}`).then((r) => r.blocks.filter((x) => x.title === title).length), [planned, T(1, 0), T(2, 0)])
	assert.equal(kept, 1, 'still there after a restart while it is down')

	// Every tab opens at once from the phone's data while the server doesn't answer (slowly)
	device.downDelay = 3000
	await o.page.evaluate(() => { location.hash = '#now' })
	await o.page.waitForSelector('.imp-pnow .imp-timer', { timeout: 8000 })
	for (const [hash, sel] of [['#progress', '.imp-pprogress .imp-pdays'], ['#calendar', '.imp-pcal .imp-cv__grid'], ['#tasks', '.imp-ptasks .imp-tcol'], ['#now', '.imp-pnow .imp-timer']]) {
		const t0 = Date.now()
		await o.page.evaluate((h) => { location.hash = h }, hash)
		await o.page.waitForSelector(sel, { timeout: 8000 })
		const ms = Date.now() - t0
		assert.ok(ms < 1500, `${hash} opened in ${ms} ms with Nextcloud down`)
	}
	// Now: no placeholders for today's blocks once Nextcloud is known to be down (fresh page, server slow to fail)
	{
		const n2 = await phone(browser, 'app.html', { hash: '#now' })
		await n2.page.waitForSelector('.imp-pnow .imp-ptoday', { timeout: 15000 })
		await n2.page.waitForFunction(() => !document.querySelector('.imp-ptoday [aria-busy]'), null, { timeout: 4000 + 3000 + 2000 })
		await n2.page.waitForTimeout(2000)
		assert.equal(await n2.page.locator('.imp-ptoday [aria-busy]').count(), 0, 'no placeholders stay in Now')
		// (Updating only while the first try is under way; then at most the note that it's down)
		await n2.page.waitForSelector('.imp-updating[hidden], .imp-updating.is-offline', { state: 'attached', timeout: 8000 })
		await n2.ctx.close()
	}
	device.downDelay = 0
	assert.deepEqual(o.errors.filter((e) => !/offline/.test(e)), [], 'no console errors offline')
	await o.ctx.close()
	console.log('  ✔ works offline from the phone\'s data; with Nextcloud down every tab opens at once')

	device.offline = false
	const back = await phone(browser, 'app.html', { hash: '#tasks' })
	await back.page.waitForSelector('.imp-ptasks .imp-tcol', { timeout: 15000 })
	await back.page.waitForFunction(() => true)
	await back.page.waitForTimeout(1500)
	const all = await serverRecords()
	const onServer = all.find((x) => x.type === 'task' && x.id === added.uuid)
	assert.ok(onServer && onServer.fields.title === title, 'the offline task reached the server when back online')
	assert.equal(Object.keys(JSON.parse(device.db).dirty).length, 0, 'nothing left to sync')
	// The block planned offline reached Nextcloud, where it was moved to
	await back.page.waitForFunction(() => true)
	let onNc = null
	for (let i = 0; i < 20 && !onNc; i++) {
		const r = await (await fetch(`${SERVER}/index.php/apps/tracker/api/blocks?from=${T(1, 0)}&to=${T(2, 0)}`, { headers: { Authorization: AUTH, 'OCS-APIRequest': 'true' } })).json()
		onNc = r.blocks.find((x) => x.title === planned)
		if (!onNc) await back.page.waitForTimeout(500)
	}
	assert.ok(onNc && onNc.start === T(1, 11) && onNc.end === T(1, 12), 'the offline block reached Nextcloud, moved')
	await back.page.waitForTimeout(1200) // (saved a moment after)
	assert.ok(!JSON.parse(device.blockCache).ops.length, 'nothing waiting')
	await back.page.evaluate((b) => window.trackerApp.api('GET', `blocks?from=${b.start - 10}&to=${b.end + 10}`).then((r) => {
		const x = r.blocks.find((y) => y.uid === b.uid)
		return x && window.trackerApp.api('DELETE', `blocks/${x.series}/${x.occurrence}`)
	}), onNc)
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
})().catch((e) => { console.error('✘', e.message, (e.stack || '').split('\n').find((l) => l.includes('ui.test.js'))); process.exit(1) })
