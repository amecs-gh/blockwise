'use strict'
/**
 * Logging in to Dropbox and Google in your browser (OAuth 2 with PKCE, RFC 7636
 * and RFC 8252): the app opens the provider's page, you log in there (the app
 * never sees your password), and the provider sends a one-time code back to a
 * small server on this Mac (127.0.0.1 only). The code is useless without the
 * secret only the app knows (the PKCE verifier), and the `state` value makes
 * sure the answer belongs to this login.
 *
 * No Electron imports: tested in plain Node.
 */
const http = require('node:http')
const crypto = require('node:crypto')

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function pkce() {
	const verifier = b64url(crypto.randomBytes(32))
	const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
	return { verifier, challenge }
}

const PAGE = (title, text) => `<!doctype html><html><head><meta charset="utf-8"><title>Blockwise</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0;color:#1d1d1b;background:#fafaf7}main{text-align:center;max-width:28em}h1{font-size:22px}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`

/**
 * Waits for the provider's answer on http://127.0.0.1:<port><path>.
 * @param {object} o
 * @param {number} o.port 0 = any free port
 * @param {string} o.path e.g. "/dropbox"
 * @param {string} [o.host] in the address given to the provider ("localhost" for Microsoft); the server is on 127.0.0.1 either way
 * @param {(redirectUri: string, state: string) => string} o.authorizeUrl the provider's login page
 * @param {(url: string) => void} o.openBrowser
 * @param {number} [o.timeoutMs] 5 minutes
 * @return {Promise<{code: string, redirectUri: string}>} and .cancel()
 */
function waitForCode(o) {
	const state = b64url(crypto.randomBytes(24))
	let server
	let timer
	let settle
	const done = new Promise((resolve, reject) => {
		settle = (err, value) => {
			clearTimeout(timer)
			if (server) server.close()
			server = null
			if (err) reject(err)
			else resolve(value)
		}
	})
	server = http.createServer((req, res) => {
		let url
		try { url = new URL(req.url, 'http://127.0.0.1') } catch (e) { res.writeHead(400).end(); return }
		if (req.method !== 'GET' || url.pathname !== o.path) { res.writeHead(404).end(); return }
		res.setHeader('Content-Type', 'text/html; charset=utf-8')
		res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
		res.setHeader('Cache-Control', 'no-store')
		// Someone else's answer (or a page trying its luck): ignored, the login goes on
		if (url.searchParams.get('state') !== state) { res.writeHead(400).end(PAGE('Not this login', 'You can close this tab.')); return }
		if (url.searchParams.get('error')) {
			res.writeHead(200).end(PAGE('Not connected', 'You can close this tab and try again in Blockwise.'))
			settle(Object.assign(new Error('The connection was not allowed.'), { code: 'denied' }))
			return
		}
		const code = url.searchParams.get('code')
		if (!code || code.length > 2048) { res.writeHead(400).end(); return }
		res.writeHead(200).end(PAGE('Connected', 'Blockwise is connected. You can close this tab.'))
		settle(null, { code, redirectUri })
	})
	let redirectUri = null
	server.on('error', (e) => settle(Object.assign(new Error(e.code === 'EADDRINUSE' ? `Port ${o.port} on this Mac is in use; close the app using it and try again.` : e.message), { code: 'port' })))
	server.listen(o.port || 0, '127.0.0.1', () => {
		redirectUri = o.host === 'localhost' ? `http://localhost:${server.address().port}${o.path === '/' ? '' : o.path}` : `http://127.0.0.1:${server.address().port}${o.path}`
		timer = setTimeout(() => settle(Object.assign(new Error('The login took too long. Try again.'), { code: 'timeout' })), o.timeoutMs || 5 * 60 * 1000)
		o.openBrowser(o.authorizeUrl(redirectUri, state))
	})
	done.cancel = () => settle(Object.assign(new Error('Cancelled.'), { code: 'cancelled' }))
	return done
}

module.exports = { pkce, waitForCode, b64url }
