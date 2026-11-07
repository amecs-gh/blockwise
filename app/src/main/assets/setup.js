/* First run: enter the Nextcloud address, then log in in the window that opens. */
;(function () {
	'use strict'
	const app = window.trackerApp
	const $ = (id) => document.getElementById(id)
	app.getState().then((s) => {
		const t = window.trackerI18n.make(s.locale)
		document.documentElement.lang = s.locale
		$('title').textContent = t('Connect to your Nextcloud')
		const android = s.platform === 'android'
		$('intro').textContent = android
			? t('Tracker uses your commitments, tasks and calendar from Nextcloud. You log in once; the app gets its own password, stored encrypted on this phone.')
			: t('Tracker uses your commitments, tasks and calendar from Nextcloud. You log in once; the app gets its own password, stored in your Keychain.')
		$('server-label').textContent = t('Nextcloud address')
		$('server').placeholder = t('e.g. cloud.example.com or your Tailscale name')
		$('submit').textContent = t('Log in')
		$('cancel').textContent = t('Cancel')
		$('waiting-text').textContent = android
			? t('Log in and tap "Grant access" on the Nextcloud page.')
			: t('Log in and click "Grant access" in the window that opened.')
		try { $('server').value = localStorage.getItem('server') || '' } catch (e) { /* none */ }
		$('server').focus()
	})

	$('form').addEventListener('submit', async (e) => {
		e.preventDefault()
		const server = $('server').value.trim()
		$('error').hidden = true
		$('form').hidden = true
		$('waiting').hidden = false
		try { localStorage.setItem('server', server) } catch (err) { /* private */ }
		try {
			await app.login(server)
		} catch (err) {
			$('error').textContent = err.message
			$('error').hidden = false
			$('form').hidden = false
			$('waiting').hidden = true
			$('server').focus()
		}
	})
	$('cancel').addEventListener('click', () => app.cancelLogin())
})()
