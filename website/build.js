// Prepares the files the Astro site takes as they are:
// - the browser app's app/lib/ (copied from nextcloud/, android/ and mac/) and
//   app/providers.js (the public Dropbox app key from site.json);
// - the Poppins fonts in public/fonts/ (from nextcloud/css/fonts).
// `npm run build` runs this, then `astro build`. On its own: node build.js
const fs = require('node:fs')
const path = require('node:path')
const dir = __dirname
const repo = path.resolve(dir, '..')
const site = JSON.parse(fs.readFileSync(path.join(dir, 'site.json'), 'utf8'))

/**
 * The web app (app/): Blockwise in the browser, from the same files as the
 * other apps (the interface from nextcloud/, the setup and the bridge from the
 * Android app, the drive code from the Mac app), copied into app/lib/.
 */
function buildApp() {
	const lib = path.join(dir, 'app', 'lib')
	fs.rmSync(lib, { recursive: true, force: true })
	fs.mkdirSync(path.join(lib, 'fonts'), { recursive: true })
	const copy = (from, to) => fs.copyFileSync(path.join(repo, from), path.join(lib, to || path.basename(from)))
	for (const f of ['js/tracker.js', 'js/engine.js', 'js/markdown.js', 'js/filesync.js', 'css/tracker.css']) copy('nextcloud/' + f)
	for (const f of fs.readdirSync(path.join(repo, 'nextcloud/css/fonts'))) copy('nextcloud/css/fonts/' + f, 'fonts/' + f)
	const it = JSON.parse(fs.readFileSync(path.join(repo, 'nextcloud/l10n/it.json'), 'utf8')).translations
	fs.writeFileSync(path.join(lib, 'l10n.js'), `window.__trackerL10n = ${JSON.stringify({ it })}\n`)
	const A = 'android/app/src/main/assets/'
	for (const f of ['android-bridge.js', 'nextcloud-shim.js', 'setup.js', 'i18n.js', 'app.css', 'android.css', 'android-setup.css', 'icon.png']) copy(A + f)
	copy('mac/src/drives.js')
	copy('mac/renderer/desktop.css')
	// Dropbox's app key (public: the login uses PKCE, there is no app secret). Empty: no sync, only this browser.
	const key = String((site.providers && site.providers.dropboxAppKey) || '')
	if (key && !/^[a-z0-9]{8,32}$/.test(key)) throw new Error('site.json: providers.dropboxAppKey is not a Dropbox app key')
	fs.writeFileSync(path.join(dir, 'app', 'providers.js'), `window.__blockwiseProviders = Object.freeze(${JSON.stringify({ dropboxAppKey: key })})\n`)
}

/** The site's font: the app's own Poppins files, served from this site */
function buildFonts() {
	const out = path.join(dir, 'public', 'fonts')
	fs.rmSync(out, { recursive: true, force: true })
	fs.mkdirSync(out, { recursive: true })
	const from = path.join(repo, 'nextcloud/css/fonts')
	for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(out, f))
}

if (site.url && !/^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(site.url)) throw new Error('site.json: url must be an https:// address with no path, e.g. https://blockwise.example')
buildApp()
buildFonts()
console.log('app/lib, app/providers.js and public/fonts are ready')
