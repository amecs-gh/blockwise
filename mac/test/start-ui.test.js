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
	await page.waitForSelector('.imp-tcols')
	await page.evaluate(() => { location.hash = '#now' })
	await page.waitForSelector('.imp-inblock__list .imp-check')
	const scroll = await page.evaluate(() => {
		const m = document.querySelector('.imp-main'), l = document.querySelector('.imp-inblock__list')
		return { page: m.scrollHeight - m.clientHeight, list: l.scrollHeight - l.clientHeight, bar: l.offsetWidth - l.clientWidth }
	})
	assert.ok(scroll.page <= 1, `the Now page itself doesn't scroll (${scroll.page})`)
	assert.ok(scroll.list > 0 && scroll.bar === 0, `the tasks scroll inside, no scrollbar (${JSON.stringify(scroll)})`)
	ok('Now: only the tasks in this block scroll')

	// Tasks: a subtask moves by its own handle (not the task)
	await page.evaluate(() => { location.hash = '#tasks' })
	await page.waitForSelector('.imp-tcols .imp-tq__sub')
	const order = () => page.evaluate(async () => {
		const api = window.trackerApp.api
		const c = (await api('GET', 'state')).commitments[0]
		const t = (await api('GET', `tasks?commitmentId=${c.id}&status=open`)).find((x) => x.title === 'Long task')
		return { subs: t.subtasks.map((x) => x.title), tasks: (await api('GET', `tasks?commitmentId=${c.id}&status=open`)).map((x) => x.title) }
	})
	const o0 = await order()
	const subs = page.locator('.imp-tq__item:has-text("Long task") .imp-tq__sub')
	await subs.nth(2).hover()
	await page.dragAndDrop('.imp-tq__item:has-text("Long task") .imp-tq__sub >> nth=2 >> .imp-sub__handle', '.imp-tq__item:has-text("Long task") .imp-tq__sub >> nth=0', { targetPosition: { x: 40, y: 4 } })
	await page.waitForTimeout(400)
	const o1 = await order()
	assert.equal(o1.subs[0], o0.subs[2], `third subtask moved to the top (${o1.subs.slice(0, 3)})`)
	assert.deepEqual(o1.tasks, o0.tasks, 'the tasks kept their order')
	ok('Tasks: drag a subtask by its handle')

	// Settings: deleting a commitment asks in its card (built in: no calendar choice); Cancel keeps it
	await page.evaluate(async () => { await window.trackerApp.api('POST', 'commitments', { name: 'Gone soon', color: '#e8590c' }) })
	await page.evaluate(() => { location.hash = '#settings' })
	await page.click('.imp-clist__edit[aria-label="Edit Gone soon"]')
	await page.click('.imp-ceditor .imp-button--danger')
	await page.waitForSelector('.imp-ceditor__confirm')
	assert.equal(await page.locator('.imp-ceditor__check').count(), 0, 'built in: its blocks always go, nothing to choose')
	assert.match(await page.textContent('.imp-ceditor__ask'), /Gone soon.*blocks/)
	await page.click('.imp-ceditor__confirm .imp-button:not(.imp-button--danger)')
	assert.equal(await page.locator('.imp-ceditor__confirm').count(), 0)
	await page.click('.imp-ceditor .imp-button--danger')
	await page.click('.imp-ceditor__confirm .imp-button--danger')
	await page.waitForFunction(() => !document.querySelector('.imp-ceditor'))
	assert.ok(!(await page.evaluate(async () => (await window.trackerApp.api('GET', 'state')).commitments.map((c) => c.name))).includes('Gone soon'))
	ok('Settings: delete a commitment from its card, Cancel keeps it')

	// Many commitments (15): nothing breaks. Tasks scroll sideways with readable columns,
	// the chips stay on one row, Now keeps the day visible
	await page.evaluate(async () => {
		for (let i = 0; i < 14; i++) await window.trackerApp.api('POST', 'commitments', { name: 'Many ' + (i + 1), color: '#1971c2' })
	})
	// (made behind the page's back: Settings reloads the list)
	await page.evaluate(() => { location.hash = '#now' })
	await page.waitForSelector('.imp-now')
	await page.evaluate(() => { location.hash = '#settings' })
	await page.waitForFunction(() => document.querySelectorAll('.imp-clist__edit').length >= 15)
	await page.evaluate(() => { location.hash = '#tasks' })
	await page.waitForFunction(() => document.querySelectorAll('.imp-tcol').length >= 15)
	await page.waitForTimeout(300)
	const cols = await page.evaluate(() => {
		const row = document.querySelector('.imp-tcols')
		const widths = [...row.querySelectorAll('.imp-tcol')].map((c) => c.getBoundingClientRect().width)
		const [prev, next] = document.querySelectorAll('.imp-tcols__nav button')
		return { min: Math.min(...widths), scrolls: row.scrollWidth > row.clientWidth, prevHidden: prev.hidden, nextHidden: next.hidden, prevDisabled: prev.disabled, pageWidth: document.documentElement.scrollWidth, view: innerWidth }
	})
	assert.ok(cols.min >= 359, `columns stay readable (${cols.min}px)`)
	assert.ok(cols.scrolls && !cols.nextHidden && cols.prevDisabled, 'the columns scroll sideways, with next/previous')
	assert.ok(cols.pageWidth <= cols.view, 'the page itself never scrolls sideways')
	await page.click('.imp-tcols__nav button:last-child')
	await page.waitForFunction(() => document.querySelector('.imp-tcols').scrollLeft > 100)
	await page.mouse.move(600, 260)
	const before = await page.evaluate(() => document.querySelector('.imp-tcols').scrollLeft)
	await page.mouse.wheel(0, 300)
	await page.waitForTimeout(200)
	assert.ok(await page.evaluate((b) => document.querySelector('.imp-tcols').scrollLeft !== b, before), 'the wheel scrolls the columns')
	const chips = await page.evaluate(() => {
		const ul = document.querySelector('.imp-nav__commitments')
		const tops = new Set([...ul.children].map((li) => Math.round(li.getBoundingClientRect().top)))
		const add = ul.querySelector('.imp-nav__add').getBoundingClientRect()
		return { rows: tops.size, addVisible: add.right <= ul.getBoundingClientRect().right + 1 && add.width > 0 }
	})
	assert.equal(chips.rows, 1, 'the chips stay on one row')
	assert.ok(chips.addVisible, '"New commitment" stays in view')
	await page.evaluate(() => { location.hash = '#now' })
	await page.waitForSelector('.imp-others')
	await page.waitForTimeout(400)
	const now = await page.evaluate(() => ({ day: document.querySelector('.imp-now__side > .imp-day').getBoundingClientRect().height, list: (() => { const u = document.querySelector('.imp-others ul'); return u.scrollHeight > u.clientHeight })() }))
	assert.ok(now.day >= 239, `the day stays visible (${now.day}px)`)
	assert.ok(now.list, 'the commitments scroll inside their card')
	ok('15 commitments: task columns scroll sideways, chips on one row, Now keeps the day')
	assert.deepEqual(errors, [])
	await browser.close()
	console.log('\nstart-time page tests passed')
})().catch((e) => { console.error('✘', e); process.exit(1) })
