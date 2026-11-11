// "Started 10:04 ✎" on the running timer: −5/−10/−15/−30 min or an exact time.
// node test/start-ui.test.js
process.env.TZ = 'Europe/Zurich'
const path = require('node:path')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const shots = process.env.SHOTS || '/tmp/claude-0'
const src = require('node:fs').readFileSync(path.join(__dirname, 'calendar.test.js'), 'utf8')
const bridge = src.match(/function bridge\(\) \{[\s\S]*?\n\}\n/)[0]
const ok = (n) => console.log('  ✔', n)
;(async () => {
	const browser = await chromium.launch()
	const ctx = await browser.newContext({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 2, timezoneId: 'Europe/Zurich', locale: 'en-US' })
	await ctx.addInitScript(bridge + ';bridge()')
	const page = await ctx.newPage()
	const errors = []
	page.on('pageerror', (e) => errors.push(e.message))
	await page.goto('file://' + path.join(__dirname, '..', 'renderer', 'app.html') + '#now')
	await page.addScriptTag({ url: 'file://' + path.join(__dirname, '..', 'renderer', 'web', 'engine.js') })
	await page.waitForSelector('.imp-nav')
	await page.evaluate(async () => { await window.trackerApp.api('POST', 'commitments', { name: 'Thesis', color: '#3b6fd8' }) })
	await page.evaluate(() => { location.hash = '#settings' })
	await page.waitForSelector('.imp-settings__section')
	await page.evaluate(() => { location.hash = '#now' })
	await page.click('.imp-play')
	await page.waitForSelector('.imp-timer__since')
	const startOf = () => page.evaluate(async () => (await window.trackerApp.api('GET', 'dashboard')).running.start)
	const s0 = await startOf()
	await page.click('.imp-timer__since')
	await page.waitForSelector('.imp-menu__chips')
	await page.screenshot({ path: `${shots}/start-menu.png` })
	await page.click('.imp-menu__chips button >> nth=1') // −10 min
	await page.waitForFunction((s) => document.querySelector('.imp-timer__clock').textContent.startsWith('10:') || document.querySelector('.imp-timer__clock').textContent.includes('10:0'), s0)
	assert.equal(await startOf(), s0 - 600)
	ok('−10 min: the clock shows 10 minutes more')
	await page.click('.imp-timer__since')
	const d = new Date((s0 - 1800) * 1000)
	await page.fill('.imp-menu__input', `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)
	await page.press('.imp-menu__input', 'Enter')
	await page.waitForTimeout(300)
	assert.equal(await startOf(), Math.floor(d.setSeconds(0, 0) / 1000))
	await page.screenshot({ path: `${shots}/start-after.png` })
	ok('an exact time: started at that minute')

	// Wide window: the page stays put; only the block's tasks scroll, without a scrollbar
	await page.evaluate(async () => {
		const api = window.trackerApp.api
		const c = (await api('GET', 'state')).commitments[0]
		await api('POST', 'tasks', { commitmentId: c.id, title: 'Long task', subtasks: Array.from({ length: 14 }, (_, i) => `Step ${i + 1} 10m`) })
		location.hash = '#tasks'
	})
	await page.waitForSelector('.imp-tq__top')
	await page.evaluate(() => { location.hash = '#now' })
	await page.waitForSelector('.imp-inblock__list .imp-check')
	const scroll = await page.evaluate(() => {
		const m = document.querySelector('.imp-main'), l = document.querySelector('.imp-inblock__list')
		return { page: m.scrollHeight - m.clientHeight, list: l.scrollHeight - l.clientHeight, bar: l.offsetWidth - l.clientWidth }
	})
	assert.ok(scroll.page <= 1, `the Now page itself doesn't scroll (${scroll.page})`)
	assert.ok(scroll.list > 0 && scroll.bar === 0, `the tasks scroll inside, no scrollbar (${JSON.stringify(scroll)})`)
	ok('Now: only the tasks in this block scroll')
	assert.deepEqual(errors, [])
	await browser.close()
	console.log('\nstart-time page tests passed')
})().catch((e) => { console.error('✘', e); process.exit(1) })
