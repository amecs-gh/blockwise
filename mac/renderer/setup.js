/* First run: choose where your data lives (Nextcloud, Dropbox, Google Drive or
 * this Mac only), then log in or connect. A drive also needs a passphrase: your
 * data is encrypted with it before it leaves this Mac. */
;(function () {
	'use strict'
	const app = window.trackerApp
	const $ = (id) => document.getElementById(id)
	const MIN_NEW = 10
	let t = (s) => s
	let drive = null // 'dropbox' | 'gdrive' while connecting one
	let ready = null // drives with app keys in this build
	let creating = false // a new sync folder (else: open the one your other devices made)

	const STEPS = ['step-choose', 'step-nextcloud', 'step-passphrase', 'waiting']
	function show(step, { title, intro } = {}) {
		for (const s of STEPS) $(s).hidden = s !== step
		if (title) $('title').textContent = title
		if (intro !== undefined) $('intro').textContent = intro
	}
	function error(msg) {
		$('error').textContent = msg ? t(msg) : ''
		$('error').hidden = !msg
	}
	function choose() {
		drive = null
		error(null)
		show('step-choose', { title: t('Where should Blockwise keep your data?'), intro: t('You can change this later from the menu bar icon.') })
		const first = $('step-choose').querySelector('button')
		if (first) first.focus()
	}
	function waiting(text) {
		error(null)
		$('waiting-text').textContent = text
		show('waiting')
	}

	const CHOICES = {
		nextcloud: ['Nextcloud', 'Your own server. Calendars, tasks and time sync with the Nextcloud app and your phone.'],
		dropbox: ['Dropbox', 'Synced through a Blockwise folder in your Dropbox, encrypted with a passphrase only you know.'],
		gdrive: ['Google Drive', 'Synced through a hidden Blockwise folder in your Google Drive, encrypted with a passphrase only you know.'],
		local: ['This Mac only', 'No sync. You can connect Nextcloud or a drive later; your data comes along.'],
	}

	function buildChoices(providers) {
		const box = $('step-choose')
		box.textContent = ''
		for (const p of providers) {
			if (!CHOICES[p]) continue
			const b = document.createElement('button')
			b.type = 'button'
			b.className = 'u-choice'
			b.setAttribute('role', 'listitem')
			const name = document.createElement('strong')
			name.textContent = t(CHOICES[p][0])
			const text = document.createElement('span')
			text.textContent = t(CHOICES[p][1])
			b.append(name, text)
			b.addEventListener('click', () => pick(p))
			box.append(b)
		}
	}

	async function pick(p) {
		error(null)
		if (p === 'nextcloud') {
			show('step-nextcloud', { title: t('Connect to your Nextcloud'), intro: t('Blockwise uses your commitments, tasks and calendar from Nextcloud. You log in once; the app gets its own password, stored in your Keychain.') })
			$('server').focus()
			return
		}
		if (p === 'local') {
			try { await app.useThisMac() } catch (e) { choose(); error(e.message) }
			return
		}
		if (!(ready && ready[p])) {
			error(t('{drive} needs a one-time setup first: see "Set up Dropbox and Google Drive" in mac/README.md.', { drive: t(CHOICES[p][0]) }))
			return
		}
		drive = p
		waiting(t('Allow Blockwise in your browser. It can only see its own folder in your {drive}.', { drive: t(CHOICES[p][0]) }))
		try {
			const { exists } = await app.connectDrive(p)
			passphrase(exists)
		} catch (e) {
			if (e.message !== 'Cancelled.') { choose(); error(e.message) }
		}
	}

	function passphrase(exists) {
		creating = !exists
		$('pass').value = ''
		$('pass2').value = ''
		$('pass').autocomplete = creating ? 'new-password' : 'current-password'
		$('confirm-row').hidden = !creating
		$('pass2').required = creating
		$('pass-label').textContent = creating ? t('Choose a passphrase') : t('Passphrase')
		$('pass2-label').textContent = t('Type it again')
		$('pass-hint').textContent = creating
			? t('At least {n} characters; a few unrelated words work well. Keep it in your password manager: without it nobody, not even you, can read the synced data.', { n: MIN_NEW })
			: t('The passphrase you chose on your other device.')
		$('pass-submit').textContent = creating ? t('Encrypt and sync') : t('Unlock')
		show('step-passphrase', {
			title: creating ? t('Protect your data') : t('Unlock your data'),
			intro: creating
				? t('Blockwise encrypts everything on this Mac before it goes to {drive}.', { drive: t(CHOICES[drive][0]) })
				: t('Your other devices already sync through {drive}.', { drive: t(CHOICES[drive][0]) }),
		})
		$('pass').focus()
	}

	$('step-nextcloud').addEventListener('submit', async (e) => {
		e.preventDefault()
		const server = $('server').value.trim()
		try { localStorage.setItem('server', server) } catch (err) { /* private */ }
		waiting(t('Log in and click "Grant access" in the window that opened.'))
		try {
			await app.login(server)
		} catch (err) {
			show('step-nextcloud')
			error(err.message)
			$('server').focus()
		}
	})

	$('step-passphrase').addEventListener('submit', async (e) => {
		e.preventDefault()
		const pass = $('pass').value
		if (creating && [...pass].length < MIN_NEW) { error(t('The passphrase needs at least {n} characters.', { n: MIN_NEW })); return }
		if (creating && pass !== $('pass2').value) { error(t('The two passphrases are different.')); return }
		waiting(creating ? t('Setting up encrypted sync…') : t('Unlocking…'))
		try {
			await app.unlockDrive(pass)
		} catch (err) {
			show('step-passphrase')
			error(err.message)
			$('pass').select()
		}
	})

	for (const b of document.querySelectorAll('.js-back')) b.addEventListener('click', () => { app.cancelLogin(); choose() })
	$('cancel').addEventListener('click', () => { app.cancelLogin(); choose() })

	app.getState().then((s) => {
		t = window.trackerI18n.make(s.locale)
		document.documentElement.lang = s.locale
		$('server-label').textContent = t('Nextcloud address')
		$('server').placeholder = t('e.g. cloud.example.com or your Tailscale name')
		$('submit').textContent = t('Log in')
		$('cancel').textContent = t('Cancel')
		for (const b of document.querySelectorAll('.js-back')) b.textContent = t('Back')
		try { $('server').value = localStorage.getItem('server') || '' } catch (e) { /* none */ }
		ready = s.providersReady || {}
		buildChoices(s.providers || ['nextcloud', 'local'])
		choose()
	})
})()
