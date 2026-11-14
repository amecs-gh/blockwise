// The real src/main.js with OneDrive (a stand-in Microsoft): connected, then
// Settings → "Blocks in Outlook": Outlook asked for with a second login (the same
// account only), a calendar per commitment, the built-in blocks moved there,
// planned there, and back. node test/cloudmode.test.js
process.env.TZ = 'UTC'
const Module = require('node:module')
const path = require('node:path')
const fs = require('node:fs')
const assert = require('node:assert/strict')

Object.defineProperty(process, 'platform', { value: 'darwin' })
const mock = require('./mock-electron')
const origLoad = Module._load
Module._load = function (request, ...rest) { return request === 'electron' ? mock : origLoad.call(this, request, ...rest) }
const T = mock.__test
const ok = (n) => console.log('  ✔', n)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const from = (name) => ({ senderFrame: { url: 'file://' + path.join(__dirname, '..', 'renderer', name) } })
const call = async (channel, page, ...args) => {
	const r = await T.handlers[channel](from(page), ...args)
	if (r.error) throw Object.assign(new Error(r.error), { status: r.status })
	return r.data
}

const keysFile = path.join(__dirname, '..', 'config', 'providers.json')
const savedKeys = fs.existsSync(keysFile) ? fs.readFileSync(keysFile) : null
const restore = () => { if (savedKeys) fs.writeFileSync(keysFile, savedKeys); else fs.rmSync(keysFile, { force: true }) }
fs.writeFileSync(keysFile, JSON.stringify({ microsoftClientId: '00000000-0000-4000-8000-000000000001' }))

;(async () => {
	const { microsoft, EP } = require('./onedrive.test.js')
	const ms = microsoft()
	const drives = require('../src/drives')
	Object.assign(drives.MICROSOFT, EP)
	const realFetch = globalThis.fetch
	globalThis.fetch = (u, o) => (/^https:\/\/(login|graph|files)\.test\//.test(String(u)) ? ms.fetch(String(u), o) : realFetch(u, o))
	const opened = []
	mock.shell.openExternal = async (u) => { opened.push(u); await ms.browser([])(u) }
	// (the page asks before switching)
	require('../src/main.js')
	T.ready()
	await sleep(300)
	const s = await call('state', 'setup.html')
	assert.ok(s.providers.includes('onedrive'), 'offered with its client id')

	assert.deepEqual(await call('connectDrive', 'setup.html', 'onedrive'), { exists: false, encrypted: true })
	assert.equal(new URL(opened[0]).searchParams.get('scope'), 'offline_access Files.ReadWrite.AppFolder', 'the app folder only')
	await call('unlockDrive', 'setup.html', 'correct horse battery staple')
	await sleep(1200)
	assert.equal((await call('state', 'app.html')).provider, 'onedrive')
	assert.ok(ms.folder.has('blockwise.json'), 'the sync folder in OneDrive')
	ok('OneDrive connected: the app folder only, encrypted')

	const c = await call('api', 'app.html', 'POST', 'commitments', { name: 'Thesis', color: '#3b6fd8' })
	const day = Math.floor(Date.UTC(2026, 10, 16) / 1000)
	await call('api', 'app.html', 'POST', 'blocks', { commitmentId: c.id, title: 'Write', start: day + 9 * 3600, end: day + 11 * 3600, repeat: 'weekly' })
	let info = await call('accountCalendar', 'app.html')
	assert.deepEqual(info, { provider: 'microsoft', home: 'builtin', allowed: false, used: false, waiting: 0 })
	assert.equal((await T.handlers.useAccountCalendar(from('popover.html'), true)).error, 'Not allowed.', 'only from the main window')

	const r = await call('useAccountCalendar', 'app.html', true)
	assert.equal(r.copied, 1)
	assert.match(new URL(opened.at(-1)).searchParams.get('scope'), /Calendars\.ReadWrite/, 'Outlook asked for now')
	info = await call('accountCalendar', 'app.html')
	assert.equal(info.home, 'microsoft')
	assert.equal(info.used, true)
	const [calId] = [...ms.graph.cals.keys()]
	assert.equal(ms.graph.cals.get(calId).name, 'Thesis')
	assert.equal(ms.marks.get(calId).value, 'blockwise')
	for (let i = 0; i < 30 && !ms.graph.events(calId).length; i++) await sleep(100)
	const ev = ms.graph.events(calId)[0]
	assert.equal(ev.subject, 'Write')
	assert.equal(ev.recurrence.pattern.type, 'weekly')
	ok('"Blocks in Outlook": a second login for Outlook, a marked calendar per commitment, the blocks moved there')

	const get = () => call('api', 'app.html', 'GET', `blocks?from=${day}&to=${day + 14 * 86400}`)
	await get()
	await sleep(300)
	let blocks = (await get()).blocks
	assert.equal(blocks.length, 2, 'read back from Outlook (two weeks)')
	await call('api', 'app.html', 'POST', 'blocks', { commitmentId: c.id, title: 'Planned on the Mac', start: day + 86400 + 14 * 3600, end: day + 86400 + 15 * 3600 })
	for (let i = 0; i < 30 && !ms.graph.events(calId).some((e) => e.subject === 'Planned on the Mac'); i++) await sleep(100)
	assert.ok(ms.graph.events(calId).some((e) => e.subject === 'Planned on the Mac'), 'planned here, in Outlook')
	const cfgText = fs.readFileSync(path.join(T.userData, 'config.json'), 'utf8')
	const cfg = JSON.parse(cfgText)
	assert.equal(cfg.driveCalendar, true)
	assert.deepEqual(cfg.outlookCalendars, [calId])
	assert.ok(!/ref-/.test(cfgText), 'no refresh token in plain text')
	const sealed = (await mock.safeStorage.decryptStringAsync(Buffer.from(cfg.driveToken, 'base64'))).result
	assert.ok(ms.refresh.has(sealed), 'the newest (rotated) refresh token kept')
	ok('planned on the Mac: in Outlook; the rotated token kept, sealed')

	const back = await call('useAccountCalendar', 'app.html', false)
	assert.ok(back.copied >= 2)
	info = await call('accountCalendar', 'app.html')
	assert.equal(info.home, 'builtin')
	assert.equal(info.used, false)
	blocks = (await get()).blocks
	assert.ok(blocks.some((b) => b.title === 'Planned on the Mac') && blocks.some((b) => b.title === 'Write'), 'copied into Blockwise')
	ok('and back: Outlook\'s events copied into the built-in calendar')
	restore()
	console.log('\nall account calendar tests passed')
	process.exit(0)
})().catch((e) => { console.error('✘', e); restore(); process.exit(1) })
