/* The few Nextcloud page features Blockwise's interface uses, for the Mac app:
 * translations (t, n), the locale, toasts, and the bridge to the app. */
;(function () {
	'use strict'
	const app = window.trackerApp
	const locale = navigator.language || 'en'
	const dict = locale.toLowerCase().startsWith('it') ? (window.__trackerL10n || {}).it || {} : {}
	const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m))

	window.t = (appId, text, vars) => fill(dict[text] ?? text, vars)
	window.n = (appId, one, many, count, vars) => {
		const tr = dict[`_${one}_::_${many}_`]
		const s = tr ? (count === 1 ? tr[0] : tr[1]) : (count === 1 ? one : many)
		return fill(s.replace(/%n/g, count), vars)
	}

	let timer = null
	function toast(message, error) {
		const el = document.getElementById('toast')
		if (!el) return
		el.textContent = message
		el.classList.toggle('is-error', !!error)
		el.hidden = false
		clearTimeout(timer)
		timer = setTimeout(() => { el.hidden = true }, error ? 6000 : 3000)
	}

	window.OC = {
		requestToken: '',
		generateUrl: (p) => p, // not used for requests in the app
		getLocale: () => locale.replace('-', '_'),
		Notification: { showTemporary: (msg, opts) => toast(msg, opts && opts.type === 'error') },
	}

	window.trackerBridge = {
		api: (method, path, body) => app.api(method, path, body),
		openCalendar: (ts) => app.openCalendar(ts),
		onChanged: (cb) => app.onChanged(cb),
		// Only the phone app has an account sheet; the Mac app uses its menu bar menu
		account: app.account ? () => app.account() : undefined,
	}
	document.documentElement.lang = locale
})()
