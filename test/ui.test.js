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

// What the app sends after loading: dark mode, wallpaper colors (Android 12+), bar sizes
const THEME = (dark, dynamic) => ({
	dark,
	insets: { top: 32, bottom: 24, left: 0, right: 0 },
	colors: dynamic ? (dark
		? { primary: '#9bd59b', onPrimary: '#00390f', primaryContainer: '#1f5125', onPrimaryContainer: '#b6f1b5', secondaryContainer: '#3a4b39', onSecondaryContainer: '#d4e8d0', surface: '#101510', surfaceContainerLow: '#181d18', surfaceContainer: '#1c211c', surfaceContainerHigh: '#262b26', surfaceContainerHighest: '#313631', onSurface: '#dfe4dc', onSurfaceVariant: '#c2c8bd', outline: '#8c9389', outlineVariant: '#424940' }
		: { primary: '#376a3a', onPrimary: '#ffffff', primaryContainer: '#b8f1b5', onPrimaryContainer: '#002107', secondaryContainer: '#d4e8d0', onSecondaryContainer: '#101f10', surface: '#f6fbf1', surfaceContainerLow: '#f0f5eb', surfaceContainer: '#eaefe5', surfaceContainerHigh: '#e4eadf', surfaceContainerHighest: '#dfe4da', onSurface: '#181d17', onSurfaceVariant: '#424940', outline: '#72796f', outlineVariant: '#c2c8bd' })
		: null,
})

const device = { db: null, snapshot: null, offline: false, remoteCalls: [] }
const GUARD = /^(sync\?since=\d{1,18}&limit=\d{1,5}|state|blocks\?from=\d{1,12}&to=\d{1,12})$/ // = core ApiGuard

async function phone(browser, file, { dark = false, locale = 'en-US', hash = '', dynamic = false } = {}) {
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
			if (channel === 'state') env = { data: { platform: 'android', locale } }
			else if (channel === 'dbLoad') env = { data: device.db }
			else if (channel === 'dbSave') { device.db = args[0]; env = { data: null } }
			else if (channel === 'snapshot') { device.snapshot = args[0]; env = { data: null } }
			else if (channel === 'outbox' || channel === 'calendars' || channel === 'events') env = { data: [] }
			else if (channel === 'calendarAccess') env = { data: false }
			else if (channel === 'createEvent') env = { error: 'This commitment\'s calendar is not on this phone. Turn it on in DAVx5.', status: 0 }
			else if (channel === 'remote') {
				const [method, p, body] = args
				device.remoteCalls.push(`${method} ${p}`)
				if (!(method === 'GET' ? GUARD.test(p) : method === 'POST' && p === 'sync')) throw new Error('refused by ApiGuard: ' + method + ' ' + p)
				if (device.offline) throw new Error('offline')
				const r = await fetch(`${SERVER}/index.php/apps/tracker/api/${p}`, { method, headers: { Authorization: AUTH, 'OCS-APIRequest': 'true', 'Content-Type': 'application/json' }, body: body === null ? undefined : JSON.stringify(body) })
				const d = await r.json().catch(() => null)
				env = r.ok ? { data: d } : { error: (d && d.message) || `HTTP ${r.status}`, status: r.status }
			} else env = { data: null }
		} catch (e) { env = { error: e.message } }
		await page.evaluate(([i, e]) => window.__trackerAndroid.resolve(i, e), [id, JSON.stringify(env)])
	})
	await page.addInitScript(() => { window.TrackerAndroid = { call: (id, ch, a) => { window.__native(id, ch, a) } } })
	await page.goto('file://' + path.join(ASSETS, file) + hash)
	await page.evaluate((t) => window.__trackerAndroidTheme(t), THEME(dark, dynamic))
	return { page, errors, calls, ctx }
}

;(async () => {
	const browser = await chromium.launch()
	const s = await phone(browser, 'setup.html', { dynamic: true })
	await s.page.waitForTimeout(400)
	assert.match(await s.page.textContent('#intro'), /stored encrypted on this phone/)
	await s.page.screenshot({ path: `${shots}/setup.png` })
	console.log('setup ok')

	for (const [dark, locale, dynamic] of [[false, 'en-US', false], [true, 'en-US', false], [false, 'it-IT', true], [true, 'it-IT', true]]) {
		const a = await phone(browser, 'app.html', { dark, locale, hash: '#now', dynamic })
		await a.page.waitForSelector('.imp-page', { timeout: 15000 })
		const tag = `${dark ? 'dark' : 'light'}-${locale.slice(0, 2)}${dynamic ? '-you' : ''}`
		const firstC = await a.page.evaluate(() => document.querySelector('.imp-nav__commitments a')?.getAttribute('href')?.slice(1))
		for (const pg of ['now', 'tasks', 'done', 'time', 'settings', firstC]) {
			await a.page.evaluate((h) => { location.hash = h }, '#' + pg)
			// wait until the page has loaded (some make several requests)
			await a.page.waitForFunction((pg) => { const h = document.querySelector('.imp-page h1'); const want = { now: null, tasks: 'Tasks|Task', done: 'Done|Fatto', time: 'Time|Tempo', settings: 'Settings|Impostazioni' }[pg]; return pg === 'now' ? !!document.querySelector('.imp-timer') : pg === 'tasks' ? !!document.querySelector('.imp-tq__top') : pg.startsWith('c/') ? !!document.querySelector('.imp-cpage') : !!h && new RegExp('^(' + want + ')$').test(h.textContent.trim()) }, pg, { timeout: 15000 })
			await a.page.waitForTimeout(400)
			const info = await a.page.evaluate(() => {
				const m = document.querySelector('.imp-main')
				const tabs = document.querySelector('.imp-nav__main:not(.imp-nav__apps)').getBoundingClientRect()
				return { overflow: document.documentElement.scrollWidth - innerWidth, tabsBottom: Math.round(tabs.bottom), h: innerHeight, apps: document.querySelectorAll('.imp-nav__apps a').length, chips: document.querySelectorAll('.imp-nav__commitments a').length, failed: !!document.querySelector('.imp-empty')?.textContent.includes('could not be loaded') }
			})
			assert.ok(info.overflow <= 1, `no sideways scroll on ${pg} (${info.overflow})`)
			assert.equal(info.tabsBottom, info.h, 'tab bar at the bottom')
			assert.equal(info.apps, 2, 'Calendar and Account buttons')
			assert.ok(info.chips >= 2, 'commitment chips')
			assert.ok(!info.failed, `page ${pg} loads`)
			if (!dark || pg === 'now' || pg === 'tasks') await a.page.screenshot({ path: `${shots}/${tag}-${pg.replace('/', '')}.png` })
		}
		assert.ok(await a.page.$('.imp-newblock button'), 'Plan a block on the commitment page')
		await a.page.click('.imp-newblock button')
		await a.page.locator('.imp-newblock').scrollIntoViewIfNeeded()
		await a.page.screenshot({ path: `${shots}/${tag}-newblock.png` })
		await a.page.click('.imp-newblock__form button[type=submit]')
		await a.page.waitForTimeout(400)
		await a.page.click('.imp-newblock__actions button[type=button]')
		// Account and Calendar reach the app
		await a.page.click('.imp-nav__apps a[title="Account"], .imp-nav__apps a[title="Account"]')
		await a.page.click('.imp-nav__apps a >> nth=0')
		await a.page.waitForTimeout(300)
		assert.ok(a.calls.includes('account') && a.calls.includes('openCalendar'), 'account/calendar calls')
		assert.deepEqual(a.errors, [], 'no console errors')
		console.log(tag, 'ok')
		await a.ctx.close()
	}
	// Everything came from the phone's engine; the server only saw sync requests
	assert.ok(device.remoteCalls.every((c) => /^(GET sync|POST sync|GET state|GET blocks)/.test(c)), 'only sync endpoints')
	assert.ok(device.snapshot && Array.isArray(device.snapshot.commitments) && device.snapshot.node, 'snapshot for the notifications')

	console.log('offline')
	device.offline = true
	const o = await phone(browser, 'app.html', { hash: '#tasks' })
	await o.page.waitForSelector('.imp-tq__top', { timeout: 15000 })
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
	await back.page.waitForSelector('.imp-tq__top', { timeout: 15000 })
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
