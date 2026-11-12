// The Nextcloud login window: cancelling and logging in again at once must not
// close the new window (the old login ends up to 2 s later and used to clean up
// whatever window was open by then). Stand-in Nextcloud login flow, no server.
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

;(async () => {
	await new Promise((r) => server.listen(0, '127.0.0.1', r))
	const base = `http://127.0.0.1:${server.address().port}`
	require('../src/main.js')
	T.ready()
	await sleep(300)
	const loginWindows = () => T.BrowserWindow.all.filter((w) => w.opts && w.opts.title === new URL(base).host)

	// First login: a window opens
	const first = T.handlers.login(EV, base)
	await sleep(400)
	assert.equal(loginWindows().length, 1)
	const w1 = loginWindows()[0]
	assert.ok(!w1.isDestroyed() && w1.isVisible(), 'the login window is open and shown')
	ok('login: the window opens')

	// Cancel, and log in again right away (before the first login notices)
	await T.handlers.cancelLogin(EV)
	assert.ok(w1.isDestroyed())
	const second = T.handlers.login(EV, base)
	await sleep(400)
	const w2 = loginWindows()[1]
	assert.ok(w2 && !w2.isDestroyed(), 'the second window opened')
	const r1 = await first
	assert.match(r1.error || '', /cancelled/i, 'the first login ends as cancelled')
	await sleep(2600) // the first login's last check is over by now
	assert.ok(!w2.isDestroyed(), 'the new window is still open')
	ok('cancel and log in again at once: the new window stays open')

	// The second login still works
	granted.add('tok2')
	for (let i = 0; i < 40 && !w2.isDestroyed(); i++) await sleep(100)
	assert.ok(w2.isDestroyed(), 'closed once access was granted')
	assert.ok(T.log.some((l) => l.includes('fetch tracker-api') && l.includes('/login/v2/poll')))
	await Promise.race([second, sleep(3000)])
	ok('access granted: the second login finishes and closes its window')

	server.close()
	console.log('\nlogin tests passed')
	process.exit(0)
})().catch((e) => { console.error('✘', e); process.exit(1) })
