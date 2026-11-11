// The built-in calendar in the real window (renderer/app.html) with the engine
// running in the page: week, day and month; drag to plan, move and resize;
// click for what to do; repeating blocks ("this or all future"); keys; dark
// mode; Italian. Screenshots in $SHOTS. node test/calendar.test.js
process.env.TZ = 'Europe/Zurich'
const path = require('node:path')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const shots = process.env.SHOTS || '/tmp/claude-0'
const ok = (n) => console.log('  ✔', n)

const appUrl = 'file://' + path.join(__dirname, '..', 'renderer', 'app.html')
const engineFile = path.join(__dirname, '..', 'renderer', 'web', 'engine.js')

/** The page's bridge, answered by the engine in the page (built-in calendar) */
function bridge() {
	let engine = null
	const ready = new Promise((resolve) => {
		const go = async () => {
			if (!window.TrackerEngine) return setTimeout(go, 10)
			let saved = null
			engine = await window.TrackerEngine.createEngine({ storage: { load: async () => saved, save: async (db) => { saved = JSON.parse(JSON.stringify(db)) } }, remote: null, calendar: { kind: 'builtin' } })
			resolve()
		}
		go()
	})
	const changed = []
	window.__calls = []
	window.trackerApp = {
		api: async (m, p, b) => { await ready; window.__calls.push(`${m} ${p}`); return engine.api(m, p, b) },
		openCalendar: async () => {},
		onChanged: (cb) => changed.push(cb),
		calendarMode: async () => ({ mode: 'builtin', available: true }),
		setCalendarMode: async (m) => { window.__calls.push(`mode ${m}`); return { changed: false } },
	}
	window.__engine = () => engine
}

;(async () => {
	const browser = await chromium.launch()
	for (const [locale, dark] of [['en-US', false], ['it-IT', true]]) {
		const it = locale.startsWith('it')
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, locale, colorScheme: dark ? 'dark' : 'light', timezoneId: 'Europe/Zurich' })
		// Tuesday 10 November 2026, 10:20
		await ctx.addInitScript(() => {
			const fixed = new Date(2026, 10, 10, 10, 20).getTime()
			const RealDate = Date
			const start = RealDate.now()
			class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed + (RealDate.now() - start)])) } static now() { return fixed + (RealDate.now() - start) } }
			window.Date = FakeDate
		})
		await ctx.addInitScript(bridge)
		const page = await ctx.newPage()
		const errors = []
		page.on('pageerror', (e) => errors.push(e.message))
		page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
		await page.goto(appUrl + '#now')
		await page.addScriptTag({ url: 'file://' + engineFile })
		await page.waitForSelector('.imp-nav')
		// Two commitments with tasks
		const ids = await page.evaluate(async () => {
			const api = window.trackerApp.api
			const a = await api('POST', 'commitments', { name: 'Thesis', color: '#3b6fd8' })
			const b = await api('POST', 'commitments', { name: 'Teaching', color: '#d8643b' })
			const t = await api('POST', 'tasks', { commitmentId: a.id, title: 'Chapter 3', subtasks: ['Outline 30m', 'Draft section 3.1 1h', 'Figures 45m'] })
			await api('POST', 'tasks', { commitmentId: a.id, title: 'Reply to reviewer 20m' })
			await api('POST', 'tasks', { commitmentId: b.id, title: 'Grade exams 2h' })
			const at = (d, h, m = 0) => Math.floor(new Date(2026, 10, d, h, m).getTime() / 1000)
			await api('POST', 'blocks', { commitmentId: a.id, start: at(9, 9), end: at(9, 12), repeat: 'weekdays' })
			await api('POST', 'blocks', { commitmentId: b.id, title: 'Lecture', start: at(10, 14), end: at(10, 16), repeat: 'weekly' })
			await api('POST', 'blocks', { commitmentId: b.id, title: 'Office hours', start: at(12, 10), end: at(12, 11) })
			return { a: a.id, b: b.id, t: t.id }
		})
		await page.evaluate(() => { location.hash = '#calendar' })
		await page.waitForSelector('.imp-cv__col')
		// The font must be in before measuring the grid for drags (it changes the layout)
		await page.evaluate(() => document.fonts.ready)
		await page.waitForTimeout(300)

		// Week view
		assert.equal(await page.locator('.imp-cv__col').count(), 7)
		assert.ok(await page.isVisible('a.active[href="#calendar"]'), 'Calendar in the sidebar, inside the app')
		const evs = await page.locator('.imp-cv__ev').count()
		assert.equal(evs, 5 + 1 + 1, 'weekday blocks Mon–Fri, the lecture, office hours')
		assert.ok(await page.isVisible('.imp-cv__now'))
		assert.match(await page.innerText('.imp-cv__head h1'), it ? /9\s*[–-]\s*15 nov 2026/i : /Nov 9\s*[–-]\s*15, 2026/)
		await page.screenshot({ path: `${shots}/cal-week-${locale}.png` })
		ok(`${locale}: week view with repeating blocks, now line`)

		// Click a block: what to do in it
		const tue = page.locator('.imp-cv__col').nth(1).locator('.imp-cv__ev').first()
		await tue.click()
		await page.waitForSelector('.imp-cvpanel')
		const panel = await page.innerText('.imp-cvpanel')
		assert.match(panel, /Thesis/)
		assert.match(panel, it ? /Da fare in questo blocco|In questo blocco/i : /To do in this block/)
		assert.match(panel, /Chapter 3/)
		assert.match(panel, /Outline/)
		await page.screenshot({ path: `${shots}/cal-summary-${locale}.png` })
		// Tick a subtask right there
		await page.locator('.imp-cvpanel input[type=checkbox]').first().check()
		await page.waitForTimeout(150)
		const done = await page.evaluate(async (tid) => (await window.trackerApp.api('GET', 'tasks?commitmentId=1&status=open')).find((x) => x.id === tid).subtasks.filter((s) => s.done).length, ids.t)
		assert.equal(done, 1)
		assert.ok(await page.isVisible('.imp-cvpanel'), 'stays open after ticking')
		ok(`${locale}: click a block → its tasks and subtasks, tick them there`)
		await page.keyboard.press('Escape')
		assert.equal(await page.locator('.imp-cvpanel').count(), 0)

		// Drag on an empty slot: plan a block (Saturday 14:00–15:30)
		const sat = page.locator('.imp-cv__col').nth(5)
		const box = await sat.boundingBox()
		const yOf = async (h) => {
			const top = await page.evaluate(() => document.querySelector('.imp-cv__body').getBoundingClientRect().top)
			return top + h * 48
		}
		await page.mouse.move(box.x + box.width / 2, await yOf(14) + 4)
		await page.mouse.down()
		await page.mouse.move(box.x + box.width / 2, await yOf(15.5), { steps: 8 })
		await page.mouse.up()
		await page.waitForSelector('.imp-cvpanel form')
		assert.equal(await page.inputValue('.imp-cvpanel input[type=time] >> nth=0'), '14:00')
		assert.equal(await page.inputValue('.imp-cvpanel input[type=time] >> nth=1'), '15:30')
		await page.fill('.imp-cvpanel input[type=text]', 'Weekend writing')
		await page.screenshot({ path: `${shots}/cal-new-${locale}.png` })
		await page.click('.imp-cvpanel button[type=submit]')
		await page.waitForSelector('.imp-cv__ev:has-text("Weekend writing")')
		ok(`${locale}: drag on the grid → new block 14:00–15:30`)

		// Move it to Sunday 16:00 by dragging (once the grid has scrolled back to where it was)
		await page.waitForTimeout(300)
		const ev = page.locator('.imp-cv__ev:has-text("Weekend writing")')
		const eb = await ev.boundingBox()
		const sun = await page.locator('.imp-cv__col').nth(6).boundingBox()
		await page.mouse.move(eb.x + 20, eb.y + 10)
		await page.mouse.down()
		await page.mouse.move(sun.x + 20, eb.y + 10 + 2 * 48, { steps: 10 })
		await page.mouse.up()
		// Saving the move takes a moment: wait for it (up to 3 s)
		const sunday = () => page.evaluate(async () => (await window.trackerApp.api('GET', `blocks?from=${Math.floor(new Date(2026, 10, 15).getTime() / 1000)}&to=${Math.floor(new Date(2026, 10, 16).getTime() / 1000)}`)).blocks.find((b) => b.title === 'Weekend writing'))
		let moved
		for (let i = 0; i < 30 && !(moved = await sunday()); i++) await page.waitForTimeout(100)
		if (process.env.DEBUG) console.log('moved', new Date(moved.start * 1000).toString(), eb, sun)
		assert.ok(moved, 'now on Sunday')
		assert.equal(new Date(moved.start * 1000).getHours(), 16)
		assert.equal(moved.end - moved.start, 5400, 'same length')
		ok(`${locale}: drag a block to another day and time`)

		// Resize it from its lower edge to 18:00
		await page.waitForTimeout(300)
		const ev2 = page.locator('.imp-cv__ev:has-text("Weekend writing")')
		const rb = await ev2.boundingBox()
		await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height - 2)
		await page.mouse.down()
		await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height - 2 + 0.5 * 48, { steps: 6 })
		await page.mouse.up()
		await page.waitForTimeout(200)
		const resized = await page.evaluate(async () => (await window.trackerApp.api('GET', `blocks?from=${Math.floor(new Date(2026, 10, 15).getTime() / 1000)}&to=${Math.floor(new Date(2026, 10, 16).getTime() / 1000)}`)).blocks.find((b) => b.title === 'Weekend writing'))
		assert.equal(new Date(resized.end * 1000).getHours(), 18)
		ok(`${locale}: drag the lower edge to make it longer`)

		// Move one weekday block: "this block only"
		await page.waitForTimeout(300)
		const wed = page.locator('.imp-cv__col').nth(2).locator('.imp-cv__ev:has-text("Thesis")')
		const wb = await wed.boundingBox()
		await page.mouse.move(wb.x + 20, wb.y + 10)
		await page.mouse.down()
		await page.mouse.move(wb.x + 20, wb.y + 10 + 4 * 48, { steps: 8 })
		await page.mouse.up()
		await page.waitForSelector('.imp-cvpanel__q')
		await page.screenshot({ path: `${shots}/cal-scope-${locale}.png` })
		await page.click('.imp-cvpanel .imp-button--primary')
		await page.waitForTimeout(250)
		const week = await page.evaluate(async () => (await window.trackerApp.api('GET', `blocks?from=${Math.floor(new Date(2026, 10, 9).getTime() / 1000)}&to=${Math.floor(new Date(2026, 10, 14).getTime() / 1000)}`)).blocks.filter((b) => b.commitmentId === 1).map((b) => `${new Date(b.start * 1000).getDate()}@${new Date(b.start * 1000).getHours()}`))
		assert.deepEqual(week, ['9@9', '10@9', '11@13', '12@9', '13@9'])
		ok(`${locale}: repeating block moved: "this block only"`)

		// Delete from the summary: all future ones
		await page.locator('.imp-cv__col').nth(3).locator('.imp-cv__ev:has-text("Thesis")').click()
		await page.click('.imp-cvpanel .imp-button--danger')
		await page.waitForSelector('.imp-cvpanel__q')
		await page.click('.imp-cvpanel__actions--stack .imp-button--danger')
		await page.waitForTimeout(250)
		const after = await page.evaluate(async () => (await window.trackerApp.api('GET', `blocks?from=${Math.floor(new Date(2026, 10, 9).getTime() / 1000)}&to=${Math.floor(new Date(2026, 10, 30).getTime() / 1000)}`)).blocks.filter((b) => b.commitmentId === 1 && b.title !== 'Weekend writing').map((b) => new Date(b.start * 1000).getDate()))
		assert.deepEqual(after, [9, 10, 11], 'from Thursday on: gone (the moved Wednesday stays)')
		ok(`${locale}: delete "all future blocks"`)

		// Edit the lecture: title, repeat, end date
		await page.locator('.imp-cv__ev:has-text("Lecture")').click()
		await page.click('.imp-cvpanel .imp-cvpanel__actions .imp-button:not(.imp-button--primary):not(.imp-button--danger)')
		await page.waitForSelector('.imp-cvpanel form')
		await page.fill('.imp-cvpanel input[type=text]', 'Lecture: Statistics')
		await page.selectOption('.imp-cvpanel select[aria-label]:below(:text("' + (it ? 'Ripeti' : 'Repeat') + '"))', 'weekly').catch(() => {})
		await page.click('.imp-cvpanel button[type=submit]')
		await page.waitForSelector('.imp-cvpanel__q')
		await page.click('.imp-cvpanel__actions--stack .imp-button:nth-child(2)') // all future
		await page.waitForSelector('.imp-cv__ev:has-text("Lecture: Statistics")')
		ok(`${locale}: edit a repeating block (all future)`)

		// Keys: → next week, T today, D day view, M month
		await page.locator('body').click({ position: { x: 5, y: 5 } })
		await page.keyboard.press('ArrowRight')
		await page.waitForFunction(() => /16/.test(document.querySelector('.imp-cv__dayhead .imp-cv__dn').textContent))
		await page.keyboard.press('t')
		await page.keyboard.press('d')
		await page.waitForFunction(() => document.querySelectorAll('.imp-cv__col').length === 1)
		await page.screenshot({ path: `${shots}/cal-day-${locale}.png` })
		await page.keyboard.press('m')
		await page.waitForSelector('.imp-cv__month')
		assert.equal(await page.locator('.imp-cv__mday').count(), 42)
		assert.ok(await page.locator('.imp-cv__mday.is-today .imp-cv__chip').count() >= 1)
		await page.screenshot({ path: `${shots}/cal-month-${locale}.png` })
		await page.locator('.imp-cv__mday.is-today .imp-cv__chip').first().click()
		await page.waitForSelector('.imp-cvpanel')
		await page.keyboard.press('Escape')
		ok(`${locale}: keys (← → T D W M), day and month views`)

		// Settings: the calendar choice
		await page.evaluate(() => { location.hash = '#settings' })
		await page.waitForSelector('.imp-calsource')
		assert.equal(await page.locator('.imp-calsource input[value=builtin]').isChecked(), true)
		assert.equal(await page.locator('.imp-clist select').count(), 0, 'no calendar picker with the built-in calendar')
		await page.locator('.imp-calsource input[value=apple]').check()
		await page.click('.imp-calsource button[type=submit]')
		await page.waitForTimeout(100)
		assert.ok((await page.evaluate(() => window.__calls)).includes('mode apple'))
		await page.locator('.imp-calsource').screenshot({ path: `${shots}/cal-settings-${locale}.png` })
		ok(`${locale}: Settings → Calendar: built-in or Apple Calendar`)

		assert.deepEqual(errors, [])
		await ctx.close()
	}
	await browser.close()
	console.log('\ncalendar page tests passed')
})().catch((e) => { console.error('✘', e); process.exit(1) })
