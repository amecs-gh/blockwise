// Same as the Gradle syncWeb task, for testing here: copy Tracker's interface from ../tracker.
const fs = require('node:fs'), path = require('node:path')
const src = path.resolve(__dirname, '..', '..', 'tracker'), dst = path.join(__dirname, '..', 'app/src/main/assets/web')
fs.mkdirSync(dst, { recursive: true })
fs.copyFileSync(path.join(src, 'js/tracker.js'), path.join(dst, 'tracker.js'))
fs.copyFileSync(path.join(src, 'js/engine.js'), path.join(dst, 'engine.js'))
fs.copyFileSync(path.join(src, 'css/tracker.css'), path.join(dst, 'tracker.css'))
const it = JSON.parse(fs.readFileSync(path.join(src, 'l10n/it.json'), 'utf8')).translations
fs.writeFileSync(path.join(dst, 'l10n.js'), `window.__trackerL10n = ${JSON.stringify({ it })}\n`)
console.log('copied')
