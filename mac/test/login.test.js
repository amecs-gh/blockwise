// The Nextcloud login: the page opens in your default browser (not a window of
// the app's own, which VPN and security apps can block); cancelling and logging
// in again at once keeps the new login going (the old one ends up to 2 s later).
// Stand-in Nextcloud login flow, no server.
// node test/login.test.js
const Module = require('node:module')
const http = require('node:http')
const path = require('node:path')
const assert = require('node:assert/strict')

Object.defineProperty(process, 'platform', { value: 'darwin' })
const mock = require('./mock-electron')
const origLoad = Module._load
Module._load = function (request, ...rest) { return request === 'electron' ? mock : origLoad.call(this, request, ...rest) }
const T = mock.__test
const ok = (n) => console.log('  ✔', n)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const EV = { senderFrame: { url: 'file://' + path.join(__dirname, '..', 'renderer', 'setup.html') } }

// Login flow v2 as Nextcloud answers it: each start gets its own token; access is granted per token
let flows = 0
const granted = new Set()
const server = http.createServer((req, res) => {
	let body = ''
	req.on('data', (c) => { body += c })
	req.on('end', () => {
		const base = `http://127.0.0.1:${server.address().port}`
		res.setHeader('Content-Type', 'application/json')
		if (req.url === '/index.php/login/v2') {
			const token = 'tok' + ++flows
			return res.end(JSON.stringify({ login: `${base}/login/v2/flow/${token}`, poll: { token, endpoint: `${base}/login/v2/poll` } }))
		}
		if (req.url === '/login/v2/poll') {
			const token = new URLSearchParams(body).get('token')
			if (!granted.has(token)) { res.statusCode = 404; return res.end('{}') }
			return res.end(JSON.stringify({ server: base, loginName: 'alice', appPassword: 'app-password-' + token }))
		}
		res.statusCode = 404
		res.end('{}')
	})
})

const opened = () => T.log.filter((l) => l.startsWith('openExternal')).map((l) => l.split(' ').pop())
const SETUP = { senderFrame: { url: EV.senderFrame.url } }

;(async () => {
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	const base = `http://127.0.0.1:${server.address().port}`
	require('../src/main.js')
	T.ready()
	await sleep(300)
	const windowsBefore = T.BrowserWindow.all.length

	// First login: the page opens in the browser, no window of the app's own
	const first = T.handlers.login(EV, base)
	await sleep(400)
	assert.deepEqual(opened(), [`${base}/login/v2/flow/tok1`])
	assert.ok(!T.BrowserWindow.all.slice(windowsBefore).some((w) => w.opts && w.opts.title === new URL(base).host), 'no login window')
	ok('login: Nextcloud\'s page opens in the default browser')

	// "Open the login page again": the same page
	await T.handlers.reopenLogin(SETUP)
	assert.deepEqual(opened().slice(-1), [`${base}/login/v2/flow/tok1`])
	ok('the login page can be opened again')

	// Cancel, and log in again right away (before the first login notices)
	await T.handlers.cancelLogin(EV)
	const second = T.handlers.login(EV, base)
	await sleep(400)
	assert.deepEqual(opened().slice(-1), [`${base}/login/v2/flow/tok2`])
	const r1 = await first
	assert.match(r1.error || '', /cancelled/i, 'the first login ends as cancelled')
	await sleep(2600) // the first login's last check is over by now
	await T.handlers.reopenLogin(SETUP)
	assert.deepEqual(opened().slice(-1), [`${base}/login/v2/flow/tok2`], 'the new login is still the current one')
	ok('cancel and log in again at once: the new login keeps going')

	// The second login finishes once access is granted
	granted.add('tok2')
	const r2 = await Promise.race([second, sleep(6000).then(() => ({ timeout: true }))])
	assert.ok(!r2.timeout, 'the login finished')
	assert.ok(T.log.some((l) => l.includes('fetch tracker-api') && l.includes('/login/v2/poll')))
	const st = await T.handlers.state(EV)
	assert.equal(st.data.provider, 'nextcloud')
	ok('access granted in the browser: logged in')

	server.close()
	console.log('\nlogin tests passed')
	process.exit(0)
})().catch((e) => { console.error('✘', e); process.exit(1) })
