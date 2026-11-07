/*
 * window.trackerApp for the Android app: the same interface the Mac app's
 * preload gives its windows (so setup.js and nextcloud-shim.js are shared),
 * implemented over the app's Java bridge (window.TrackerAndroid).
 *
 * Every call goes through TrackerAndroid.call(id, channel, argsJson); the app
 * answers with window.__trackerAndroid.resolve(id, envelopeJson), where the
 * envelope is {"data": ...} or {"error": "...", "status": n}.
 */
;(function () {
	'use strict'
	const native = window.TrackerAndroid
	const pending = new Map()
	const listeners = { state: [], changed: [] }
	let next = 1

	function call(channel, ...args) {
		return new Promise((resolve, reject) => {
			if (!native) { reject(new Error('Not available.')); return }
			const id = String(next++)
			pending.set(id, { resolve, reject })
			try {
				native.call(id, channel, JSON.stringify(args))
			} catch (e) {
				pending.delete(id)
				reject(e)
			}
		})
	}

	window.__trackerAndroid = {
		resolve(id, envelopeJson) {
			const p = pending.get(id)
			if (!p) return
			pending.delete(id)
			let env
			try { env = JSON.parse(envelopeJson) } catch (e) { p.reject(new Error('Invalid answer.')); return }
			if (env && env.error) {
				const err = new Error(env.error)
				err.status = env.status
				p.reject(err)
			} else {
				p.resolve(env ? env.data : undefined)
			}
		},
		emit(channel, payloadJson) {
			let payload
			try { payload = payloadJson ? JSON.parse(payloadJson) : undefined } catch (e) { return }
			for (const cb of listeners[channel] || []) {
				try { cb(payload) } catch (e) { console.error(e) }
			}
		},
	}

	window.trackerApp = {
		getState: () => call('state'),
		onState: (cb) => listeners.state.push(cb),
		api: (method, path, body) => call('api', method, path, body === undefined ? null : body),
		refresh: () => call('refresh'),
		login: (server) => call('login', server),
		cancelLogin: () => call('cancelLogin'),
		openCalendar: (ts) => call('openCalendar', typeof ts === 'number' ? ts : null),
		onChanged: (cb) => listeners.changed.push(cb),
		account: () => call('account'),
	}
})()
