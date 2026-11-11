/*
 * First run: Blockwise on this phone only (no account), or synced with
 * Nextcloud (enter the address, then log in on the page that opens).
 * "#connect": from "on this phone only" to Nextcloud; your data comes along.
 */
;(function () {
	'use strict'
	const app = window.trackerApp
	const $ = (id) => document.getElementById(id)
	let t = (s) => s
	let connecting = false

	function show(view) {
		$('choose').hidden = view !== 'choose'
		$('form').hidden = view !== 'form'
		$('waiting').hidden = view !== 'waiting'
		if (view === 'choose') {
			$('title').textContent = t('Welcome to Blockwise')
			$('intro').textContent = t('Plan your week in blocks and get through it one block at a time.')
		} else if (view === 'form') {
			$('title').textContent = t('Connect to your Nextcloud')
			$('intro').textContent = connecting
				? t('Your commitments, tasks, notes and tracked time on this phone go along to Nextcloud. You log in once; the app gets its own password, stored encrypted on this phone.')
				: t('Blockwise uses your commitments, tasks and calendar from Nextcloud. You log in once; the app gets its own password, stored encrypted on this phone.')
			$('back').textContent = connecting ? t('Back to Blockwise') : t('Back')
			$('server').focus()
		}
	}

	app.getState().then((s) => {
		t = window.trackerI18n.make(s.locale)
		document.documentElement.lang = s.locale
		connecting = !!s.connecting || location.hash === '#connect'
		$('local').textContent = t('Start on this phone')
		$('local-note').textContent = t('No account needed. Your data stays on this phone, encrypted. You can sync with Nextcloud later.')
		$('nextcloud').textContent = t('Sync with Nextcloud')
		$('nextcloud-note').textContent = t('Your commitments and tasks on your Mac, phone and in the browser. Blocks come from your Nextcloud calendars.')
		$('server-label').textContent = t('Nextcloud address')
		$('server').placeholder = t('e.g. cloud.example.com or your Tailscale name')
		$('submit').textContent = t('Log in')
		$('cancel').textContent = t('Cancel')
		$('waiting-text').textContent = t('Log in and tap "Grant access" on the Nextcloud page.')
		try { $('server').value = localStorage.getItem('server') || '' } catch (e) { /* none */ }
		show(connecting ? 'form' : 'choose')
	})

	$('local').addEventListener('click', () => { $('local').disabled = true; app.useLocal() })
	$('nextcloud').addEventListener('click', () => show('form'))
	$('back').addEventListener('click', () => { if (connecting) app.backToApp(); else show('choose') })

	$('form').addEventListener('submit', async (e) => {
		e.preventDefault()
		const server = $('server').value.trim()
		$('error').hidden = true
		show('waiting')
		try { localStorage.setItem('server', server) } catch (err) { /* private */ }
		try {
			await app.login(server)
		} catch (err) {
			show('form')
			$('error').textContent = err.message
			$('error').hidden = false
		}
	})
	$('cancel').addEventListener('click', () => { app.cancelLogin(); show('form') })
})()
