'use strict'
/**
 * Where blocks come from (the engine's `calendar`):
 * - Apple Calendar, through the small helper in the app (mac/helper, EventKit):
 *   every calendar on this Mac (iCloud, Google, Exchange, Nextcloud via CalDAV),
 *   offline too. Used when syncing with Dropbox, Google Drive or this Mac only.
 * - Nextcloud's calendars, through the Blockwise API, when syncing with Nextcloud
 *   (with the last answer kept, so blocks show offline).
 *
 * No Electron imports: tested in plain Node.
 */
const { execFile } = require('node:child_process')

const APPLE = 'apple:'
const ID_RE = /^[A-Za-z0-9:_.-]{1,200}$/
const appleUrl = (id) => APPLE + id
const appleId = (url) => (typeof url === 'string' && url.startsWith(APPLE) && ID_RE.test(url.slice(APPLE.length)) ? url.slice(APPLE.length) : null)

/**
 * Runs the helper: one command per run, JSON in on stdin, JSON out on stdout.
 * No shell, fixed arguments, a time limit and an output limit.
 */
function runHelper(helperPath, command, input, run = execFile) {
	return new Promise((resolve, reject) => {
		const child = run(helperPath, [command], { timeout: 20000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
			if (err && !stdout) {
				reject(Object.assign(new Error('Apple Calendar could not be read.'), { cause: err }))
				return
			}
			let out
			try { out = JSON.parse(String(stdout)) } catch (e) { reject(new Error('Apple Calendar gave an unreadable answer.')); return }
			if (!out || out.ok !== true) {
				const e = new Error(out && out.error === 'denied' ? 'Blockwise may not use your calendars. Allow it in System Settings → Privacy & Security → Calendars.' : 'Apple Calendar could not be read.')
				e.code = out && out.error
				reject(e)
				return
			}
			resolve(out.data)
		})
		if (child && child.stdin) child.stdin.end(JSON.stringify(input || {}))
	})
}

/** Apple Calendar as the engine's calendar source. */
function appleCalendar({ helperPath, run }) {
	const call = (cmd, input) => runHelper(helperPath, cmd, input, run)
	let cals = []
	return {
		kind: 'apple',
		/** Asks macOS for access the first time (the system dialog) */
		access: () => call('access'),
		async calendars() {
			const list = await call('calendars')
			cals = (Array.isArray(list) ? list : []).filter((c) => c && typeof c.id === 'string' && ID_RE.test(c.id)).map((c) => ({
				url: appleUrl(c.id),
				name: String(c.title || '').slice(0, 255),
				color: /^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : '#0082c9',
				writable: !!c.writable,
				source: String(c.source || '').slice(0, 100),
			}))
			return cals
		},
		async events(from, to, urls) {
			const ids = (urls || []).map(appleId).filter(Boolean)
			if (!ids.length || !(to > from)) return []
			const list = await call('events', { from: Math.floor(from), to: Math.ceil(to), calendars: ids })
			const out = []
			for (const e of Array.isArray(list) ? list : []) {
				if (!e || typeof e.uid !== 'string' || !Number.isFinite(e.start) || !Number.isFinite(e.end) || e.allDay) continue
				// "<iCalendar UID>#<start>": the id the server and the phone give the same block
				out.push({ uid: `${e.uid.slice(0, 300)}#${Math.floor(e.start)}`, title: String(e.title || '').slice(0, 500), start: Math.floor(e.start), end: Math.floor(e.end), url: appleUrl(String(e.calendar)) })
			}
			return out
		},
		async createEvent({ url, title, start, end }) {
			const id = appleId(url)
			if (!id) throw new Error('This commitment has no calendar on this Mac. Link one in Settings.')
			const r = await call('createEvent', { calendar: id, title: String(title).slice(0, 255), start, end })
			return { uid: `${r.uid}#${start}` }
		},
		/** A new commitment's calendar (in iCloud if you use it, else on this Mac) */
		async createCalendar({ name, color }) {
			const r = await call('createCalendar', { title: String(name).slice(0, 255), color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#0082c9' })
			return r && typeof r.id === 'string' && ID_RE.test(r.id) ? appleUrl(r.id) : null
		},
	}
}

/**
 * Nextcloud's calendars through the Blockwise API (`api` = the logged-in client's).
 * The last blocks are kept for each calendar, so they show offline.
 */
function nextcloudCalendar({ api, now = Date.now }) {
	let cals = null
	let calsAt = 0
	let cache = [] // last events from the server
	let recent = null // the last answer, reused for a few seconds (every refresh asks)
	return {
		kind: 'nextcloud',
		async calendars() {
			if (cals && now() - calsAt < 5 * 60 * 1000) return cals.map(({ url, name, color }) => ({ url, name, color }))
			try {
				cals = ((await api('GET', 'state')).calendars || []).map((c) => ({ id: c.id, url: c.url, name: c.name, color: c.color }))
				calsAt = now()
			} catch (e) {
				if (!cals) throw e
			}
			return cals.map(({ url, name, color }) => ({ url, name, color }))
		},
		async events(from, to, urls) {
			try {
				if (!cals) await this.calendars()
				const key = `${Math.floor(from)}-${Math.ceil(to)}`
				if (!recent || recent.key !== key || now() - recent.at > 20000) recent = { key, at: now(), blocks: (await api('GET', `blocks?from=${Math.floor(from)}&to=${Math.ceil(to)}`)).blocks }
				const { blocks } = recent
				const out = []
				for (const b of blocks || []) {
					const cal = cals.find((c) => c.id === b.calendarId)
					if (cal && urls.includes(cal.url)) out.push({ uid: b.uid, title: b.title, start: b.start, end: b.end, url: cal.url })
				}
				cache = [...cache.filter((e) => e.end <= from || e.start >= to), ...out].slice(-5000)
				return out
			} catch (e) {
				// Offline: the blocks seen last time (some may be missing)
				const out = cache.filter((x) => urls.includes(x.url) && x.end > from && x.start < to)
				out.incomplete = true
				return out
			}
		},
	}
}

/** No calendars at all (the engine still works; no blocks). */
const noCalendar = { kind: 'none', calendars: async () => [], events: async () => [] }

module.exports = { appleCalendar, nextcloudCalendar, noCalendar, runHelper, appleId, appleUrl }
