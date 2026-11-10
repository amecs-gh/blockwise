// Copies the interface code from the Nextcloud app (../nextcloud) into the Mac app,
// so all apps stay identical. Runs before `npm start` and `npm run build`.
const fs = require('node:fs')
const path = require('node:path')

const src = path.resolve(__dirname, '..', '..', 'nextcloud')
const dst = path.resolve(__dirname, '..', 'renderer', 'web')
const files = { 'js/markdown.js': 'markdown.js', 'js/engine.js': 'engine.js', 'js/filesync.js': 'filesync.js', 'js/tracker.js': 'tracker.js', 'css/tracker.css': 'tracker.css' }

if (!fs.existsSync(path.join(src, 'appinfo', 'info.xml'))) {
	console.error(`sync-web: ${src} not found (the Mac app is built from the blockwise repository)`)
	process.exit(1)
}
fs.mkdirSync(dst, { recursive: true })
for (const [from, to] of Object.entries(files)) fs.copyFileSync(path.join(src, from), path.join(dst, to))
// Translations as a script, so they're there before the interface starts
const it = JSON.parse(fs.readFileSync(path.join(src, 'l10n', 'it.json'), 'utf8')).translations
fs.writeFileSync(path.join(dst, 'l10n.js'), `window.__trackerL10n = ${JSON.stringify({ it })}\n`)
const version = /<version>([^<]+)<\/version>/.exec(fs.readFileSync(path.join(src, 'appinfo', 'info.xml'), 'utf8'))[1]
fs.writeFileSync(path.join(dst, 'version.json'), JSON.stringify({ tracker: version }) + '\n')
console.log(`sync-web: copied the Blockwise ${version} interface`)
