/*
 * First run: Blockwise on this phone only (no account), or synced: with
 * Nextcloud (enter the address, then log in on the page that opens) or through
 * Dropbox / Google Drive (allow Blockwise in the browser, then a passphrase
 * that encrypts everything on the drive).
 * "#connect": from "on this phone only" to a sync; your data comes along.
 */
;(function () {
	'use strict'
	const app = window.trackerApp
	const $ = (id) => document.getElementById(id)
	const NAMES = { dropbox: 'Dropbox', gdrive: 'Google Drive' }
	let t = (s) => s
	let connecting = false
	let drive = null // { provider, exists } while connecting a drive
	let busy = false

	function show(view) {
		for (const v of ['choose', 'form', 'waiting', 'pass']) $(v).hidden = v !== view
		if (view === 'choose') {
			$('title').textContent = connecting ? t('Sync Blockwise') : t('Welcome to Blockwise')
			$('intro').textContent = connecting
				? t('Your commitments, tasks, notes, blocks and tracked time on this phone go along.')
				: t('Plan your week in blocks and get through it one block at a time.')
		} else if (view === 'form') {
			$('title').textContent = t('Connect to your Nextcloud')
			$('intro').textContent = connecting
				? t('Your commitments, tasks, notes and tracked time on this phone go along to Nextcloud. You log in once; the app gets its own password, stored encrypted on this phone.')
				: t('Blockwise uses your commitments, tasks and calendar from Nextcloud. You log in once; the app gets its own password, stored encrypted on this phone.')
			$('server').focus()
		} else if (view === 'pass') {
			const name = NAMES[drive.provider]
			$('title').textContent = drive.exists ? t('Enter your passphrase') : t('Choose a passphrase')
			$('intro').textContent = drive.exists
				? t('Blockwise is already set up in this {drive}. Enter the passphrase you chose on your other device.', { drive: name })
				: t('It encrypts your data before it goes to {drive}: only your devices can read it. Nobody can recover it if you forget it, so write it down.', { drive: name })
			$('pass2-box').hidden = drive.exists
			$('pass2').required = !drive.exists
			$('pass1').value = ''
			$('pass2').value = ''
			$('pass-error').hidden = true
			$('pass1').focus()
		}
	}

	app.getState().then((s) => {
		t = window.trackerI18n.make(s.locale)
		document.documentElement.lang = s.locale
		connecting = !!s.connecting || location.hash === '#connect'
		const drives = s.drives || {}
		$('local-box').hidden = connecting
		$('local').textContent = t('Start on this phone')
		$('local-note').textContent = t('No account needed. Your data stays on this phone, encrypted. You can set up a sync later.')
		$('sync-head').textContent = connecting ? '' : t('Or sync with your other devices')
		$('sync-head').hidden = connecting
		$('nextcloud').textContent = t('Sync with Nextcloud')
		$('nextcloud-note').textContent = t('Your commitments and tasks on your Mac, phone and in the browser. Blocks come from your Nextcloud calendars.')
		$('dropbox').textContent = t('Sync with {drive}', { drive: 'Dropbox' })
		$('gdrive').textContent = t('Sync with {drive}', { drive: 'Google Drive' })
		$('dropbox').hidden = !drives.dropbox
		$('gdrive').hidden = !drives.gdrive
		$('drives').hidden = !drives.dropbox && !drives.gdrive
		$('drives-note').textContent = t('With your Mac and other phones, end-to-end encrypted with a passphrase only you know.')
		$('choose-back').textContent = t('Back to Blockwise')
		$('choose-back').hidden = !connecting
		$('server-label').textContent = t('Nextcloud address')
		$('server').placeholder = t('e.g. cloud.example.com or your Tailscale name')
		$('submit').textContent = t('Log in')
		$('back').textContent = t('Back')
		$('cancel').textContent = t('Cancel')
		$('pass1-label').textContent = t('Passphrase (at least 8 characters)')
		$('pass2-label').textContent = t('Passphrase again')
		$('pass-submit').textContent = t('Continue')
		$('pass-back').textContent = t('Cancel')
		try { $('server').value = localStorage.getItem('server') || '' } catch (e) { /* none */ }
		show('choose')
	})

	$('local').addEventListener('click', () => { $('local').disabled = true; app.useLocal() })
	$('nextcloud').addEventListener('click', () => show('form'))
	$('back').addEventListener('click', () => show('choose'))
	$('choose-back').addEventListener('click', () => app.backToApp())

	$('form').addEventListener('submit', async (e) => {
		e.preventDefault()
		const server = $('server').value.trim()
		$('error').hidden = true
		$('waiting-text').textContent = t('Log in and tap "Grant access" on the Nextcloud page.')
		drive = null
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

	for (const provider of ['dropbox', 'gdrive']) {
		$(provider).addEventListener('click', async () => {
			drive = { provider, exists: false }
			$('choose-error').hidden = true
			$('waiting-text').textContent = t('Allow Blockwise in your browser, then come back here.')
			show('waiting')
			try {
				drive.exists = !!(await app.connectDrive(provider))
				show('pass')
			} catch (err) {
				if (!drive) return // cancelled
				drive = null
				show('choose')
				$('choose-error').textContent = err.message
				$('choose-error').hidden = false
			}
		})
	}
	$('cancel').addEventListener('click', () => {
		if (drive) { drive = null; app.cancelDrive(); show('choose') } else { app.cancelLogin(); show('form') }
	})
	$('pass-back').addEventListener('click', () => { drive = null; app.cancelDrive(); show('choose') })
	$('pass').addEventListener('submit', async (e) => {
		e.preventDefault()
		if (busy) return
		const err = (m) => { $('pass-error').textContent = m; $('pass-error').hidden = false }
		const p1 = $('pass1').value
		if ([...p1].length < 8) return err(t('The passphrase needs at least 8 characters.'))
		if (!drive.exists && p1 !== $('pass2').value) return err(t('The two passphrases are not the same.'))
		busy = true
		$('pass-submit').disabled = true
		$('pass-submit').textContent = t('Checking…')
		try {
			await app.unlockDrive(p1)
		} catch (x) {
			err(x && x.code === 'passphrase' ? t('Wrong passphrase for this sync folder.') : (x && x.message) || t('Something went wrong.'))
		} finally {
			busy = false
			$('pass-submit').disabled = false
			$('pass-submit').textContent = t('Continue')
		}
	})
})()
