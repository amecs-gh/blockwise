// The Android app's page (app.html, setup.html) in Chromium at phone size, with a
// stand-in for the Java bridge that forwards to the test Nextcloud.
const { chromium } = require('playwright')
const path = require('node:path')
const assert = require('node:assert/strict')
const SERVER = 'http://localhost:8080'
const AUTH = 'Basic ' + Buffer.from('admin:admin-test-pw-123').toString('base64')
const ASSETS = path.join(__dirname, '..', 'app/src/main/assets')
const shots = process.env.SHOTS || '/tmp/claude-0/android'
require('node:fs').mkdirSync(shots, { recursive: true })

async function phone(browser, file, { dark = false, locale = 'en-US', hash = '' } = {}) {
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
			else if (channel === 'api') {
				const [method, p, body] = args
				const r = await fetch(`${SERVER}/index.php/apps/tracker/api/${p}`, { method, headers: { Authorization: AUTH, 'OCS-APIRequest': 'true', 'Content-Type': 'application/json' }, body: body === null ? undefined : JSON.stringify(body) })
				const d = await r.json().catch(() => null)
				env = r.ok ? { data: d } : { error: (d && d.message) || `HTTP ${r.status}`, status: r.status }
			} else env = { data: null }
		} catch (e) { env = { error: e.message } }
		await page.evaluate(([i, e]) => window.__trackerAndroid.resolve(i, e), [id, JSON.stringify(env)])
	})
	await page.addInitScript(() => { window.TrackerAndroid = { call: (id, ch, a) => { window.__native(id, ch, a) } } })
	await page.goto('file://' + path.join(ASSETS, file) + hash)
	return { page, errors, calls, ctx }
}

;(async () => {
	const browser = await chromium.launch()
	const s = await phone(browser, 'setup.html')
	await s.page.waitForTimeout(400)
	assert.match(await s.page.textContent('#intro'), /stored encrypted on this phone/)
	await s.page.screenshot({ path: `${shots}/setup.png` })
	console.log('setup ok')

	for (const [dark, locale] of [[false, 'en-US'], [true, 'en-US'], [false, 'it-IT']]) {
		const a = await phone(browser, 'app.html', { dark, locale, hash: '#now' })
		await a.page.waitForSelector('.imp-page', { timeout: 15000 })
		const tag = `${dark ? 'dark' : 'light'}-${locale.slice(0, 2)}`
		for (const pg of ['now', 'tasks', 'done', 'time', 'settings', 'c/1']) {
			await a.page.evaluate((h) => { location.hash = h }, '#' + pg)
			await a.page.waitForTimeout(1300)
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
		// Account and Calendar reach the app
		await a.page.click('.imp-nav__apps a[title="Account"], .imp-nav__apps a[title="Account"]')
		await a.page.click('.imp-nav__apps a >> nth=0')
		await a.page.waitForTimeout(300)
		assert.ok(a.calls.includes('account') && a.calls.includes('openCalendar'), 'account/calendar calls')
		assert.deepEqual(a.errors, [], 'no console errors')
		console.log(tag, 'ok')
		await a.ctx.close()
	}
	await browser.close()
	console.log('✔ android ui ok')
})().catch((e) => { console.error('✘', e.message); process.exit(1) })
