'use strict'
/**
 * Talking to Nextcloud: login flow v2 (gives an app password) and the Blockwise API.
 * No Electron imports, so this file runs (and is tested) in plain Node.
 * `fetch` is passed in: Electron's net.fetch in the app, global fetch in tests.
 */

const USER_AGENT = 'Blockwise for Mac'

const isLoopback = (host) => /^(localhost|127(\.\d+){3}|\[::1\])$/i.test(host)
/** Tailscale addresses (100.64.0.0/10) and MagicDNS names: the tunnel itself is encrypted */
const isTailnet = (host) => /\.ts\.net$/i.test(host) || (/^100\.(\d+)\.\d+\.\d+$/.test(host) && Number(host.split('.')[1]) >= 64 && Number(host.split('.')[1]) <= 127)

/**
 * "cloud.example.com/" -> "https://cloud.example.com".
 * Plain http is refused except on this Mac and over Tailscale, since the app
 * password would otherwise travel unencrypted.
 */
function normalizeServer(input) {
	let s = String(input || '').trim()
	if (!s) throw new Error('Enter the address of your Nextcloud.')
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
		s = (/^(localhost|127\.|\[::1\])/i.test(s) ? 'http://' : 'https://') + s
	}
	let url
	try { url = new URL(s) } catch (e) { throw new Error('That is not a valid address.') }
	if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Use an https:// address.')
	if (url.protocol === 'http:' && !isLoopback(url.hostname) && !isTailnet(url.hostname)) {
		throw new Error('Use an https:// address: over plain http your password could be read on the network.')
	}
	// Drop a pasted page path like /index.php/apps/files (and any user:password@)
	const path = url.pathname.replace(/\/index\.php(\/.*)?$/, '').replace(/\/+$/, '')
	return `${url.protocol}//${url.host}${path}`
}

/**
 * Nextcloud's login flow answers with absolute URLs. They are rebuilt on the
 * address you entered, so the login page and the token never go to another host
 * (a misconfigured or hostile server could name any URL there).
 */
function onServer(server, value) {
	const u = new URL(String(value), server)
	const base = new URL(server)
	return `${base.origin}${u.pathname}${u.search}`
}

/**
 * Starts login flow v2. Open `loginUrl` in a browser window; `poll()` resolves
 * with { loginName, appPassword } once the user granted access (or rejects
 * after `timeoutMs`). `cancel()` stops polling.
 */
async function startLoginFlow(server, fetch, { intervalMs = 2000, timeoutMs = 20 * 60 * 1000 } = {}) {
	let res
	try {
		res = await fetch(`${server}/index.php/login/v2`, { method: 'POST', headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } })
	} catch (e) {
		throw new Error(`Can't reach ${new URL(server).host}. Check the address and your connection (and Tailscale).`)
	}
	if (!res.ok) throw new Error(`This doesn't look like a Nextcloud server (HTTP ${res.status}).`)
	let data
	try { data = await res.json() } catch (e) { throw new Error("This doesn't look like a Nextcloud server.") }
	if (typeof data.login !== 'string' || !data.poll || typeof data.poll.endpoint !== 'string' || typeof data.poll.token !== 'string') throw new Error("This doesn't look like a Nextcloud server.")
	const loginUrl = onServer(server, data.login)
	const pollUrl = onServer(server, data.poll.endpoint)
	if (!/\/login\/v2\/flow\//.test(loginUrl) || !/\/login\/v2\/poll$/.test(pollUrl)) throw new Error("This doesn't look like a Nextcloud server.")
	let cancelled = false
	const poll = async () => {
		const deadline = Date.now() + timeoutMs
		while (!cancelled && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, intervalMs))
			if (cancelled) break
			let r
			try {
				r = await fetch(pollUrl, {
					method: 'POST',
					redirect: 'error',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
					body: `token=${encodeURIComponent(data.poll.token)}`,
				})
			} catch (e) {
				continue // network hiccup: keep polling
			}
			if (r.status === 200) {
				const cred = await r.json()
				if (typeof cred.loginName !== 'string' || typeof cred.appPassword !== 'string' || !cred.loginName || !cred.appPassword) throw new Error('Nextcloud sent an unexpected answer.')
				return { loginName: cred.loginName, appPassword: cred.appPassword }
			}
		}
		throw new Error(cancelled ? 'Login cancelled.' : 'Login timed out.')
	}
	return { loginUrl, poll, cancel: () => { cancelled = true } }
}

class ApiError extends Error {
	constructor(message, status) {
		super(message)
		this.status = status
	}
}

/** Client for the Blockwise API with an app password (Basic auth). */
function createClient({ server, loginName, appPassword, fetch }) {
	const auth = 'Basic ' + Buffer.from(`${loginName}:${appPassword}`).toString('base64')
	const headers = { Authorization: auth, 'OCS-APIRequest': 'true', Accept: 'application/json', 'User-Agent': USER_AGENT }

	async function api(method, path, body) {
		let res
		try {
			res = await fetch(`${server}/index.php/apps/tracker/api/${path}`, {
				method,
				// Never follow a redirect with the password attached
				redirect: 'error',
				headers: body !== undefined ? { ...headers, 'Content-Type': 'application/json' } : headers,
				body: body !== undefined ? JSON.stringify(body) : undefined,
			})
		} catch (e) {
			throw new ApiError(`Can't reach ${new URL(server).host}. Check your connection (and Tailscale).`, 0)
		}
		if (res.status === 401) throw new ApiError('Nextcloud rejected the app password. Log in again.', 401)
		if (res.status === 503) throw new ApiError('Nextcloud is in maintenance mode or updating.', 503)
		let data = null
		try { data = await res.json() } catch (e) { /* not JSON */ }
		if (!res.ok) {
			if (res.status === 404 && !data) throw new ApiError('The Blockwise app is not enabled on this Nextcloud.', 404)
			throw new ApiError((data && data.message) || `Request failed (HTTP ${res.status}).`, res.status)
		}
		return data
	}

	/** Revokes the app password on the server (log out). */
	async function revoke() {
		try {
			await fetch(`${server}/ocs/v2.php/core/apppassword`, { method: 'DELETE', headers, redirect: 'error' })
		} catch (e) { /* offline: forget it locally anyway */ }
	}

	return { api, revoke, authHeader: auth, server }
}

module.exports = { normalizeServer, onServer, startLoginFlow, createClient, ApiError, USER_AGENT }
