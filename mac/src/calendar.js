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
const REPEATS = ['', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly']
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
		async createEvent({ url, title, start, end, repeat = '', until = null, skip = [] }) {
			const id = appleId(url)
			if (!id) throw new Error('This commitment has no calendar on this Mac. Link one in Settings.')
			const input = { calendar: id, title: String(title).slice(0, 255), start, end }
			if (REPEATS.includes(repeat) && repeat) {
				input.repeat = repeat
				if (Number.isFinite(until) && until >= start) input.until = until
				input.skip = (Array.isArray(skip) ? skip : []).filter((x) => Number.isInteger(x)).slice(-1000)
			}
			const r = await call('createEvent', input)
			if (!r || typeof r.uid !== 'string' || !r.uid) throw new Error('Apple Calendar could not be read.')
			return { uid: `${r.uid}#${start}`, eventUid: r.uid }
		},
		/** An event's old copy (one occurrence with `start`, else the series), by its iCalendar UID */
		async removeCopy({ url, uid, start }) {
			const calendar = appleId(url)
			if (!calendar || typeof uid !== 'string' || !uid || uid.length > 1000) return
			await call('deleteEvent', Number.isFinite(start) ? { calendar, uid, start } : { calendar, uid })
		},
		/** A commitment's calendar with all its events, when you delete the commitment (can't be undone) */
		async deleteCalendar(url) {
			const calendar = appleId(url)
			if (!calendar) throw new Error('This calendar is not on this Mac.')
			try {
				await call('deleteCalendar', { calendar })
			} catch (e) {
				if (e.code === 'invalid') throw new Error('Apple Calendar keeps this calendar: it is your default calendar or can\'t be changed. Nothing was deleted.')
				throw e
			}
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
	const self = {
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
				if (!cals) await self.calendars()
				const key = `${Math.floor(from)}-${Math.ceil(to)}`
				if (!recent || recent.key !== key || now() - recent.at > 20000) recent = { key, at: now(), blocks: (await api('GET', `blocks?from=${Math.floor(from)}&to=${Math.ceil(to)}`)).blocks }
				const { blocks } = recent
				const out = []
				for (const b of blocks || []) {
					const cal = cals.find((c) => c.id === b.calendarId)
					if (!cal || !urls.includes(cal.url)) continue
					const ev = { uid: b.uid, title: b.title, start: b.start, end: b.end, url: cal.url }
					// Which event and occurrence (to change it on the calendar page)
					if (Number.isInteger(b.series) && b.series > 0) Object.assign(ev, { series: b.series, occurrence: b.occurrence, repeat: b.repeat || '', until: b.until ?? null })
					out.push(ev)
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
		/** Plan a block: an event in the commitment's Nextcloud calendar */
		async createEvent({ url, title, start, end, repeat = '', until = null, tz }) {
			const cal = await calOf(url)
			const r = await api('POST', 'blocks', { calendarId: cal.id, title, start, end, repeat, until, tz })
			recent = null
			return { uid: r.uid }
		},
		/** Move or change one (this / future / all); `url`: to another commitment's calendar */
		async updateEvent(series, occurrence, ch) {
			const body = { ...ch }
			delete body.url
			if (ch.url) body.calendarId = (await calOf(ch.url)).id
			const r = await api('PUT', `blocks/${series}/${occurrence}`, body)
			recent = null
			return r
		},
		/** A commitment's calendar, with its events, to Nextcloud's trash bin */
		async deleteCalendar(url) {
			const cal = await calOf(url)
			await api('DELETE', `calendars/${cal.id}`)
			cals = null
			recent = null
		},
		async deleteEvent(series, occurrence, scope) {
			const r = await api('DELETE', `blocks/${series}/${occurrence}?scope=${scope}`)
			recent = null
			return r
		},
	}
	async function calOf(url) {
		if (!cals) await self.calendars()
		const cal = cals.find((c) => c.url === url)
		if (!cal) throw new Error('This commitment has no calendar yet. Try again in a moment.')
		return cal
	}
	return self
}

/** No calendars at all (the engine still works; no blocks). */
const noCalendar = { kind: 'none', calendars: async () => [], events: async () => [] }

module.exports = { appleCalendar, nextcloudCalendar, noCalendar, runHelper, appleId, appleUrl }
