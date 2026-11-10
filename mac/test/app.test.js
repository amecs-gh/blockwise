// Runs the real src/main.js (with a stand-in electron module) and the real
// windows in Chromium, against the local test Nextcloud.
const Module = require('node:module')
const path = require('node:path')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

Object.defineProperty(process, 'platform', { value: 'darwin' }) // behave like the Mac build
const mock = require('./mock-electron')
const origLoad = Module._load
Module._load = function (request, ...rest) { return request === 'electron' ? mock : origLoad.call(this, request, ...rest) }

const T = mock.__test
const SERVER = 'http://localhost:8080'
const shots = process.env.SHOTS || '/tmp/claude-0'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// IPC only works from the app's own pages
const fromFile = (file) => ({ senderFrame: { url: 'file://' + path.join(__dirname, '..', 'renderer', file) } })
const EV = fromFile('app.html')
const call = async (channel, ...args) => {
	const r = await T.handlers[channel](EV, ...args)
	if (r.error) throw new Error(`${channel}: ${r.error}`)
	return r.data
}
const step = (s) => console.log(`\n▶ ${s}`)

/** Open one of the app's windows in Chromium, bridged to the main process under test. */
async function openWindow(browser, file, winName, opts = {}) {
	const { dark = false, width = 360, height = 600, locale } = opts
	const page = await browser.newPage({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: 2, locale })
	const errors = []
	page.on('pageerror', (e) => errors.push(e.message))
	page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
	await page.exposeFunction('__invoke', async (channel, args) => T.handlers[channel](fromFile(file), ...args))
	await page.exposeFunction('__send', (channel, args) => T.listeners[channel] && T.listeners[channel](fromFile(file), ...args))
	await page.addInitScript(() => {
		const call = async (c, ...a) => { const r = await window.__invoke(c, a); if (r && r.error) throw new Error(r.error); return r ? r.data : undefined }
		window.trackerApp = {
			getState: () => call('state'), onState: (cb) => { window.__onState = cb }, api: (m, p, b) => call('api', m, p, b),
			refresh: () => call('refresh'), open: (v, h) => call('open', v, h), nav: (a) => call('nav', a), onNav: (cb) => { window.__onNav = cb },
			login: (s) => call('login', s), cancelLogin: () => call('cancelLogin'), connectDrive: (p) => call('connectDrive', p), unlockDrive: (x) => call('unlockDrive', x), useThisMac: () => call('useThisMac'), syncNow: () => call('syncNow'), menu: () => call('menu'), setHeight: (h) => window.__send('popover:height', [h]),
			openCalendar: (ts) => call('openCalendar', ts), onChanged: (cb) => { window.__onChanged = cb },
		}
	})
	await page.goto('file://' + path.join(__dirname, '..', 'renderer', file) + (opts.hash || ''))
	// Forward what main.js sends to this window (state, nav)
	let seen = 0
	const pump = setInterval(async () => {
		const msgs = T.sent.filter((m) => m.win === winName)
		for (const m of msgs.slice(seen)) {
			const fn = { state: '__onState', nav: '__onNav', changed: '__onChanged' }[m.channel]
			await page.evaluate(([f, p]) => window[f] && window[f](p), [fn, m.payload]).catch(() => {})
		}
		seen = msgs.length
	}, 200)
	page.on('close', () => clearInterval(pump))
	return { page, errors }
}

;(async () => {
	const browser = await chromium.launch()

	step('first run shows the setup window')
	require('../src/main.js')
	T.ready()
	await sleep(300)
	assert.ok(T.log.some((l) => l === 'loadFile win1 setup.html'), 'setup window')
	const setup = await openWindow(browser, 'setup.html', 'win1', { width: 480, height: 640 })
	await sleep(300)
	await setup.page.screenshot({ path: `${shots}/mac-setup.png` })
	const choices = await setup.page.locator('.u-choice strong').allInnerTexts()
	assert.deepEqual(choices, ['Nextcloud', 'This Mac only'], 'no drive keys in this build: Nextcloud and this Mac')
	await setup.page.click('.u-choice >> nth=0')
	assert.ok(await setup.page.isVisible('#server'))

	step('log in through the setup form; a "user" logs in and grants access')
	await setup.page.fill('#server', 'localhost:8080')
	await setup.page.click('#submit')
	let loginUrl
	for (let i = 0; i < 50 && !loginUrl; i++) { await sleep(100); loginUrl = (T.log.find((l) => l.includes('/login/v2/flow/')) || '').split(' ')[2] }
	assert.ok(loginUrl, 'login window opened at the flow URL')
	console.log('  login window:', loginUrl.replace(/flow\/.*/, 'flow/…'))
	assert.equal(await setup.page.isVisible('#waiting'), true)
	const user = await browser.newPage()
	await user.goto(loginUrl)
	await user.getByRole('button', { name: /log in/i }).first().click()
	await user.fill('input[name=user]', 'admin')
	await user.fill('input[name=password]', 'admin-test-pw-123')
	await user.locator('form button[type=submit], form input[type=submit]').first().click()
	await user.getByRole('button', { name: /grant access/i }).click({ timeout: 15000 })
	await user.close()
	for (let i = 0; i < 60 && !mock.Tray.last; i++) await sleep(200)
	assert.ok(mock.Tray.last, 'menu bar item created')

	const cfg = JSON.parse(fs.readFileSync(path.join(T.userData, 'config.json'), 'utf8'))
	assert.equal(cfg.server, SERVER)
	assert.equal(cfg.encrypted, true)
	assert.ok(!JSON.stringify(cfg).includes('admin-test-pw'), 'no plain password in config')
	console.log('  config saved, password encrypted:', cfg.encrypted)
	const appPassword = (await mock.safeStorage.decryptStringAsync(Buffer.from(cfg.appPassword, 'base64'))).result
	const auth = 'Basic ' + Buffer.from(`${cfg.loginName}:${appPassword}`).toString('base64')
	const mainWin = T.BrowserWindow.all.find((w) => w.file === 'app.html')
	assert.ok(mainWin, 'main window opened')
	console.log('  main window: app.html, vibrancy', mainWin.opts.vibrancy)

	step('security: what the windows may ask the app to do')
	const rejects = async (args, ev = EV) => (await T.handlers.api(ev, ...args)).error
	assert.equal(await rejects(['GET', '../../../remote.php/dav/files/admin']), 'Invalid request.')
	assert.equal(await rejects(['GET', 'tasks/1/../../../../ocs/v2.php/cloud/user']), 'Invalid request.')
	assert.equal(await rejects(['PROPFIND', 'tasks']), 'Invalid request.')
	assert.equal(await rejects(['POST', 'tasks', 'not an object']), 'Invalid request.')
	assert.equal(await rejects(['GET', 'state'], { senderFrame: { url: 'https://evil.example/' } }), 'Not allowed.')
	assert.equal((await T.handlers.state({ senderFrame: { url: 'https://evil.example/' } })).error, 'Not allowed.')
	assert.equal((await T.handlers.state({})).error, 'Not allowed.')
	console.log('  other Nextcloud endpoints, odd methods and foreign pages are refused')
	assert.ok(T.log.some((l) => l.startsWith('fetch tracker-api ')), 'requests use the in-memory session')
	assert.ok(T.log.includes('clearStorageData tracker-login'), 'login session cleared after login')
	assert.ok(fs.statSync(path.join(T.userData, 'config.json')).mode.toString(8).endsWith('600'), 'config readable by you only')
	console.log('  requests in a memory-only session; login cookies cleared; config.json is 600')
	{
		const wc = mainWin.webContents
		const before = T.log.filter((l) => l.startsWith('openExternal')).length
		for (const u of ['file:///System/Applications/Calculator.app', 'smb://evil/share', 'x-apple.systempreferences:', 'javascript:alert(1)']) wc.openHandler({ url: u })
		assert.equal(T.log.filter((l) => l.startsWith('openExternal')).length, before, 'no file:/app links opened')
		assert.equal(wc.openHandler({ url: 'https://nextcloud.com/' }).action, 'deny')
		assert.ok(T.log.includes('openExternal https://nextcloud.com/'))
		let prevented = false
		wc.emit('will-navigate', { preventDefault: () => { prevented = true } }, 'https://evil.example/')
		assert.ok(prevented, 'the window never navigates away')
		const ses = T.sessions['(default)']
		let granted = null
		ses.permReq(null, 'media', (g) => { granted = g })
		assert.equal(granted, false, 'camera/microphone requests denied')
		console.log('  only https/http links open (in the browser); no navigation; permissions denied')
	}

	step('main window: Tracker interface through the app, every page')
	const win = await openWindow(browser, 'app.html', mainWin.name, { width: 1240, height: 820, hash: '#now' })
	await win.page.waitForSelector('.imp-col, .imp-empty', { timeout: 15000 })
	const firstId = (await call('api', 'GET', 'state')).commitments[0].id
	for (const pg of ['now', 'tasks', 'done', 'time', 'settings', 'c/' + firstId]) {
		await win.page.evaluate((h) => { location.hash = h }, '#' + pg)
		await win.page.waitForTimeout(1200)
		const ok = await win.page.evaluate(() => !!document.querySelector('.imp-page') && !document.querySelector('.imp-empty')?.textContent.includes('could not be loaded'))
		assert.ok(ok, `page ${pg}`)
		await win.page.screenshot({ path: `${shots}/mac-win-${pg.replace('/', '')}.png` })
		console.log('  ', pg, 'ok')
	}
	assert.ok(await win.page.evaluate((id) => !!document.querySelector('.imp-stats') && !!document.querySelector('.imp-nav a.active[href="#c/' + id + '"]'), firstId), 'commitment page with stats, sidebar link active')
	const bars = await win.page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 2 && e.offsetWidth - e.clientWidth > 0).length)
	assert.equal(bars, 0, 'no visible scrollbars')
	assert.ok(await win.page.evaluate(() => !!document.querySelector('.imp-nav a[href="#"]')), 'Calendar entry in the sidebar')
	// Smaller windows: the layout adapts, nothing spills out sideways
	for (const [w, hgt] of [[820, 640], [560, 520], [420, 400]]) {
		await win.page.setViewportSize({ width: w, height: hgt })
		for (const pg of ['now', 'tasks']) {
			await win.page.evaluate((x) => { location.hash = x }, '#' + pg); await win.page.waitForTimeout(900)
			const overflow = await win.page.evaluate(() => { const m = document.querySelector('.imp-main'); return m.scrollWidth - m.clientWidth })
			assert.ok(overflow <= 1, `no sideways scrolling on ${pg} at ${w}px (${overflow})`)
			await win.page.screenshot({ path: `${shots}/mac-win-${pg}-${w}.png` })
		}
		console.log(`   ${w}×${hgt} ok`)
	}
	await win.page.setViewportSize({ width: 1240, height: 820 })

	step('"Calendar" opens Apple Calendar')
	await win.page.click('.imp-nav a[href="#"]')
	await sleep(500)
	assert.ok(T.log.some((l) => l.includes('openPath /System/Applications/Calendar.app')))
	console.log('  ->', T.log.filter((l) => l.startsWith('openPath')).pop())

	step('menu bar panel')
	await call('api', 'POST', 'sessions/stop', {}).catch(() => {})
	T.Tray.last.emit('click')
	await sleep(1500)
	const pop = T.BrowserWindow.all.find((w) => w.file === 'popover.html')
	assert.ok(pop && pop.visible, 'popover shown')
	console.log('  positioned at', JSON.stringify(pop.pos))
	const panel = await openWindow(browser, 'popover.html', pop.name)
	await panel.page.waitForSelector('.p-timer')
	await sleep(400)
	await panel.page.screenshot({ path: `${shots}/mac-popover-idle.png`, fullPage: true })
	const h0 = pop.size[1]
	console.log('  panel height follows content:', h0)

	step('start tracking from the panel; the menu bar shows the time')
	await panel.page.locator('.p-row .p-play').first().click()
	await sleep(2500)
	const state = await call('state')
	assert.ok(state.dash.running, 'tracking started')
	assert.match(T.Tray.last.title, /^\d:\d\d:\d\d$/)
	console.log('  menu bar title:', JSON.stringify(T.Tray.last.title), 'tracking', state.dash.commitments.find((e) => e.commitment.id === state.dash.running.commitmentId).commitment.name)
	await panel.page.waitForSelector('.p-timer:not(.is-idle)')
	await sleep(300)

	step('check a subtask and add one from the panel')
	const before = (await call('state')).dash
	const box = panel.page.locator('.p-block input[type=checkbox]:not(:checked)').first()
	const label = await box.locator('xpath=..').innerText()
	await box.check()
	await sleep(1500)
	const after = (await call('state')).dash
	const findSub = (d) => d.commitments.flatMap((e) => e.queue).flatMap((t) => t.subtasks).find((s) => s.title === label.split('\n')[0])
	console.log('  checked:', label.split('\n')[0], '->', findSub(after) ? findSub(after).done : '(task finished, left the queue)')
	await panel.page.fill('.p-add__input', 'Reply to reviewer 25m')
	await panel.page.press('.p-add__input', 'Enter')
	await sleep(1800)
	const added = (await call('state')).dash.commitments.flatMap((e) => e.queue).flatMap((t) => t.subtasks).find((s) => s.title === 'Reply to reviewer')
	assert.ok(added, 'subtask added')
	assert.equal(added.estimate, 25)
	console.log('  added: Reply to reviewer, estimate', added.estimate)
	await panel.page.screenshot({ path: `${shots}/mac-popover-running.png`, fullPage: true })
	const darkPanel = await openWindow(browser, 'popover.html', pop.name, { dark: true })
	await darkPanel.page.waitForSelector('.p-timer'); await sleep(400)
	await darkPanel.page.screenshot({ path: `${shots}/mac-popover-dark.png`, fullPage: true })

	step('changes in the panel reach the open window')
	assert.ok(T.sent.some((m) => m.win === mainWin.name && m.channel === 'changed'), 'window told to reload')
	await win.page.evaluate(() => { location.hash = '#now' }); await sleep(1500)
	assert.ok(await win.page.evaluate(() => !!document.querySelector('.imp-timer:not(.imp-timer--idle)')), 'window shows the running timer')
	await win.page.screenshot({ path: `${shots}/mac-win-now-running.png` })
	const darkWin = await openWindow(browser, 'app.html', mainWin.name, { width: 1240, height: 820, dark: true, hash: '#now' })
	await darkWin.page.waitForSelector('.imp-col'); await sleep(800)
	await darkWin.page.screenshot({ path: `${shots}/mac-win-now-dark.png` })
	const itWin = await openWindow(browser, 'app.html', mainWin.name, { width: 1240, height: 820, locale: 'it-IT', hash: '#now' })
	await itWin.page.waitForSelector('.imp-col'); await sleep(800)
	assert.ok((await itWin.page.innerText('.imp-nav')).includes('Adesso'), 'Italian window')
	await itWin.page.screenshot({ path: `${shots}/mac-win-now-it.png` })
	console.log('  ok (also dark and Italian)')

	step('stop from the panel, open the windows from its footer')
	await panel.page.click('.p-stop')
	await sleep(1500)
	assert.equal((await call('state')).dash.running, null)
	assert.equal(T.Tray.last.title, '')
	await panel.page.click('.p-footer .p-link:nth-child(2)')
	await sleep(300)
	assert.ok(T.log.filter((l) => l.startsWith('openPath')).length >= 2, 'Open Calendar from the panel')
	console.log('  stopped; "Open Calendar" opens Apple Calendar')

	step('Italian')
	process.env.TEST_LOCALE = 'it-IT'
	const it = await openWindow(browser, 'popover.html', pop.name)
	await it.page.waitForSelector('.p-timer'); await sleep(300)
	const itText = await it.page.innerText('body')
	assert.ok(itText.includes('Nessuna registrazione') && itText.includes('Apri Calendario'))
	await it.page.screenshot({ path: `${shots}/mac-popover-it.png`, fullPage: true })
	process.env.TEST_LOCALE = ''
	console.log('  ok')

	step('close the main window: dock icon hides, app keeps running')
	mainWin.destroy()
	assert.ok(T.log.includes('dock hide'))
	await call('open', 'tracker')
	assert.ok(T.BrowserWindow.all.filter((w) => w.file === 'app.html').length === 2, 'reopened')

	step('changes made on this Mac reach Nextcloud')
	await call('syncNow')
	assert.equal((await call('state')).sync.pending, 0, 'nothing left to send')
	const serverDash = await (await fetch(`${SERVER}/index.php/apps/tracker/api/dashboard`, { headers: { Authorization: auth, 'OCS-APIRequest': 'true' } })).json()
	assert.ok(JSON.stringify(serverDash).includes('Reply to reviewer'), 'the subtask added on this Mac is on the server')
	console.log('  synced: the new subtask is on the server')

	step('log out: password revoked on the server, back to setup')
	const pw = cfg.appPassword
	await call('menu')
	mock.Tray.last.popUpContextMenu = (m) => { T.lastMenu = m }
	await call('menu')
	console.log('  menu:', T.lastMenu.items.map((i) => i.label || '—').join(' | '))
	T.lastMenu.items.find((i) => i.label === 'Log out').click()
	await sleep(1500)
	assert.ok(!fs.existsSync(path.join(T.userData, 'config.json')), 'config removed')
	const revoked = await fetch(`${SERVER}/index.php/apps/tracker/api/state`, { headers: { Authorization: auth, 'OCS-APIRequest': 'true' } })
	assert.equal(revoked.status, 401)
	assert.ok(T.log.filter((l) => l.endsWith('setup.html')).length === 2, 'setup shown again')
	console.log('  revoked (HTTP', revoked.status + '), setup shown again')

	const allErrors = [setup, win, panel, darkPanel, it, darkWin, itWin].flatMap((w) => w.errors)
	assert.deepEqual(allErrors, [], 'no errors in the windows')
	console.log('\n✔ all app tests passed; notifications sent:', T.log.filter((l) => l.startsWith('NOTIFY')).length)
	await browser.close()
	process.exit(0)
})().catch((e) => { console.error('\n✘ FAILED:', e.message); console.error(T.log.slice(-15).join('\n')); process.exit(1) })
