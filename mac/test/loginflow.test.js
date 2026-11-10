// Login flow v2 against the local test Nextcloud, with a headless browser playing the user.
const { chromium } = require('playwright')
const nc = require('../src/nextcloud')

;(async () => {
	const server = nc.normalizeServer('localhost:8080/index.php/apps/files')
	console.log('normalized:', server)
	const flow = await nc.startLoginFlow(server, fetch, { intervalMs: 500, timeoutMs: 60000 })
	console.log('login url ok:', flow.loginUrl.startsWith(server))
	const polling = flow.poll()

	const browser = await chromium.launch()
	const page = await browser.newPage()
	await page.goto(flow.loginUrl)
	await page.getByRole('button', { name: /log in/i }).first().click()
	await page.fill('input[name=user]', 'admin')
	await page.fill('input[name=password]', 'admin-test-pw-123')
	await page.locator('form button[type=submit], form input[type=submit]').first().click()
	await page.getByRole('button', { name: /grant access/i }).click({ timeout: 15000 })
	await page.waitForTimeout(500)
	await browser.close()

	const cred = await polling
	console.log('got credentials for', cred.loginName, 'password length', cred.appPassword.length)
	const client = nc.createClient({ server, ...cred, fetch })
	const st = await client.api('GET', 'state')
	console.log('API works:', st.commitments.map((c) => c.name).join(', '))
	try { await nc.createClient({ server, loginName: 'admin', appPassword: 'wrong', fetch }).api('GET', 'state') } catch (e) { console.log('wrong password ->', e.status, e.message) }
	try { await nc.createClient({ server: 'http://localhost:9', loginName: 'a', appPassword: 'b', fetch }).api('GET', 'state') } catch (e) { console.log('offline ->', e.message) }
	await client.revoke()
	try { await client.api('GET', 'state'); console.log('REVOKE FAILED') } catch (e) { console.log('after revoke ->', e.status) }
	try { await nc.startLoginFlow('https://example.invalid', fetch) } catch (e) { console.log('bad server ->', e.message.slice(0, 60)) }
})().catch((e) => { console.error('FAILED', e); process.exit(1) })
