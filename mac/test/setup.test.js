// The first-run screen with every choice, the drive steps and their checks
// (stand-in bridge, no main process). node test/setup.test.js
const path = require('node:path')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const shots = process.env.SHOTS || '/tmp/claude-0'
const ok = (n) => console.log('  ✔', n)

;(async () => {
	const browser = await chromium.launch()
	for (const [locale, dark] of [['en-US', false], ['it-IT', true]]) {
		const page = await browser.newPage({ viewport: { width: 480, height: 640 }, deviceScaleFactor: 2, colorScheme: dark ? 'dark' : 'light' })
		const errors = []
		page.on('pageerror', (e) => errors.push(e.message))
		await page.exposeFunction('__log', (x) => calls.push(x))
		const calls = []
		await page.addInitScript((loc) => {
			let exists = false
			window.trackerApp = {
				getState: async () => ({ locale: loc, providers: ['nextcloud', 'local', 'gdrive', 'dropbox'], providersReady: { dropbox: true, gdrive: true } }),
				connectDrive: async (p) => { window.__log('connect ' + p); await new Promise((r) => setTimeout(r, 300)); return { exists } },
				unlockDrive: async (x) => { window.__log('unlock ' + x); if (x === 'wrong passphrase!') throw new Error('Wrong passphrase for this sync folder.') },
				useThisMac: async () => window.__log('local'),
				login: async () => {}, cancelLogin: async () => window.__log('cancel'),
			}
			window.__setExists = (v) => { exists = v }
		}, locale)
		await page.goto('file://' + path.join(__dirname, '..', 'renderer', 'setup.html'))
		await page.waitForSelector('.u-choice')
		assert.equal(await page.locator('.u-choice').count(), 4)
		await page.screenshot({ path: `${shots}/mac-setup-choose-${locale}.png` })
		const it = locale.startsWith('it')
		// A new folder: passphrase twice, at least 10 characters
		await page.click('.u-choice >> nth=3')
		await page.waitForSelector('#step-passphrase:not([hidden])')
		assert.equal(await page.isVisible('#pass2'), true)
		await page.fill('#pass', 'short'); await page.fill('#pass2', 'short'); await page.click('#pass-submit')
		assert.match(await page.innerText('#error'), it ? /almeno 10/ : /at least 10/)
		await page.fill('#pass', 'correct horse battery'); await page.fill('#pass2', 'correct horse batterx'); await page.click('#pass-submit')
		assert.match(await page.innerText('#error'), it ? /diverse/ : /different/)
		assert.ok(!calls.some((c) => c.startsWith('unlock')), 'nothing sent before both checks pass')
		await page.screenshot({ path: `${shots}/mac-setup-passphrase-${locale}.png` })
		await page.fill('#pass2', 'correct horse battery'); await page.click('#pass-submit')
		await page.waitForTimeout(100)
		assert.ok(calls.includes('unlock correct horse battery'))
		ok(`${locale}: new folder: passphrase checked (length, typed twice)`)
		// The folder exists: one field; a wrong passphrase is shown
		await page.click('.js-back >> nth=1').catch(() => {})
		await page.evaluate(() => window.__setExists(true))
		await page.evaluate(() => document.querySelector('.js-back') && document.querySelectorAll('.js-back')[1].click())
		await page.click('.u-choice >> nth=2')
		await page.waitForSelector('#step-passphrase:not([hidden])')
		assert.equal(await page.isVisible('#pass2'), false)
		await page.fill('#pass', 'wrong passphrase!'); await page.click('#pass-submit')
		await page.waitForSelector('#error:not([hidden])')
		assert.match(await page.innerText('#error'), it ? /Passphrase errata/ : /Wrong passphrase/)
		assert.equal(await page.inputValue('#pass'), 'wrong passphrase!')
		await page.screenshot({ path: `${shots}/mac-setup-unlock-${locale}.png` })
		ok(`${locale}: existing folder: one field; wrong passphrase shown, translated`)
		assert.equal(await page.getAttribute('#pass', 'type'), 'password')
		assert.deepEqual(errors, [])
		await page.close()
	}
	await browser.close()
	console.log('\nsetup screen tests passed')
})().catch((e) => { console.error('✘', e); process.exit(1) })
