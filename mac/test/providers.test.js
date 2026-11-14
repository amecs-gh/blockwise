// The real src/main.js with "This Mac only", then Dropbox (stand-in server):
// data made offline comes along, the passphrase steps, secrets only sealed,
// disconnecting forgets everything. node test/providers.test.js
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
const EV = { senderFrame: { url: 'file://' + path.join(__dirname, '..', 'renderer', 'setup.html') } }
const call = async (channel, ...args) => {
	const r = await T.handlers[channel](EV, ...args)
	if (r.error) throw Object.assign(new Error(r.error), { status: r.status })
	return r.data
}

// This build's app keys (the real file is put back afterwards)
const keysFile = path.join(__dirname, '..', 'config', 'providers.json')
const savedKeys = fs.existsSync(keysFile) ? fs.readFileSync(keysFile) : null
const restore = () => { if (savedKeys) fs.writeFileSync(keysFile, savedKeys); else fs.rmSync(keysFile, { force: true }) }
fs.writeFileSync(keysFile, JSON.stringify({ dropboxAppKey: 'dbxtestkey12', googleClientId: '', googleClientSecret: '' }))

;(async () => {
	const { provider } = require('./drives.test.js')
	const p = provider()
	await new Promise((r) => p.server.listen(0, '127.0.0.1', r))
	const base = `http://127.0.0.1:${p.server.address().port}`
	const drives = require('../src/drives')
	Object.assign(drives.DROPBOX, { authorize: `${base}/authorize`, token: `${base}/token`, api: `${base}/2`, content: `${base}/2`, port: 0 })
	// "The browser": you allow Blockwise on the provider's page
	mock.shell.openExternal = async (u) => {
		const back = (await fetch(u, { redirect: 'manual' })).headers.get('location')
		await fetch(back)
	}

	require('../src/main.js')
	T.ready()
	await sleep(300)
	let s = await call('state')
	assert.deepEqual(s.providersReady, { dropbox: true, gdrive: false, onedrive: false }, 'Google and Microsoft not set up in this build')
	assert.deepEqual(s.providers, ['nextcloud', 'local', 'dropbox'], 'a drive without its app key is not offered')
	assert.match((await T.handlers.connectDrive(EV, 'gdrive')).error, /Set up/)

	console.log('This Mac only')
	// Data sealed with a Keychain key that was deleted since (same account as before)
	fs.mkdirSync(T.userData, { recursive: true })
	fs.writeFileSync(path.join(T.userData, 'owner'), 'local')
	fs.writeFileSync(path.join(T.userData, 'data.bin'), Buffer.from('sealed with the old key').toString('base64'))
	await call('useThisMac')
	await sleep(200)
	assert.ok(T.log.some((l) => l.includes('Blockwise could not open its data on this Mac')), 'told what happened')
	assert.ok(fs.readdirSync(T.userData).some((f) => /^data\.unreadable-.*\.bin$/.test(f)), 'the old file is kept, under another name')
	ok('data from a deleted Keychain key: set aside, the app starts (no error)')
	s = await call('state')
	assert.equal(s.provider, 'local')
	assert.equal(s.sync.pending >= 0, true)
	const c = await call('api', 'POST', 'commitments', { name: 'Made offline', color: '#336699' })
	await call('api', 'POST', 'tasks', { commitmentId: c.id, title: 'Write intro' })
	await sleep(300)
	const dataFile = path.join(T.userData, 'data.bin')
	assert.ok(fs.existsSync(dataFile))
	assert.ok(!fs.readFileSync(dataFile, 'utf8').includes('Made offline'), 'data on disk is sealed with the Keychain key')
	assert.ok(fs.statSync(dataFile).mode.toString(8).endsWith('600'))
	ok('works without any sync; data sealed on disk (600)')

	const menu = async () => { mock.Tray.last.popUpContextMenu = (m) => { T.lastMenu = m }; await call('menu') }
	await menu()
	const labels = T.lastMenu.items.map((i) => i.label)
	assert.ok(labels.includes('Your data is on this Mac only') && !labels.includes('Sync now'))
	T.lastMenu.items.find((i) => i.label === 'Sync with Nextcloud or a drive…').click()
	await sleep(500)
	assert.ok(fs.existsSync(dataFile), 'the data stays for the next choice')
	ok('"Sync with Nextcloud or a drive…" goes back to the choice, data kept')

	console.log('Dropbox')
	const first = await call('connectDrive', 'dropbox')
	assert.deepEqual(first, { exists: false, encrypted: true }, 'a new sync folder')
	await assert.rejects(call('unlockDrive', 'short'), /at least 8/)
	await call('unlockDrive', 'correct horse battery staple')
	await sleep(1500)
	s = await call('state')
	assert.equal(s.provider, 'dropbox')
	assert.match(s.host, /Dropbox/)
	assert.equal(s.sync.pending, 0, 'everything sent')
	assert.ok(p.box.has('blockwise.json') && [...p.box.keys()].some((n) => n.startsWith('log-')))
	for (const [n, b] of p.box) assert.ok(!b.toString('latin1').includes('Made offline'), `${n} encrypted`)
	ok('connected; what was made offline is on Dropbox, encrypted')
	{
		const fromWindow = { senderFrame: { url: 'file://' + path.join(__dirname, '..', 'renderer', 'app.html') } }
		assert.equal((await T.handlers.useThisMac(fromWindow)).error, 'Not allowed.')
		assert.equal((await T.handlers.useThisMac(EV)).error, 'Not allowed.', 'not while connected')
		assert.equal((await T.handlers.connectDrive(EV, 'dropbox')).error, 'Not allowed.')
		assert.equal((await T.handlers.login(EV, 'evil.example')).error, 'Not allowed.')
		ok('while connected, no window can switch the sync (or wipe the data)')
	}

	const cfgText = fs.readFileSync(path.join(T.userData, 'config.json'), 'utf8')
	const cfg = JSON.parse(cfgText)
	assert.equal(cfg.provider, 'dropbox')
	assert.ok(cfg.driveToken && cfg.syncKey)
	assert.ok(!/ref-|correct horse/.test(cfgText), 'no token or passphrase in plain text')
	const opened = (await mock.safeStorage.decryptStringAsync(Buffer.from(cfg.syncKey, 'base64'))).result
	assert.equal(Buffer.from(opened, 'base64').length, 32, 'only the derived key is kept (sealed), never the passphrase')
	assert.ok(!fs.readdirSync(T.userData).some((f) => fs.readFileSync(path.join(T.userData, f)).includes('correct horse')), 'the passphrase is nowhere on disk')
	ok('drive token and sync key only sealed with the Keychain; passphrase not stored')

	// Another Mac with the same Dropbox: opens the folder with the passphrase
	{
		const FS = require('../renderer/web/filesync.js')
		const store = drives.dropboxStore({ appKey: 'dbxtestkey12', refreshToken: [...p.refresh.keys()][0], fetch, endpoints: drives.DROPBOX })
		await assert.rejects(FS.unlock(store, 'wrong horse battery staple'), /Wrong passphrase/)
		const { createEngine } = require('../renderer/web/engine.js')
		const key = await FS.unlock(store, 'correct horse battery staple')
		let mem = null
		let remote
		const other = await createEngine({ storage: { load: async () => mem, save: async (d) => { mem = JSON.parse(JSON.stringify(d)) } }, calendar: { calendars: async () => [], events: async () => [] }, remote: { pull: (a, b) => remote.pull(a, b), push: (r) => remote.push(r) } })
		remote = await FS.createRemote({ store, key, node: other.node(), state: { load: async () => null, save: async () => {} } })
		await other.sync()
		const st = await other.api('GET', 'state')
		assert.ok(st.commitments.some((x) => x.name === 'Made offline'))
		const tasks = await other.api('GET', `tasks?commitmentId=${st.commitments.find((x) => x.name === 'Made offline').id}`)
		assert.equal(tasks[0].title, 'Write intro')
		await other.api('POST', 'commitments', { name: 'From the other Mac', color: '#993366' })
		await other.sync()
	}
	await call('syncNow')
	await sleep(300)
	assert.ok((await call('api', 'GET', 'state')).commitments.some((x) => x.name === 'From the other Mac'))
	ok('another Mac opens the folder with the passphrase; changes go both ways')

	await menu()
	assert.ok(T.lastMenu.items.some((i) => i.label === 'Syncing with Dropbox, end-to-end encrypted'))
	mock.dialog.response = 1 // disconnect and remove
	T.lastMenu.items.find((i) => i.label === 'Log out or switch sync…').click()
	await sleep(1000)
	assert.ok(!fs.existsSync(path.join(T.userData, 'config.json')))
	assert.ok(!fs.existsSync(dataFile), 'data on this Mac removed (it is on Dropbox)')
	assert.equal(p.refresh.size, 0, 'token revoked at Dropbox')
	assert.ok(p.box.has('blockwise.json'), 'the folder on Dropbox stays')
	ok('disconnect: token revoked, secrets and data removed from this Mac, folder stays')

	// Connecting again: the folder exists, so only the passphrase is asked
	assert.deepEqual(await call('connectDrive', 'dropbox'), { exists: true, encrypted: true })
	await assert.rejects(call('unlockDrive', 'wrong horse battery staple'), /Wrong passphrase/)
	await call('unlockDrive', 'correct horse battery staple')
	await sleep(1500)
	assert.ok((await call('api', 'GET', 'state')).commitments.some((x) => x.name === 'From the other Mac'))
	ok('connecting again: wrong passphrase refused; the right one brings everything back')

	console.log('Switching, data taken along')
	const st0 = await call('api', 'GET', 'state')
	assert.equal(st0.features.builtinCalendar, true, 'the built-in calendar until you choose Apple Calendar')
	assert.ok(!T.log.some((l) => /blockwise-calendar|access/.test(l) && /helper/.test(l)), 'macOS was never asked for calendar access')
	const top = T.appMenu.items[0].submenu.map((i) => i.label)
	assert.ok(top.includes('Log out or switch sync…') && top.includes('Sync now'), 'also in the Blockwise menu at the top')
	mock.dialog.response = 0 // switch and take my data
	await menu()
	T.lastMenu.items.find((i) => i.label === 'Log out or switch sync…').click()
	await sleep(1000)
	assert.ok(fs.existsSync(dataFile), 'data kept')
	assert.ok(!fs.existsSync(path.join(T.userData, 'config.json')))
	await call('useThisMac')
	await sleep(300)
	const st1 = await call('api', 'GET', 'state')
	assert.ok(st1.commitments.some((x) => x.name === 'From the other Mac') && st1.commitments.some((x) => x.name === 'Made offline'))
	ok('"Switch and take my data": Dropbox → this Mac only, everything kept')

	p.server.close()
	restore()
	console.log('\nall provider tests passed')
	process.exit(0)
})().catch((e) => { restore(); console.error('✘', e); console.error(T.log.slice(-12).join('\n')); process.exit(1) })
