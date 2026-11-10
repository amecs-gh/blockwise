// The calendar page in Nextcloud's web interface: blocks from (and into) the
// commitments' Nextcloud calendars. node tests/calendar-web.test.js (needs the test Nextcloud)
process.env.TZ = 'Europe/Zurich'
const assert = require('node:assert/strict')
const { chromium } = require(require.resolve('playwright', { paths: [__dirname + '/../../mac'] }))
const B = process.env.NC || 'http://localhost:8080'
const shots = process.env.SHOTS || '/tmp/claude-0'
const AUTH = { Authorization: 'Basic ' + Buffer.from('admin:admin-test-pw-123').toString('base64'), 'OCS-APIRequest': 'true', 'Content-Type': 'application/json', Accept: 'application/json' }
const api = async (m, p, body) => {
	const r = await fetch(`${B}/index.php/apps/tracker/api/${p}`, { method: m, headers: AUTH, body: body === undefined ? undefined : JSON.stringify(body) })
	const data = await r.json().catch(() => null)
	if (r.status >= 400) throw new Error(`${m} ${p}: ${r.status} ${JSON.stringify(data)}`)
	return data
}
const ok = (n) => console.log('  ✔', n)
const at = (d, h, m = 0) => Math.floor(new Date(2026, 10, d, h, m).getTime() / 1000)

;(async () => {
	const stamp = Date.now().toString(36)
	const a = await api('POST', 'commitments', { name: `Web cal ${stamp}`, color: '#2e9b5f' })
	await api('POST', 'tasks', { commitmentId: a.id, title: 'Write the report', subtasks: ['Collect data 30m', 'First draft 1h'] })
	const series = await api('POST', 'blocks', { commitmentId: a.id, start: at(9, 9), end: at(9, 11), repeat: 'weekdays', tz: 'Europe/Zurich' })
	const browser = await chromium.launch()
	try {
		const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2, timezoneId: 'Europe/Zurich', locale: 'en-US' })
		await ctx.addInitScript(() => {
			const fixed = new Date(2026, 10, 10, 10, 20).getTime()
			const R = Date
			const t0 = R.now()
			window.Date = class extends R { constructor(...a) { super(...(a.length ? a : [fixed + (R.now() - t0)])) } static now() { return fixed + (R.now() - t0) } }
		})
		const page = await ctx.newPage()
		const errors = []
		page.on('pageerror', (e) => errors.push(e.message))
		await page.goto(`${B}/index.php/login`)
		await page.fill('#user', 'admin')
		await page.fill('#password', 'admin-test-pw-123')
		await page.click('button[type=submit]')
		await page.waitForURL(/apps|dashboard/)
		await page.goto(`${B}/index.php/apps/tracker/#calendar`)
		await page.waitForSelector('.imp-cal__col')
		assert.ok(await page.isVisible('a.active[href="#calendar"]'), 'Calendar in the sidebar')
		const mine = page.locator(`.imp-cal__ev:has-text("Web cal ${stamp}")`)
		assert.equal(await mine.count(), 5, 'the weekday blocks from the Nextcloud calendar')
		await page.screenshot({ path: `${shots}/nc-cal-week.png` })
		ok('the week from the commitment\'s Nextcloud calendar')

		await mine.nth(1).click()
		await page.waitForSelector('.imp-calpanel__tasks')
		assert.match(await page.innerText('.imp-calpanel'), /Collect data/)
		await page.screenshot({ path: `${shots}/nc-cal-summary.png` })
		await page.keyboard.press('Escape')
		ok('click a block: its tasks')

		// Drag Wednesday's block down two hours: "this block only"
		const wed = page.locator('.imp-cal__col').nth(2).locator(`.imp-cal__ev:has-text("Web cal ${stamp}")`)
		const wb = await wed.boundingBox()
		await page.mouse.move(wb.x + 20, wb.y + 10)
		await page.mouse.down()
		await page.mouse.move(wb.x + 20, wb.y + 10 + 2 * 48, { steps: 8 })
		await page.mouse.up()
		await page.waitForSelector('.imp-calpanel__q')
		await page.click('.imp-calpanel .imp-button--primary')
		await page.waitForTimeout(1200)
		const list = (await api('GET', `blocks?from=${at(9, 0)}&to=${at(14, 0)}`)).blocks.filter((x) => x.series === series.series)
		assert.deepEqual(list.map((x) => `${new Date(x.start * 1000).getDate()}@${new Date(x.start * 1000).getHours()}`), ['9@9', '10@9', '11@11', '12@9', '13@9'])
		ok('drag one block of a series: changed in the Nextcloud calendar (this one only)')

		// Plan a new block by dragging on Saturday
		const sat = await page.locator('.imp-cal__col').nth(5).boundingBox()
		const top = await page.evaluate(() => document.querySelector('.imp-cal__body').getBoundingClientRect().top)
		await page.mouse.move(sat.x + 30, top + 14 * 48 + 4)
		await page.mouse.down()
		await page.mouse.move(sat.x + 30, top + 15 * 48, { steps: 6 })
		await page.mouse.up()
		await page.waitForSelector('.imp-calpanel form')
		await page.selectOption('.imp-calpanel select >> nth=0', String(a.id))
		await page.fill('.imp-calpanel input[type=text]', 'Saturday review')
		await page.screenshot({ path: `${shots}/nc-cal-new.png` })
		await page.click('.imp-calpanel button[type=submit]')
		await page.waitForSelector('.imp-cal__ev:has-text("Saturday review")')
		const sat2 = (await api('GET', `blocks?from=${at(14, 0)}&to=${at(15, 0)}`)).blocks.find((x) => x.title === 'Saturday review')
		assert.ok(sat2 && new Date(sat2.start * 1000).getHours() === 14)
		ok('plan a block by dragging: a new event in the Nextcloud calendar')
		assert.deepEqual(errors, [])
	} finally {
		await browser.close()
		await api('DELETE', `commitments/${a.id}`).catch(() => {})
	}
	console.log('\ncalendar web tests passed')
})().catch((e) => { console.error('✘', e); process.exit(1) })
