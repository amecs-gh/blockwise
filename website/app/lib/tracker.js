/**
 * Blockwise for Nextcloud — frontend.
 * Plain JavaScript, no build step. Rendered into #tracker-app.
 */
(function () {
	'use strict'

	const APP = 'tracker'
	// Set by the Mac app: API calls go through the app, it shows the notifications,
	// and "Calendar" opens Apple Calendar. Not set in the browser.
	const desktop = window.trackerBridge || null
	// The phone app: its own layout (tabs at the bottom, pages made for a narrow screen)
	const PHONE = !!(desktop && desktop.phone && desktop.account)
	// Everything is rendered as text (never as HTML), so Nextcloud's HTML escaping of
	// the placeholders would only show up as "&lt;" in titles: turn it off.
	const NO_ESCAPE = { escape: false, sanitize: false }
	const tr = (s, vars) => (window.t ? window.t(APP, s, vars, undefined, NO_ESCAPE) : s.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m)))
	const trn = (one, many, count, vars) => (window.n ? window.n(APP, one, many, count, vars, NO_ESCAPE) : (count === 1 ? one : many).replace('%n', count))

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	const locale = (window.OC && OC.getLocale ? OC.getLocale() : navigator.language || 'en').replace('_', '-')
	const fmt = {
		time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }),
		day: new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }),
		dayShort: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'numeric' }),
		month: new Intl.DateTimeFormat(locale, { month: 'short', year: '2-digit' }),
		monthLong: new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }),
		dateTime: new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
	}
	const at = (ts) => new Date(ts * 1000)
	const nowTs = () => Math.floor(Date.now() / 1000)

	function h(tag, attrs, ...children) {
		const el = document.createElement(tag)
		for (const [k, v] of Object.entries(attrs || {})) {
			if (v === null || v === undefined || v === false) continue
			if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
			else if (k === 'style' && typeof v === 'object') {
				for (const [p, val] of Object.entries(v)) {
					if (p.startsWith('--')) el.style.setProperty(p, val)
					else el.style[p] = val
				}
			}
			else if (k === 'class') el.className = v
			else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v
			else el.setAttribute(k, v === true ? '' : v)
		}
		for (const c of children.flat(Infinity)) {
			if (c === null || c === undefined || c === false) continue
			el.append(c instanceof Node ? c : document.createTextNode(String(c)))
		}
		return el
	}
	const svg = (tag, attrs, ...children) => {
		const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
		for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, v)
		for (const c of children.flat(Infinity)) if (c) el.append(c instanceof Node ? c : document.createTextNode(String(c)))
		return el
	}

	function duration(seconds, { short = false } = {}) {
		seconds = Math.max(0, Math.round(seconds))
		const hh = Math.floor(seconds / 3600)
		const mm = Math.floor((seconds % 3600) / 60)
		if (short) return hh ? (mm ? `${hh}h ${String(mm).padStart(2, '0')}m` : `${hh}h`) : `${mm}m`
		if (!hh && !mm) return tr('< 1 min')
		return hh ? `${hh}h ${mm}m` : `${mm} min`
	}
	function clock(seconds) {
		seconds = Math.max(0, Math.round(seconds))
		const hh = Math.floor(seconds / 3600)
		const mm = Math.floor((seconds % 3600) / 60)
		const ss = seconds % 60
		const p = (x) => String(x).padStart(2, '0')
		return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`
	}
	function relativeDay(ts) {
		const d = at(ts)
		const today = startOfDay(new Date())
		const diff = Math.round((startOfDay(d) - today) / 86400000)
		if (diff === 0) return tr('Today')
		if (diff === 1) return tr('Tomorrow')
		if (diff === -1) return tr('Yesterday')
		return fmt.day.format(d)
	}
	/**
	 * "Draft 45m", "Draft 1h", "Draft 1h30", "Draft 1.5h", "Draft 90min" -> { title, estimate (minutes) }.
	 * A trailing number without a unit stays in the title ("Chapter 3").
	 */
	function parseEstimate(line) {
		const m = /^(.*\S)\s+(?:(\d+(?:[.,]\d+)?)\s*h(?:\s*(\d+)\s*(?:m|min)?)?|(\d+)\s*(?:m|min))$/i.exec(line.trim())
		if (!m) return { title: line.trim(), estimate: null }
		const minutes = m[4] ? Number(m[4]) : Math.round(Number(m[2].replace(',', '.')) * 60) + (m[3] ? Number(m[3]) : 0)
		return { title: m[1], estimate: minutes > 0 ? minutes : null }
	}
	const fmtMin = (m) => duration(m * 60, { short: true })
	const defaultEstimate = () => state.settings.defaultEstimate || 15
	/** Minutes of work left: open subtasks, those without an estimate count as the default. */
	const remainingMin = (t) => t.subtasks.filter((x) => !x.done).reduce((sum, x) => sum + (x.estimate ?? defaultEstimate()), 0)

	const blockTime = (b) => `${relativeDay(b.start)}, ${fmt.time.format(at(b.start))}–${fmt.time.format(at(b.end))}`

	function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
	function startOfWeek(d) { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x }
	function startOfMonth(d) { const x = startOfDay(d); x.setDate(1); return x }
	function addPeriod(d, unit, n) {
		const x = new Date(d)
		if (unit === 'day') x.setDate(x.getDate() + n)
		else if (unit === 'week') x.setDate(x.getDate() + 7 * n)
		else x.setMonth(x.getMonth() + n)
		return x
	}

	/** Text color that reads on a given background color. */
	// A commitment's tile: its color with the first letter of its name
	const tile = (c) => h('span', { class: 'imp-tile', style: { '--c': c.color, '--on-c': onColor(c.color) }, 'aria-hidden': 'true' }, [...c.name.trim()][0]?.toUpperCase() || '·')
	function onColor(hex) {
		const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex || '')
		if (!m) return '#fff'
		const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
		return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#1a1a1a' : '#ffffff'
	}

	// ---------------------------------------------------------------------------
	// API
	// ---------------------------------------------------------------------------

	async function api(method, path, body) {
		if (desktop) {
			try {
				return await desktop.api(method, path, body)
			} catch (e) {
				toast(e.message, true)
				e.shown = true
				throw e
			}
		}
		const res = await fetch(OC.generateUrl(`/apps/${APP}/api/${path}`), {
			method,
			headers: {
				requesttoken: OC.requestToken,
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		})
		let data = null
		try { data = await res.json() } catch (e) { /* empty */ }
		if (!res.ok) {
			const msg = (data && data.message && tr(data.message)) || tr('Something went wrong ({status})', { status: res.status })
			toast(msg, true)
			throw Object.assign(new Error(msg), { shown: true })
		}
		return data
	}

	function toast(message, error) {
		// Nextcloud 2x+: OCP.Toast (text only, never HTML); the Mac app provides OC.Notification
		if (window.OCP && OCP.Toast) {
			OCP.Toast[error ? 'error' : 'success'](message, { isHTML: false })
			return
		}
		if (window.OC && OC.Notification) {
			if (error) OC.Notification.showTemporary(message, { type: 'error', isHTML: false })
			else OC.Notification.showTemporary(message, { isHTML: false })
			return
		}
		console[error ? 'error' : 'log'](message)
	}

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------

	const state = {
		route: 'now',
		commitments: [],
		calendars: [],
		settings: {},
		running: null,
		longBreakUntil: null,
		dashboard: null,
		tasksFor: null, // commitment id on the Tasks page
		editingTask: null, // task id whose editor is open
		addingTo: null, // task id with the inline "add subtask" field open on Now
		nowDay: 0, // days from today in Now's day timeline
		// The built-in calendar: day | week | month (the phone: day | 3days | month)
		calView: PHONE ? localStorageGet('calViewPhone', '3days') : localStorageGet('calView', 'week'),
		calDate: new Date(new Date().setHours(0, 0, 0, 0)),
		calScroll: null, // where the time grid was scrolled to
		calBlocks: [],
		doneWeek: 0, // weeks back from this one on the Done page
		notesFor: null, // commitment id on the Notes page
		noteDraft: null, // { for, text, open }: a note being written (kept across re-renders)
		notesTickedOpen: false, // Notes page: ticked notes shown
		noteEdit: null, // { id, text }: the note open in the editor
		expandedNotes: new Set(), // long notes shown in full
		tasks: [],
		period: localStorageGet('period', 'week'),
		offset: 0,
		notified: {},
	}

	function localStorageGet(key, fallback) {
		try { return localStorage.getItem(`tracker.${key}`) || fallback } catch (e) { return fallback }
	}
	function localStorageSet(key, value) {
		try { localStorage.setItem(`tracker.${key}`, value) } catch (e) { /* private mode */ }
	}

	// --- Light or dark: follow the system, or chosen in Settings ---------------------------
	// The Mac app keeps the choice for all its windows (menus too); elsewhere this browser keeps it.
	const THEMES = ['system', 'light', 'dark']
	function applyTheme(mode) {
		const root = document.documentElement
		if (mode === 'light' || mode === 'dark') root.dataset.impTheme = mode
		else delete root.dataset.impTheme
		// Android draws dark mode with a class on the page
		if (root.classList.contains('m3')) root.classList.toggle('m3-dark', mode === 'dark' || (mode !== 'light' && !!window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches))
	}
	const getTheme = async () => (desktop && desktop.appearance ? (await desktop.appearance()) || 'system' : localStorageGet('theme', 'system'))
	async function setTheme(mode) {
		if (!THEMES.includes(mode)) return
		if (desktop && desktop.setAppearance) await desktop.setAppearance(mode)
		else { localStorageSet('theme', mode); applyTheme(mode) }
	}
	if (!(desktop && desktop.appearance)) applyTheme(localStorageGet('theme', 'system'))

	const commitmentById = (id) => state.commitments.find((c) => c.id === id)
	const colorOf = (id) => (id === null ? 'var(--color-text-maxcontrast)' : (commitmentById(id) || {}).color || '#888')
	const nameOf = (id) => (id === null ? tr('Unplanned') : (commitmentById(id) || {}).name || tr('Deleted commitment'))

	async function loadState() {
		const s = await api('GET', 'state')
		state.commitments = s.commitments
		state.calendars = s.calendars
		state.settings = s.settings
		state.running = s.running
		state.longBreakUntil = s.longBreakUntil
		// Apps with Tracker on the device: blocks can be planned here, data syncs later
		state.features = s.features || {}
		state.sync = s.sync || null
	}

	// ---------------------------------------------------------------------------
	// Pomodoro
	// ---------------------------------------------------------------------------

	/**
	 * Phase of a Pomodoro cycle that started at `start`:
	 * focus, short break, focus, ... n focus periods, then the long break
	 * (tracking stops there). Short breaks are tracked time.
	 */
	function pomodoroPhase(start, s, now) {
		const F = s.focusMinutes * 60
		const S = s.shortBreakMinutes * 60
		const n = s.sessionsBeforeLongBreak
		const longAt = start + n * F + (n - 1) * S
		const e = now - start
		if (now >= longAt) return { kind: 'long', round: n, of: n, endsAt: longAt, longAt }
		const i = Math.floor(e / (F + S))
		const inRound = e - i * (F + S)
		if (inRound < F) return { kind: 'focus', round: i + 1, of: n, endsAt: start + i * (F + S) + F, longAt }
		return { kind: 'short', round: i + 1, of: n, endsAt: start + (i + 1) * (F + S), longAt }
	}

	// ---------------------------------------------------------------------------
	// Browser notifications and sound (only while the page is open; Nextcloud
	// notifications from the server cover the phone and a closed browser)
	// ---------------------------------------------------------------------------

	function askNotificationPermission() {
		if (!desktop && 'Notification' in window && Notification.permission === 'default') {
			Notification.requestPermission().catch(() => {})
		}
	}
	function chime() {
		try {
			const ctx = new (window.AudioContext || window.webkitAudioContext)()
			const play = (freq, t0) => {
				const o = ctx.createOscillator()
				const g = ctx.createGain()
				o.frequency.value = freq
				o.type = 'sine'
				g.gain.setValueAtTime(0.0001, ctx.currentTime + t0)
				g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + t0 + 0.02)
				g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t0 + 0.6)
				o.connect(g).connect(ctx.destination)
				o.start(ctx.currentTime + t0)
				o.stop(ctx.currentTime + t0 + 0.65)
			}
			play(660, 0)
			play(880, 0.18)
		} catch (e) { /* no audio */ }
	}
	function alertOnce(key, title, body) {
		if (state.notified[key]) return
		state.notified[key] = true
		if (desktop) return // the Mac app sends these as notifications
		chime()
		if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
			try { new Notification(title, { body, tag: `tracker-${key}` }) } catch (e) { /* ignore */ }
		}
		toast(`${title} — ${body}`)
	}

	// ---------------------------------------------------------------------------
	// Tracking
	// ---------------------------------------------------------------------------

	async function startTracking(commitmentId) {
		askNotificationPermission()
		state.running = await api('POST', 'sessions/start', { commitmentId })
		state.longBreakUntil = null
		await refresh()
	}
	async function stopTracking(opts) {
		const res = await api('POST', 'sessions/stop', opts || {})
		state.running = null
		state.longBreakUntil = res.longBreakUntil
		await refresh()
	}

	/** Current block of the running session's commitment, from the dashboard data. */
	function runningBlock() {
		if (!state.running || !state.dashboard || state.running.commitmentId === null) return null
		const entry = state.dashboard.commitments.find((e) => e.commitment.id === state.running.commitmentId)
		return entry ? entry.currentBlock : null
	}

	/** Called every second. Updates live numbers in place and fires reminders. */
	function tick() {
		const now = nowTs()
		// Nothing to redraw while the page is hidden (the reminders below still run)
		if (!document.hidden) document.querySelectorAll('[data-live]').forEach((el) => {
			const kind = el.dataset.live
			const ts = Number(el.dataset.ts)
			if (kind === 'elapsed') el.textContent = clock(now - ts)
			else if (kind === 'left') el.textContent = clock(ts - now)
			else if (kind === 'left-short') el.textContent = duration(ts - now)
		})
		if (!document.hidden) document.querySelectorAll('[data-now-marker]').forEach((el) => {
			const s = Number(el.dataset.start)
			const e = Number(el.dataset.end)
			el.style.setProperty('--p', `${Math.min(100, Math.max(0, ((now - s) / (e - s)) * 100))}%`)
		})

		const r = state.running
		if (r) {
			const block = runningBlock()
			const reminder = state.settings.reminderMinutes * 60
			if (block && reminder > 0 && block.end - now <= reminder && block.end > now) {
				alertOnce(`end-${block.uid}`, tr('{name}: block ends soon', { name: nameOf(r.commitmentId) }),
					tr('{minutes} min left. Unchecked subtasks move to the next block.', { minutes: Math.ceil((block.end - now) / 60) }))
			}
			if (r.pomodoro) {
				const p = pomodoroPhase(r.start, state.settings, now)
				const key = `pomo-${r.id}-${p.kind}-${p.round}`
				if (p.kind === 'short') alertOnce(key, tr('Short break'), tr('Step away for {minutes} min. The timer keeps running.', { minutes: state.settings.shortBreakMinutes }))
				else if (p.kind === 'focus' && p.round > 1) alertOnce(key, tr('Back to focus'), tr('Round {round} of {of}', { round: p.round, of: p.of }))
				else if (p.kind === 'long' && !state.notified[key]) {
					state.notified[key] = true
					// In the Mac app, the app stops tracking (once, even with the window closed)
					if (!desktop) {
						chime()
						stopTracking({ at: p.longAt, longBreak: true }).catch(() => {})
					}
				}
				const bar = document.querySelector('.imp-pomo')
				if (bar && bar.dataset.phase !== `${p.kind}-${p.round}`) render()
			}
		}
		if (state.longBreakUntil && now >= state.longBreakUntil) {
			alertOnce(`lb-${state.longBreakUntil}`, tr('Break is over'), tr('Press play to start the next focus session.'))
			state.longBreakUntil = null
			render()
		}
	}

	// ---------------------------------------------------------------------------
	// Layout
	// ---------------------------------------------------------------------------

	const ROUTES = [
		{ id: 'now', label: () => tr('Now'), icon: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z' },
		{ id: 'tasks', label: () => tr('Tasks'), icon: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2' },
		{ id: 'notes', label: () => tr('Notes'), icon: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5' },
		{ id: 'done', label: () => tr('Done'), icon: 'M4 12l5 5L20 6' },
		{ id: 'time', label: () => tr('Time'), icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
		{ id: 'settings', label: () => tr('Settings'), icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z' },
	]
	const icon = (d, size = 20, filled = false) => svg('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: filled ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, svg('path', { d }))
	const ICON_PLAY = 'M8 5.5v13l11-6.5z'
	const ICON_CAL = 'M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'
	const ICON_STOP = 'M7 7h10v10H7z'

	// Blockwise's mark, as on the app icon: a white block over an amber one, forming a "B"
	const LOGO = [['#ffffff', 'M33 19H54a14 14 0 0 1 0 28H33a4 4 0 0 1-4-4V23a4 4 0 0 1 4-4z'], ['#f4a62a', 'M33 52h26.5a14.5 14.5 0 0 1 0 29H33a4 4 0 0 1-4-4V56a4 4 0 0 1 4-4z']]
	function navigation() {
		// ext: opens something outside the page (the calendar app): an arrow after the label
		const link = (href, label, d, active, onclick, ext = !!onclick) => h('li', null, h('a', { href, title: label, class: active ? 'active' : '', 'aria-current': active ? 'page' : null, onclick },
			icon(d), h('span', null, label), ext ? h('span', { class: 'imp-nav__ext', 'aria-hidden': 'true' }, '↗') : null))
		// Calendar: Blockwise's calendar page where blocks can be changed; else the calendar app
		const cal = calendarShown() ? link('#calendar', tr('Calendar'), ICON_CAL, state.route === 'calendar')
			: desktop && !state.features.calendarView ? link('#', tr('Calendar'), ICON_CAL, false, (e) => { e.preventDefault(); desktop.openCalendar() }) : null
		const routes = ROUTES.map((r) => link(`#${r.id}`, r.label(), r.icon, state.route === r.id))
		// Phones keep the calendar and the account sheet in the top bar, the rest in the bottom tabs
		const phone = !!(desktop && desktop.phone && desktop.account)
		// The web app: an account entry at the end of the tabs (sync, export, data in this browser)
		const account = !phone && desktop && desktop.account
			? link('#', tr('Account'), 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0', false, (e) => { e.preventDefault(); desktop.account() }, false)
			: null
		return h('nav', { class: 'imp-nav', 'aria-label': tr('Main') },
			h('a', { class: 'imp-nav__logo', href: '#now', title: 'Blockwise' }, svg('svg', { viewBox: '20.5 19 62 62', width: 26, height: 26, 'aria-hidden': 'true' }, LOGO.map(([fill, d]) => svg('path', { fill, d })))),
			h('ul', { class: 'imp-nav__main' }, phone ? routes : [routes[0], cal, ...routes.slice(1), account]),
			phone ? h('ul', { class: 'imp-nav__main imp-nav__apps' }, cal,
				link('#', tr('Account'), 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0', false, (e) => { e.preventDefault(); desktop.account() })) : null,
			h('div', { class: 'imp-nav__heading' }, tr('Commitments')),
			hscroll(h('ul', { class: 'imp-nav__commitments' },
				state.commitments.map((c) => h('li', null,
					h('a', { href: `#c/${c.id}`, title: c.name, style: { '--c': c.color }, class: state.route === 'commitment' && state.commitmentId === c.id ? 'active' : '', 'aria-current': state.route === 'commitment' && state.commitmentId === c.id ? 'page' : null },
						h('span', { class: 'imp-dot', style: { background: c.color } }),
						h('span', { class: 'imp-nav__name' }, c.name),
						c.calendarId === null && state.features.calendars !== false ? h('span', { class: 'imp-nav__warn', title: tr('No calendar linked') }, '!') : null))),
				h('li', { class: 'imp-nav__addli' }, h('a', { href: '#settings', class: 'imp-nav__add', title: tr('New commitment'), onclick: () => { state.creatingCommitment = true; state.editingCommitment = null } }, '+ ', h('span', null, tr('New commitment')))))),
		)
	}

	/** The Calendar page: where the app has one, unless turned off in Settings */
	const calendarShown = () => !!state.features.calendarView && state.settings.showCalendar !== false

	/** A page's title: its icon on an accent tile, the name, a line of context, and actions on the right */
	function pageHeader(route, subtitle, ...actions) {
		const r = ROUTES.find((x) => x.id === route)
		return h('header', { class: 'imp-phead' },
			h('span', { class: 'imp-phead__icon', 'aria-hidden': 'true' }, icon(r.icon, 22)),
			h('div', { class: 'imp-phead__text' }, h('h1', null, r.label()), subtitle ? h('p', null, subtitle) : null),
			actions.length ? h('div', { class: 'imp-phead__actions' }, actions) : null)
	}

	/** A chevron for previous / next buttons (drawn, so it sits centered in its button) */
	const chevron = (dir) => svg('svg', { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
		svg('path', { d: dir < 0 ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7' }))

	/**
	 * A row that scrolls sideways when it doesn't fit (many commitments): the
	 * mouse wheel scrolls it too, the edges fade where there is more, and
	 * prev/next buttons (if given) appear only when there is more that way.
	 */
	function hscroll(el, prev, next) {
		const update = () => {
			const more = el.scrollWidth - el.clientWidth > 2
			const left = more && el.scrollLeft > 2
			const right = more && el.scrollLeft < el.scrollWidth - el.clientWidth - 2
			el.classList.toggle('imp-hs--left', left)
			el.classList.toggle('imp-hs--right', right)
			if (prev) { prev.hidden = !more; prev.disabled = !left }
			if (next) { next.hidden = !more; next.disabled = !right }
		}
		el.classList.add('imp-hs')
		el.addEventListener('scroll', update, { passive: true })
		// A vertical wheel moves the row sideways, unless something inside scrolls that way
		el.addEventListener('wheel', (e) => {
			if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || el.scrollWidth <= el.clientWidth) return
			for (let n = e.target; n && n !== el; n = n.parentElement) if (n.scrollHeight > n.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(n).overflowY)) return
			e.preventDefault()
			el.scrollLeft += e.deltaY
		}, { passive: false })
		const step = (dir) => {
			const first = el.firstElementChild
			const w = first ? first.getBoundingClientRect().width + 16 : el.clientWidth / 2
			el.scrollBy({ left: dir * Math.max(w, Math.floor(el.clientWidth / w) * w), behavior: 'smooth' })
		}
		if (prev) prev.addEventListener('click', () => step(-1))
		if (next) next.addEventListener('click', () => step(1))
		if (typeof ResizeObserver === 'function') new ResizeObserver(update).observe(el)
		requestAnimationFrame(update)
		return el
	}

	// The newest render wins: a tap on another tab while a page is being built isn't lost
	let renderSeq = 0
	let shownRoute = null
	async function render() {
		const seq = ++renderSeq
		const root = document.getElementById('tracker-app')
		const route = state.route
		const layout = (main) => PHONE
			? h('div', { class: 'imp-layout imp-layout--phone' }, main, miniTimer(), phoneTabs())
			: h('div', { class: 'imp-layout' }, navigation(), main)
		// An open calendar panel stays open across a re-render
		const panels = () => root.querySelectorAll(':scope > .imp-cvpanel')
		// Another tab shows at once: the tab lit and the page as placeholders while it is built
		const shell = route === shownRoute ? null : setTimeout(() => {
			if (seq !== renderSeq) return
			root.replaceChildren(layout(h('main', { class: 'imp-main', id: 'imp-main', 'aria-busy': 'true' }, skeleton())), ...panels())
		}, 60)
		const main = h('main', { class: 'imp-main', id: 'imp-main' })
		try {
			const page = await PAGES[route]()
			main.append(page)
			// A page that turns with a sideways swipe: anywhere on the screen, even below a short list
			if (page.swipe) { swipeSides(main, ...page.swipe); main.classList.add('imp-main--swipe') }
		} catch (e) {
			console.error(e)
			main.append(h('p', { class: 'imp-empty' }, tr('This page could not be loaded. Reload to try again.')))
		}
		clearTimeout(shell)
		if (seq !== renderSeq) return // a newer render (another tab, fresher data) took over
		const scroll = route === shownRoute ? (document.getElementById('imp-main')?.scrollTop || 0) : 0
		root.replaceChildren(layout(main), ...panels())
		shownRoute = route
		// The window's (or browser tab's) title says where you are
		const here = state.route === 'commitment' ? commitmentById(state.commitmentId)?.name : state.route === 'calendar' ? tr('Calendar') : state.route === 'progress' ? tr('Progress') : ROUTES.find((r) => r.id === state.route)?.label()
		if (here) document.title = `${here} · Blockwise`
		main.scrollTop = scroll
		if (state.refocus) {
			document.getElementById(state.refocus)?.focus()
			state.refocus = null
		}
	}

	/** A page that is still being built: grey shapes that shimmer (still with reduced motion) */
	function skeleton() {
		const bar = (w, ht = 12) => h('span', { class: 'imp-sk', style: { width: w, height: `${ht}px` } })
		const card = (n) => h('div', { class: 'imp-skcard' }, Array.from({ length: n }, (_, i) => h('div', { class: 'imp-skrow' },
			h('span', { class: 'imp-sk imp-sk--tile' }),
			h('span', { class: 'imp-skrow__text' }, bar(`${40 + ((i * 17) % 30)}%`), bar(`${55 + ((i * 13) % 30)}%`, 10)))))
		return h('div', { class: 'imp-page imp-skpage', role: 'status', 'aria-label': tr('Loading…') },
			h('div', { class: 'imp-skhead' }, bar('38%', 24), bar('24%', 12)), card(3), card(2))
	}

	async function refresh() {
		if (state.route === 'now') state.dashboard = null
		await loadState()
		await render()
	}

	// ---------------------------------------------------------------------------
	// Page: Now (control panel)
	// ---------------------------------------------------------------------------

	async function pageNow() {
		const weekStart = Math.floor(startOfWeek(new Date()) / 1000)
		const weekEnd = Math.floor(addPeriod(startOfWeek(new Date()), 'week', 1) / 1000)
		const [dash, weekSessions] = await Promise.all([
			api('GET', 'dashboard'),
			api('GET', `sessions?from=${weekStart}&to=${weekEnd}`),
		])
		state.dashboard = dash
		const d = state.dashboard
		const nowS = nowTs()
		d.week = { start: weekStart, end: weekEnd, tracked: {} }
		for (const x of weekSessions) {
			const sec = overlapSeconds(x.start, x.end ?? nowS, weekStart, weekEnd)
			d.week.tracked[x.commitmentId] = (d.week.tracked[x.commitmentId] || 0) + sec
		}
		state.running = d.running
		state.longBreakUntil = d.longBreakUntil
		state.settings = d.settings
		// The day on the left; the timer, what to do in this block and the commitments on the right
		// Left: the day and the commitments; right: the timer and this block. On wide
		// windows the page stays put and only the block's tasks scroll.
		const main = h('div', { class: 'imp-now__main' }, timerStrip(d))
		const side = h('div', { class: 'imp-now__side' }, dayCard())
		const page = h('div', { class: 'imp-page imp-now' }, side, main)

		if (d.overlaps.length) {
			main.append(h('section', { class: 'imp-warning', role: 'alert' },
				h('strong', null, trn('%n overlap between commitments', '%n overlaps between commitments', d.overlaps.length)),
				h('ul', null, d.overlaps.slice(0, 5).map((o) => h('li', null,
					h('span', { class: 'imp-dot', style: { background: colorOf(o.a.commitmentId) } }), o.a.title || nameOf(o.a.commitmentId),
					' & ',
					h('span', { class: 'imp-dot', style: { background: colorOf(o.b.commitmentId) } }), o.b.title || nameOf(o.b.commitmentId),
					h('span', { class: 'imp-muted' }, ` — ${relativeDay(o.start)}, ${fmt.time.format(at(o.start))}–${fmt.time.format(at(o.end))}`)))),
				h('p', { class: 'imp-muted' }, tr('Move one of them in the Calendar app.'))))
		}

		if (!d.commitments.length) {
			main.append(h('div', { class: 'imp-empty' },
				h('p', null, tr('Create your first commitment, for example Thesis or Work. It gets its own calendar: every event you put there is a work block.')),
				h('a', { class: 'imp-button imp-button--primary', href: '#settings' }, tr('Create a commitment'))))
			return page
		}
		main.append(blockCard(d))
		return page
	}

	/**
	 * Now: every commitment as a round tile in the day card, its weekly goal as a
	 * ring around it (dashed: no goal). Tap the tile to start (or stop) tracking,
	 * the name to open it. The one tracking first, then those with a block
	 * today (soonest first), then the rest; many scroll sideways.
	 */
	function goalRings(d) {
		if (!d || !d.commitments.length) return null
		const endToday = Math.floor(addPeriod(new Date(new Date().setHours(0, 0, 0, 0)), 'day', 1) / 1000)
		const rank = (e) => {
			if (d.running && d.running.commitmentId === e.commitment.id) return [0, 0]
			const b = e.currentBlock || e.nextBlock
			return b && b.start < endToday ? [1, b.start] : [2, 0]
		}
		const items = d.commitments.map((e, i) => ({ e, i, r: rank(e) }))
			.sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.i - b.i)
		const R = 27
		const C = 2 * Math.PI * R
		const prev = h('button', { type: 'button', class: 'imp-icon-btn imp-rings__prev', 'aria-label': tr('Previous commitments'), hidden: true }, chevron(-1))
		const next = h('button', { type: 'button', class: 'imp-icon-btn imp-rings__next', 'aria-label': tr('More commitments'), hidden: true }, chevron(1))
		const ring = ({ e }) => {
			const c = e.commitment
			const running = !!(d.running && d.running.commitmentId === c.id)
			const done = d.week ? (d.week.tracked[c.id] || 0) / 60 : 0
			const goal = c.weeklyGoal
			const frac = goal ? Math.min(1, done / goal) : 0
			const goalText = goal ? `${fmtMin(Math.floor(done))} / ${fmtMin(goal)}` : ''
			const block = e.currentBlock || e.nextBlock
			const about = [goal ? tr('{done} of {goal} this week', { done: fmtMin(Math.floor(done)), goal: fmtMin(goal) }) : tr('No weekly goal'),
				c.calendarId === null ? tr('No calendar linked') : block ? blockTime(block) : tr('No block planned')].join(' · ')
			return h('li', { class: `imp-ring ${running ? 'is-running' : ''} ${goal && done >= goal ? 'is-reached' : ''}`, style: { '--c': c.color, '--on-c': onColor(c.color) } },
				h('button', {
					type: 'button',
					class: 'imp-ring__dial',
					onclick: () => (running ? stopTracking() : startTracking(c.id)),
					'aria-label': `${running ? tr('Stop tracking {name}', { name: c.name }) : tr('Start tracking {name}', { name: c.name })} · ${about}`,
					title: about,
				},
				svg('svg', { class: 'imp-ring__svg', viewBox: '0 0 60 60', 'aria-hidden': 'true' },
					goal ? [
						svg('circle', { cx: 30, cy: 30, r: R, class: 'imp-ring__track' }),
						svg('circle', { cx: 30, cy: 30, r: R, class: 'imp-ring__fill', 'stroke-dasharray': `${(C * frac).toFixed(1)} ${C.toFixed(1)}`, transform: 'rotate(-90 30 30)' }),
					] : svg('circle', { cx: 30, cy: 30, r: R, class: 'imp-ring__none' })),
				h('span', { class: 'imp-ring__tile' }, c.name.trim().charAt(0).toUpperCase() || '?'),
				h('span', { class: 'imp-ring__badge' }, icon(running ? ICON_STOP : ICON_PLAY, 10, true))),
				h('a', { class: 'imp-ring__name', href: `#c/${c.id}` }, c.name),
				h('span', { class: 'imp-ring__goal' }, goalText))
		}
		return h('div', { class: 'imp-rings' },
			hscroll(h('ul', { class: 'imp-rings__row', 'aria-label': tr('Commitments') }, items.map(ring)), prev, next),
			prev, next)
	}

	/**
	 * Next 7 days: block time in the calendar vs. the time the open tasks need.
	 * Subtasks without an estimate count with the default estimate.
	 */
	function capacityLine(entry) {
		const cap = entry.capacity
		if (!cap || (!cap.blockSeconds && !cap.neededSeconds)) return null
		const blocks = cap.blockSeconds
		const needed = cap.neededSeconds
		const over = needed - blocks
		let note = null
		if (!needed) note = h('span', { class: 'imp-muted' }, tr('No tasks for this time yet'))
		else if (!blocks) note = h('span', { class: 'imp-cap__warn' }, tr('No blocks for these tasks'))
		else if (over > 60) note = h('span', { class: 'imp-cap__warn' }, tr('{time} more than the blocks', { time: duration(over, { short: true }) }))
		else note = h('span', { class: 'imp-cap__ok' }, tr('Fits'))
		const pct = blocks ? Math.min(100, (needed / blocks) * 100) : 100
		return h('div', { class: 'imp-cap', title: tr('Next 7 days: time in calendar blocks and time the open tasks need') },
			h('div', { class: 'imp-cap__text' },
				h('span', null, tr('Next 7 days: {blocks} in blocks · {needed} of tasks', {
					blocks: duration(blocks, { short: true }),
					needed: duration(needed, { short: true }),
				})),
				note),
			h('div', { class: `imp-cap__bar ${over > 60 ? 'is-over' : ''}`, 'aria-hidden': 'true' },
				h('div', { class: 'imp-cap__fill', style: { width: `${pct}%` } })))
	}

	/** "6h 20m of 15h this week" with a bar; nothing without a goal. */
	function goalProgress(c, d, compact) {
		if (!c.weeklyGoal) return null
		const done = (d.week.tracked[c.id] || 0) / 60
		const pct = Math.min(100, (done / c.weeklyGoal) * 100)
		const reached = done >= c.weeklyGoal
		return h('div', { class: `imp-goal ${compact ? 'imp-goal--compact' : ''} ${reached ? 'is-reached' : ''}` },
			h('div', { class: 'imp-goal__text' },
				h('span', null, tr('{done} of {goal} this week', { done: fmtMin(Math.floor(done)), goal: fmtMin(c.weeklyGoal) })),
				reached ? h('span', { class: 'imp-goal__ok' }, tr('Goal reached')) : h('span', { class: 'imp-muted' }, tr('{left} to go', { left: fmtMin(Math.ceil(c.weeklyGoal - done)) }))),
			h('div', { class: 'imp-goal__bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': c.weeklyGoal, 'aria-valuenow': Math.floor(done), 'aria-label': tr('Weekly goal for {name}', { name: c.name }) },
				h('div', { class: 'imp-goal__fill', style: { width: `${pct}%` } })))
	}

	// ---------------------------------------------------------------------------
	// Popover (hover / focus / tap) used by the week timeline
	// ---------------------------------------------------------------------------

	let popEl = null
	let popHide = null
	/** @param {object} opts onClick: what a click does instead of toggling the popover */
	function popover(target, build, opts = {}) {
		const show = () => {
			clearTimeout(popHide)
			if (!popEl) {
				popEl = h('div', { class: 'imp-pop', role: 'tooltip', id: 'imp-pop' })
				popEl.addEventListener('mouseenter', () => clearTimeout(popHide))
				popEl.addEventListener('mouseleave', hide)
				document.body.append(popEl)
			}
			// Leave out empty parts (a day without overlaps, a block without a title)
			popEl.replaceChildren(...[build()].flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false))
			popEl.hidden = false
			const r = target.getBoundingClientRect()
			const pw = Math.min(340, window.innerWidth - 24)
			popEl.style.width = `${pw}px`
			const left = Math.min(Math.max(12, r.left + r.width / 2 - pw / 2), window.innerWidth - pw - 12)
			popEl.style.left = `${left + window.scrollX}px`
			const below = r.bottom + 8
			popEl.style.top = '0px'
			const ph = popEl.offsetHeight
			const top = below + ph > window.innerHeight - 8 ? r.top - ph - 8 : below
			popEl.style.top = `${Math.max(8, top) + window.scrollY}px`
			target.setAttribute('aria-describedby', 'imp-pop')
		}
		const hide = () => {
			popHide = setTimeout(() => { if (popEl) popEl.hidden = true; target.removeAttribute('aria-describedby') }, 120)
		}
		target.addEventListener('mouseenter', show)
		target.addEventListener('mouseleave', hide)
		target.addEventListener('focus', show)
		target.addEventListener('blur', hide)
		target.addEventListener('click', (e) => {
			e.stopPropagation()
			if (opts.onClick) {
				if (popEl) popEl.hidden = true
				opts.onClick(e)
				return
			}
			popEl && !popEl.hidden ? hide() : show()
		})
		return target
	}
	document.addEventListener('click', () => { if (popEl) popEl.hidden = true })
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && popEl) popEl.hidden = true })

	/** "3 subtasks checked off", "2 notes ticked", or both */
	function doneCount(items) {
		const notes = items.filter((i) => i.kind === 'note').length
		const subs = items.length - notes
		if (!notes) return trn('%n subtask checked off', '%n subtasks checked off', subs)
		if (!subs) return trn('%n note ticked', '%n notes ticked', notes)
		return `${trn('%n subtask checked off', '%n subtasks checked off', subs)}, ${trn('%n note ticked', '%n notes ticked', notes)}`
	}

	function doneList(items, empty) {
		if (!items.length) return h('p', { class: 'imp-pop__empty' }, empty)
		return h('ul', { class: 'imp-pop__list' }, items.slice(0, 12).map((i) => h('li', null,
			h('span', { class: 'imp-pop__check', 'aria-hidden': 'true' }, '✓'),
			h('span', null, i.title,
				i.kind === 'note' ? h('span', { class: 'imp-muted' }, ` — ${tr('note')}`)
					: i.task && i.title !== i.task ? h('span', { class: 'imp-muted' }, ` — ${i.task}`) : null),
			h('time', { class: 'imp-muted' }, fmt.time.format(at(i.doneAt))))),
		items.length > 12 ? h('li', { class: 'imp-muted' }, trn('and %n more', 'and %n more', items.length - 12)) : null)
	}

	/**
	 * Monday–Sunday, one row per day on a shared time axis:
	 * planned blocks (tinted), tracked time (solid bar), checked-off subtasks
	 * (dots) and overlaps (hatched). Everything shows details on hover, focus or tap.
	 *
	 * @param {object} w { start, blocks, overlaps, sessions, done }
	 * @param {boolean} large taller rows with done dots and per-day counts
	 */
	function weekTimeline(w, large) {
		const now = nowTs()
		const days = Array.from({ length: 7 }, (_, i) => {
			const start = Math.floor(addPeriod(new Date(w.start * 1000), 'day', i) / 1000)
			return { start, end: Math.floor(addPeriod(new Date(w.start * 1000), 'day', i + 1) / 1000), date: at(start) }
		})
		const sessions = (w.sessions || []).map((x) => ({ ...x, end: x.end ?? now }))
		const done = w.done || []
		// Visible hours: everything on the week, at least 8:00–18:00
		let minH = 8
		let maxH = 18
		const spanOf = (s0, e0) => {
			const day = days.find((x) => s0 < x.end && e0 > x.start)
			if (!day) return
			minH = Math.min(minH, Math.floor((Math.max(s0, day.start) - day.start) / 3600))
			maxH = Math.max(maxH, Math.ceil((Math.min(e0, day.end) - day.start) / 3600))
		}
		w.blocks.forEach((b) => spanOf(b.start, b.end))
		sessions.forEach((x) => spanOf(x.start, x.end))
		done.forEach((i) => spanOf(i.doneAt, i.doneAt + 1))
		maxH = Math.min(24, Math.max(maxH, minH + 4))
		const span = (maxH - minH) * 3600
		const pos = (ts, day) => Math.min(100, Math.max(0, ((ts - day.start - minH * 3600) / span) * 100))
		const place = (el, from, to, day) => {
			const l = pos(Math.max(from, day.start), day)
			const r = pos(Math.min(to, day.end), day)
			if (r <= l) return null
			el.style.left = `${l}%`
			el.style.width = `${r - l}%`
			return el
		}
		const timeRange = (a, b) => `${fmt.time.format(at(a))}–${fmt.time.format(at(b))}`
		const doneBetween = (a, b, cid) => done.filter((i) => i.doneAt >= a && i.doneAt < b && (cid === undefined || i.commitmentId === cid))
		const trackedIn = (a, b, cid) => sessions.filter((x) => x.commitmentId === cid).reduce((sum, x) => sum + overlapSeconds(x.start, x.end, a, b), 0)
		const step = maxH - minH > 12 ? 3 : 2
		const ticks = []
		for (let hh = minH; hh <= maxH; hh += step) ticks.push(hh)

		const rows = days.map((day) => {
			const isToday = now >= day.start && now < day.end
			const track = h('div', { class: 'imp-tl__track' },
				ticks.slice(1, -1).map((hh) => h('span', { class: 'imp-tl__grid', style: { left: `${((hh - minH) / (maxH - minH)) * 100}%` } })))

			w.blocks.filter((b) => b.start < day.end && b.end > day.start).forEach((b) => {
				const el = place(h('button', {
					type: 'button',
					class: 'imp-tl__block',
					style: { '--c': colorOf(b.commitmentId) },
					'aria-label': `${nameOf(b.commitmentId)} ${timeRange(b.start, b.end)}`,
				}), b.start, b.end, day)
				if (!el) return
				track.append(popover(el, () => {
					const items = doneBetween(b.start, b.end, b.commitmentId)
					const tracked = trackedIn(b.start, b.end, b.commitmentId)
					return [
						h('div', { class: 'imp-pop__head', style: { '--c': colorOf(b.commitmentId) } },
							h('strong', null, nameOf(b.commitmentId)),
							h('span', { class: 'imp-muted' }, `${fmt.day.format(at(b.start))}, ${timeRange(b.start, b.end)}`)),
						b.title ? h('div', { class: 'imp-pop__title' }, b.title) : null,
						h('div', { class: 'imp-pop__meta' },
							tr('Planned {time}', { time: duration(b.end - b.start, { short: true }) }),
							b.start < now ? ` · ${tr('tracked {time}', { time: duration(tracked, { short: true }) })}` : ''),
						b.start < now ? doneList(items, tr('Nothing checked off in this block.')) : h('p', { class: 'imp-pop__empty' }, tr('Not started yet.')),
						w.onAddTime && b.start < now && tracked === 0
							? h('button', { type: 'button', class: 'imp-link imp-pop__action', onclick: (e) => { e.stopPropagation(); if (popEl) popEl.hidden = true; w.onAddTime(el, { commitmentId: b.commitmentId, start: b.start, end: Math.min(b.end, now) }) } }, tr('I worked in this block, add it'))
							: null,
					]
				}))
			})

			sessions.filter((x) => x.start < day.end && x.end > day.start).forEach((x) => {
				const el = place(h('button', {
					type: 'button',
					class: 'imp-tl__session',
					style: { '--c': colorOf(x.commitmentId) },
					'aria-label': `${tr('Tracked')} ${nameOf(x.commitmentId)} ${timeRange(x.start, x.end)}`,
				}), x.start, x.end, day)
				if (!el) return
				track.append(popover(el, () => [
					h('div', { class: 'imp-pop__head', style: { '--c': colorOf(x.commitmentId) } },
						h('strong', null, tr('Tracked: {name}', { name: nameOf(x.commitmentId) })),
						h('span', { class: 'imp-muted' }, timeRange(x.start, x.end))),
					h('div', { class: 'imp-pop__meta' }, duration(x.end - x.start, { short: true }), x.end >= now - 1 ? ` · ${tr('running')}` : ''),
					doneList(doneBetween(x.start, x.end), tr('Nothing checked off while tracking.')),
				]))
			})

			w.overlaps.filter((o) => o.start < day.end && o.end > day.start).forEach((o) => {
				const el = place(h('div', { class: 'imp-tl__overlap', title: tr('Overlap: {a} and {b}', { a: o.a.title || nameOf(o.a.commitmentId), b: o.b.title || nameOf(o.b.commitmentId) }) }), o.start, o.end, day)
				if (el) track.append(el)
			})

			if (large) {
				// Dots for checked-off subtasks; close ones share a dot
				const dayDone = done.filter((i) => i.doneAt >= day.start && i.doneAt < day.end).sort((a, b) => a.doneAt - b.doneAt)
				const groups = []
				dayDone.forEach((i) => {
					const g = groups[groups.length - 1]
					if (g && i.doneAt - g[g.length - 1].doneAt < span / 120) g.push(i)
					else groups.push([i])
				})
				groups.forEach((g) => {
					const el = h('button', {
						type: 'button',
						class: `imp-tl__dot ${g.length > 1 ? 'is-multi' : ''}`,
						style: { left: `${pos(g[0].doneAt, day)}%`, '--c': colorOf(g[0].commitmentId) },
						'aria-label': doneCount(g),
					}, g.length > 1 ? String(g.length) : '')
					track.append(popover(el, () => [
						h('div', { class: 'imp-pop__head' }, h('strong', null, doneCount(g))),
						doneList(g, ''),
					]))
				})
			}

			if (isToday) track.append(h('div', { class: 'imp-tl__now', style: { left: `${pos(now, day)}%` } }))
			const count = done.filter((i) => i.doneAt >= day.start && i.doneAt < day.end).length
			return h('div', { class: `imp-tl__row ${isToday ? 'is-today' : ''} ${day.end <= now ? 'is-past' : ''}` },
				h('span', { class: 'imp-tl__day' }, fmt.day.format(day.date)),
				track,
				large ? h('span', { class: 'imp-tl__count', title: doneCount(done.filter((i) => i.doneAt >= day.start && i.doneAt < day.end)) }, count ? `✓ ${count}` : '') : null)
		})

		return h('div', { class: `imp-tl ${large ? 'imp-tl--large' : ''}` },
			h('div', { class: 'imp-tl__axis', 'aria-hidden': 'true' }, h('span'),
				h('div', { class: 'imp-tl__ticks' }, ticks.map((hh) => h('span', { style: { left: `${((hh - minH) / (maxH - minH)) * 100}%` } }, `${hh}:00`))),
				large ? h('span') : null),
			rows)
	}

	function timelineLegend(large) {
		return h('div', { class: 'imp-tl__legend' },
			h('span', null, h('span', { class: 'imp-tl__key imp-tl__key--block' }), tr('Planned block')),
			h('span', null, h('span', { class: 'imp-tl__key imp-tl__key--session' }), tr('Tracked')),
			large ? h('span', null, h('span', { class: 'imp-tl__key imp-tl__key--dot' }), tr('Subtask or note checked off')) : null,
			h('span', { class: 'imp-muted' }, tr('Hover or tap for details')))
	}

	/**
	 * Small month calendar for the Now page: each day shows the planned time of
	 * every commitment as colored segments; days with overlaps get a red mark.
	 * Hover, focus or tap a day for its blocks; the popover links to the Calendar app.
	 */
	const hourMin = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' })
	/** The day as a timeline: each block a pill as tall as it is long (‹ › for other days) */
	function dayCard() {
		const el = h('section', { class: 'imp-day', 'aria-label': tr('Day') })
		fillDay(el)
		return el
	}

	async function fillDay(el) {
		const day = addPeriod(new Date(new Date().setHours(0, 0, 0, 0)), 'day', state.nowDay)
		const from = Math.floor(day / 1000)
		const to = Math.floor(addPeriod(day, 'day', 1) / 1000)
		// Drawn at once with what was loaded last time (the phone's calendar can be slow), then updated
		const cached = state.dayCache && state.dayCache.from === from ? state.dayCache.blocks : null
		drawDay(el, day, from, to, cached)
		let blocks = []
		try { blocks = (await api('GET', `blocks?from=${from}&to=${to}`)).blocks } catch (e) { /* toast shown */ }
		blocks = blocks.filter((b) => b.start < to && b.end > from).sort((a, b) => a.start - b.start)
		state.dayCache = { from, blocks }
		drawDay(el, day, from, to, blocks)
	}

	function drawDay(el, day, from, to, blocks) {
		const now = nowTs()
		const d = state.dashboard
		const nav = (delta) => { state.nowDay = delta && state.nowDay + delta; fillDay(el) }
		const planned = (blocks || []).reduce((sum, b) => sum + Math.min(b.end, to) - Math.max(b.start, from), 0)
		const item = (b) => {
			const c = commitmentById(b.commitmentId) || { id: b.commitmentId, name: nameOf(b.commitmentId), color: colorOf(b.commitmentId) }
			const entry = d && d.commitments.find((e) => e.commitment.id === c.id)
			const inside = b.start <= now && now < b.end
			const isNext = !inside && entry && entry.nextBlock && entry.nextBlock.start === b.start
			const tasks = entry && (inside || isNext) ? entry.plannedTaskIds.length : 0
			const min = (b.end - b.start) / 60
			const range = `${hourMin.format(at(b.start))} – ${hourMin.format(at(b.end))}`
			const running = d && d.running && d.running.commitmentId === c.id
			const pill = b.end > now && !running
				? h('button', { type: 'button', class: 'imp-day__pill', onclick: () => startTracking(c.id), title: tr('Start'), 'aria-label': tr('Start tracking {name}', { name: c.name }) }, c.name.trim().charAt(0).toUpperCase(), icon(ICON_PLAY, 14, true))
				: h('span', { class: 'imp-day__pill', 'aria-hidden': 'true' }, c.name.trim().charAt(0).toUpperCase())
			return h('li', { class: `imp-day__item ${inside ? 'is-now' : ''} ${b.end <= now ? 'is-past' : ''}`, style: { '--c': c.color, '--on-c': onColor(c.color), '--h': `${Math.round(Math.min(140, Math.max(46, 20 + min * 0.85)))}px` } },
				h('span', { class: 'imp-day__time' }, hourMin.format(at(b.start))),
				pill,
				h('a', { class: 'imp-day__text', href: `#c/${c.id}` },
					h('span', { class: 'imp-muted' }, range),
					h('strong', null, c.name, b.title ? ` · ${b.title}` : ''),
					inside ? h('span', { class: 'imp-day__sub is-now' }, tr('Now'), ' · ', h('span', { 'data-live': 'left-short', 'data-ts': b.end }, duration(b.end - now)), ' ', tr('left'))
						: tasks ? h('span', { class: 'imp-day__sub' }, trn('%n task', '%n tasks', tasks)) : null))
		}
		el.replaceChildren(
			h('header', { class: 'imp-day__head' },
				h('div', null,
					h('h2', null, new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(day)),
					h('p', { class: 'imp-muted' }, new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' }).format(day),
						planned ? ` · ${tr('{hours} planned', { hours: fmtMin(Math.round(planned / 60)) })}` : '')),
				h('div', { class: 'imp-arrows imp-day__nav' },
					state.nowDay ? h('button', { class: 'imp-button', onclick: () => nav(0) }, tr('Today')) : null,
					h('button', { class: 'imp-icon-btn', 'aria-label': tr('Previous day'), title: tr('Previous day'), onclick: () => nav(-1) }, chevron(-1)),
					h('button', { class: 'imp-icon-btn', 'aria-label': tr('Next day'), title: tr('Next day'), onclick: () => nav(1) }, chevron(1)))),
			goalRings(d),
			!blocks ? h('p', { class: 'imp-muted imp-day__empty', 'data-loading': '' }, tr('Loading…'))
				: blocks.length
					? h('ol', { class: 'imp-day__list' }, blocks.map(item))
				: h('p', { class: 'imp-muted imp-day__empty' }, tr('No blocks planned.'), ' ', calendarShown() ? h('a', { href: '#calendar' }, tr('Plan a block')) : null))
	}

	/** You started before pressing play: move the running session's start back */
	function startMenu(anchor, r) {
		const move = async (start, close) => {
			close()
			try {
				const s = await api('PUT', `sessions/${r.id}`, { start })
				if (s.clamped) toast(tr('Started at {time}: the session before ended then.', { time: fmt.time.format(at(s.start)) }))
			} catch (e) { /* toast shown */ }
			refresh()
		}
		// Like the estimate menu: preset chips, or type the time and press Enter
		const input = h('input', {
			type: 'time',
			class: 'imp-menu__input',
			value: `${String(at(r.start).getHours()).padStart(2, '0')}:${String(at(r.start).getMinutes()).padStart(2, '0')}`,
			'aria-label': tr('Started at'),
			onkeydown: (e) => {
				if (e.key !== 'Enter' || !input.value) return
				e.preventDefault()
				const [hh, mm] = input.value.split(':').map(Number)
				const d = at(nowTs())
				d.setHours(hh, mm, 0, 0)
				// A time later than now: yesterday (past midnight)
				if (d.getTime() / 1000 > nowTs()) d.setDate(d.getDate() - 1)
				move(Math.floor(d.getTime() / 1000), closeMenu)
			},
		})
		openMenu(anchor, (close) => [
			h('p', { class: 'imp-menu__hint' }, tr('I started earlier')),
			h('div', { class: 'imp-menu__chips' }, [5, 10, 15, 30].map((m) => h('button', { type: 'button', class: 'imp-chip', autofocus: m === 5, onclick: () => move(r.start - m * 60, close) }, `−${tr('{n} min', { n: m })}`))),
			input,
		], { label: tr('Change the start') })
	}

	function timerStrip(d) {
		const r = d.running
		const now = nowTs()
		if (!r) {
			const strip = h('section', { class: 'imp-timer imp-timer--idle' },
				h('div', { class: 'imp-timer__text' },
					state.longBreakUntil && state.longBreakUntil > now
						? [h('span', { class: 'imp-timer__label' }, tr('Long break')),
							h('span', { class: 'imp-timer__clock', 'data-live': 'left', 'data-ts': state.longBreakUntil }, clock(state.longBreakUntil - now))]
						: [h('span', { class: 'imp-timer__label' }, tr('Not tracking')),
							h('span', { class: 'imp-muted' }, tr('Press play on a commitment, or track time without one.'))]),
				h('button', { class: 'imp-button', onclick: () => startTracking(null) }, icon(ICON_PLAY, 16), tr('Track unplanned time')))
			return strip
		}
		const color = r.commitmentId === null ? 'var(--tl-accent)' : colorOf(r.commitmentId)
		const block = r.commitmentId !== null ? (d.commitments.find((e) => e.commitment.id === r.commitmentId) || {}).currentBlock : null
		const strip = h('section', { class: 'imp-timer', style: { '--c': color, '--on-c': r.commitmentId === null ? '#fff' : onColor(color) } },
			h('div', { class: 'imp-timer__text' },
				h('span', { class: 'imp-timer__label' }, nameOf(r.commitmentId),
					block ? h('span', { class: 'imp-timer__block', title: `${fmt.time.format(at(block.start))}–${fmt.time.format(at(block.end))}` }, ` · ${block.title || tr('Block')}`) : null),
				h('span', { class: 'imp-timer__clock', 'data-live': 'elapsed', 'data-ts': r.start }, clock(now - r.start)),
				h('button', { type: 'button', class: 'imp-timer__since', title: tr('Started earlier? Change the start'), onclick: (e) => startMenu(e.currentTarget, r) },
					tr('Started {time}', { time: fmt.time.format(at(r.start)) }), h('span', { 'aria-hidden': 'true' }, ' ✎')),
				block ? h('span', { class: 'imp-timer__sub' }, h('span', { 'data-live': 'left-short', 'data-ts': block.end }, duration(block.end - now)), ' ', tr('left in this block')) : null),
			h('div', { class: 'imp-timer__side' },
				// The block so far, as a ring
				block ? h('div', { class: 'imp-timer__ring', 'aria-hidden': 'true', 'data-now-marker': '', 'data-start': block.start, 'data-end': block.end, style: { '--p': `${Math.min(100, ((now - block.start) / (block.end - block.start)) * 100)}%` } },
					h('span', { 'data-live': 'left-short', 'data-ts': block.end }, duration(block.end - now))) : null,
				h('button', { class: 'imp-timer__stop', onclick: () => stopTracking(), 'aria-label': tr('Stop tracking') }, icon(ICON_STOP, 16, true), tr('Stop'))))

		if (r.pomodoro) {
			const p = pomodoroPhase(r.start, state.settings, now)
			const label = p.kind === 'focus' ? tr('Focus') : p.kind === 'short' ? tr('Short break') : tr('Long break')
			const dots = h('span', { class: 'imp-pomo__dots', 'aria-hidden': 'true' },
				Array.from({ length: p.of }, (_, i) => h('span', { class: i < p.round - 1 || (i === p.round - 1 && p.kind !== 'focus') ? 'full' : i === p.round - 1 ? 'half' : '' })))
			strip.append(h('div', { class: 'imp-pomo', 'data-phase': `${p.kind}-${p.round}` },
				dots,
				h('span', null, label, ' · ', tr('Round {round} of {of}', { round: p.round, of: p.of })),
				h('span', { class: 'imp-pomo__left' }, h('span', { 'data-live': 'left', 'data-ts': p.endsAt }, clock(p.endsAt - now)),
					' ', p.kind === 'focus' ? (p.round < p.of ? tr('until the short break') : tr('until the long break')) : tr('until focus'))))
		}
		return strip
	}

	/** What to do now: the tasks for the running (or current, or next) block */
	function blockCard(d) {
		const r = d.running
		const soonest = (e) => (e.currentBlock ? 0 : e.nextBlock ? e.nextBlock.start : Infinity)
		const entry = (r && d.commitments.find((e) => e.commitment.id === r.commitmentId)) || d.commitments.slice().sort((a, b) => soonest(a) - soonest(b))[0]
		const c = entry.commitment
		const block = entry.currentBlock || entry.nextBlock
		const planned = entry.queue.filter((t) => entry.plannedTaskIds.includes(t.id))
		const later = entry.queue.filter((t) => !entry.plannedTaskIds.includes(t.id))
		return h('section', { class: 'imp-inblock', style: { '--c': c.color, '--on-c': onColor(c.color) } },
			h('header', { class: 'imp-inblock__head' },
				h('h2', null, entry.currentBlock ? tr('In this block') : block ? tr('For the next block') : tr('Up next')),
				h('span', { class: 'imp-muted' }, h('span', { class: 'imp-dot', style: { background: c.color } }), c.name, block ? ` · ${blockTime(block)}` : '')),
			h('div', { class: 'imp-inblock__list' },
				planned.length
					? planned.map((t) => taskChecklist(t, { addable: true, hideDone: true }))
					: h('p', { class: 'imp-muted' }, tr('No open tasks.'), ' ', h('a', { href: '#tasks', onclick: () => { state.tasksFor = c.id } }, tr('Add tasks')))),
			later.length
				? h('details', { class: 'imp-later' },
					h('summary', null, trn('%n more task in the queue', '%n more tasks in the queue', later.length)),
					h('ol', null, later.map((t) => h('li', null, t.title, t.subtasks.length ? h('span', { class: 'imp-muted' }, ` ${t.subtasks.filter((s) => s.done).length}/${t.subtasks.length}`) : null))))
				: null,
			capacityLine(entry))
	}

	/**
	 * A task with its checkable subtasks. The task itself has no checkbox: it is
	 * done when all subtasks are. A task whose only subtask is the task itself
	 * shows as a single checkbox.
	 */
	function taskChecklist(t, opts = {}) {
		const doneCount = t.subtasks.filter((x) => x.done).length
		const single = t.subtasks.length === 1 && t.subtasks[0].title === t.title
		const badge = t.carried > 0 ? h('span', { class: 'imp-badge', title: tr('Not finished in an earlier block') }, tr('carried over')) : null
		const est = (x) => (x.estimate ? h('span', { class: 'imp-est', title: tr('Estimate') }, fmtMin(x.estimate)) : null)
		// On Now only what is left to do (checked ones are in Done); reordering is on the Tasks page then
		const sortable = t.subtasks.length > 1 && !opts.hideDone
		const box = (x, isTitle) => {
			const sid = `imp-sub-${x.id}`
			const el = h(isTitle ? 'div' : 'li', { class: `imp-check ${isTitle ? 'imp-task__title' : ''}` },
				!isTitle && sortable ? subtaskHandle(t) : null,
				h('input', { type: 'checkbox', id: sid, checked: x.done, onchange: (e) => setSubtaskDone(t, x, e.target.checked) }),
				h('label', { for: sid }, x.title),
				isTitle ? badge : null,
				est(x))
			if (!isTitle && sortable) makeSubtaskDraggable(el, x, t)
			return el
		}
		const left = remainingMin(t)
		const adder = opts.addable ? subtaskAdder(t) : null
		if (single && !(opts.addable && state.addingTo === t.id)) {
			return h('div', { class: 'imp-task' }, box(t.subtasks[0], true), adder)
		}
		return h('div', { class: 'imp-task' },
			h('div', { class: 'imp-task__head' },
				h('span', { class: 'imp-task__name' }, t.title),
				badge,
				h('span', { class: 'imp-muted imp-task__count' },
					`${doneCount}/${t.subtasks.length}`,
					left && doneCount < t.subtasks.length ? ` · ${tr('{time} left', { time: fmtMin(left) })}` : '')),
			h('ul', { class: 'imp-subtasks' }, t.subtasks.filter((x) => !opts.hideDone || !x.done).map((x) => box(x, false))),
			adder)
	}

	// --- reordering subtasks right in the checklist (drag the handle, or Alt+↑/↓) ---

	let dragSub = null // { li, taskId, before: [ids] }
	const SUB_MIME = 'application/x-tracker-subtask'

	function subtaskHandle(t) {
		return h('span', {
			class: 'imp-sub__handle',
			'aria-hidden': 'true',
			title: tr('Drag to change priority (or Alt+↑/↓)'),
			onmousedown: (e) => { e.currentTarget.parentElement.draggable = true },
			onmouseup: (e) => { e.currentTarget.parentElement.draggable = false },
		}, '⋮⋮')
	}

	function subtaskOrder(list) {
		return [...list.children].map((li) => Number(li.dataset.sid))
	}

	async function saveSubtaskOrder(taskId, ids) {
		await api('POST', `tasks/${taskId}/subtasks-order`, { ids })
		await render()
	}

	function makeSubtaskDraggable(li, x, t) {
		li.dataset.sid = x.id
		// Grab it by the handle or by the row's empty space (not the title, which edits on click)
		li.addEventListener('mousedown', (e) => { if (e.target === li) li.draggable = true })
		li.addEventListener('mouseup', () => { if (!dragSub) li.draggable = false })
		li.addEventListener('dragstart', (e) => {
			e.stopPropagation()
			e.dataTransfer.effectAllowed = 'move'
			e.dataTransfer.setData(SUB_MIME, String(x.id))
			dragSub = { li, taskId: t.id, before: subtaskOrder(li.parentElement) }
			li.classList.add('is-dragging')
		})
		li.addEventListener('dragover', (e) => {
			if (!dragSub || dragSub.taskId !== t.id || dragSub.li === li) return
			e.preventDefault()
			e.stopPropagation()
			const after = e.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2
			li.parentElement.insertBefore(dragSub.li, after ? li.nextSibling : li)
		})
		li.addEventListener('drop', (e) => { if (dragSub) { e.preventDefault(); e.stopPropagation() } })
		li.addEventListener('dragend', (e) => {
			e.stopPropagation()
			li.draggable = false
			li.classList.remove('is-dragging')
			const d = dragSub
			dragSub = null
			if (!d) return
			const after = subtaskOrder(li.parentElement)
			if (after.join() !== d.before.join()) saveSubtaskOrder(t.id, after)
		})
		// Keyboard: Alt+↑/↓ on the checkbox moves the subtask
		li.addEventListener('keydown', (e) => {
			if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
			e.preventDefault()
			const ids = subtaskOrder(li.parentElement)
			const i = ids.indexOf(x.id)
			const j = i + (e.key === 'ArrowUp' ? -1 : 1)
			if (j < 0 || j >= ids.length) return
			;[ids[i], ids[j]] = [ids[j], ids[i]]
			state.refocus = `imp-sub-${x.id}`
			saveSubtaskOrder(t.id, ids)
		})
	}

	/** "+ Add subtask" under a task on the Now page; stays open for several entries. */
	function subtaskAdder(t) {
		if (state.addingTo !== t.id) {
			return h('button', { class: 'imp-add', onclick: () => { state.addingTo = t.id; render() } }, '+ ', tr('Add subtask'))
		}
		const input = h('input', {
			type: 'text',
			class: 'imp-add__input',
			'data-add-for': t.id,
			maxlength: 255,
			placeholder: tr('New subtask, e.g. "Check figures 20m"'),
			'aria-label': tr('New subtask for {title}', { title: t.title }),
			onkeydown: async (e) => {
				if (e.key === 'Escape') { state.addingTo = null; render(); return }
				if (e.key !== 'Enter') return
				e.preventDefault()
				const { title, estimate } = parseEstimate(input.value)
				if (!title) return
				input.disabled = true
				await api('POST', `tasks/${t.id}/subtasks`, { title, estimate })
				await render()
				document.querySelector(`[data-add-for="${t.id}"]`)?.focus()
			},
		})
		setTimeout(() => { if (document.activeElement?.tagName !== 'INPUT') input.focus() }, 0)
		return h('div', { class: 'imp-add__row' },
			input,
			h('button', { class: 'imp-link', onclick: () => { state.addingTo = null; render() } }, tr('Done')))
	}

	async function setSubtaskDone(t, s, done) {
		const task = await api('PUT', `subtasks/${s.id}`, { done })
		if (task.done && !t.done) toast(tr('Done: {title}', { title: t.title }))
		await render()
	}

	// ---------------------------------------------------------------------------
	// Page: Tasks (queue per commitment, edited right in the list)
	// ---------------------------------------------------------------------------

	const ESTIMATE_PRESETS = [15, 30, 45, 60, 90, 120]

	/** Click-open menu next to an element; closes on Esc, outside click or a choice. */
	let menuEl = null
	let menuScrim = null
	function closeMenu() {
		if (!menuEl) return
		const back = menuEl.returnFocus
		menuEl.remove()
		menuEl = null
		// The tap that closed it ends on the scrim, not on the text under it
		if (menuScrim) { const sc = menuScrim; menuScrim = null; setTimeout(() => sc.remove(), 400) }
		if (back && document.contains(back)) back.focus()
	}
	function openMenu(anchor, build, { label = '' } = {}) {
		closeMenu()
		const el = h('div', { class: 'imp-menu', role: 'menu', 'aria-label': label })
		el.returnFocus = anchor
		const accent = getComputedStyle(anchor).getPropertyValue('--c')
		if (accent) el.style.setProperty('--c', accent)
		el.append(...[build(closeMenu)].flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false))
		// The phone: a tap outside only closes the menu (it doesn't open, select or edit what's under it)
		if (PHONE) {
			const swallow = (e) => { e.preventDefault(); e.stopPropagation() }
			menuScrim = h('div', { class: 'imp-menu-scrim', 'aria-hidden': 'true' })
			menuScrim.addEventListener('pointerdown', (e) => { swallow(e); closeMenu() })
			for (const t of ['mousedown', 'mouseup', 'click', 'touchend', 'contextmenu']) menuScrim.addEventListener(t, swallow)
			document.body.append(menuScrim)
		}
		document.body.append(el)
		menuEl = el
		const r = anchor.getBoundingClientRect()
		const w = el.offsetWidth
		const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8)
		const below = r.bottom + 6
		const top = below + el.offsetHeight > window.innerHeight - 8 ? r.top - el.offsetHeight - 6 : below
		el.style.left = `${left + window.scrollX}px`
		el.style.top = `${Math.max(8, top) + window.scrollY}px`
		el.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu() }
			if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
			if (e.target.matches('input')) return
			const items = [...el.querySelectorAll('button:not(:disabled)')]
			const i = items.indexOf(document.activeElement)
			e.preventDefault()
			items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
		})
		el.addEventListener('mousedown', (e) => e.stopPropagation())
		setTimeout(() => (el.querySelector('[autofocus]') || el.querySelector('button, input'))?.focus(), 0)
		return el
	}
	document.addEventListener('mousedown', () => closeMenu())

	const menuItem = (label, onclick, opts = {}) => h('button', {
		type: 'button',
		role: 'menuitem',
		class: `imp-menu__item ${opts.danger ? 'is-danger' : ''} ${opts.current ? 'is-current' : ''}`,
		disabled: opts.disabled,
		onclick,
	}, opts.dot ? h('span', { class: 'imp-dot', style: { background: opts.dot } }) : null, h('span', null, label), opts.hint ? h('span', { class: 'imp-menu__hint' }, opts.hint) : null)

	/** Time chip: shows a subtask's estimate; faint when the default applies. */
	function estimateChip(minutes, onPick, { preview = null, id } = {}) {
		const shown = minutes ?? preview
		const chip = h('button', {
			type: 'button',
			id,
			class: `imp-chip ${minutes ? '' : preview ? 'is-preview' : 'is-default'}`,
			title: minutes ? tr('Estimate') : tr('No estimate yet: counts as {time}', { time: fmtMin(defaultEstimate()) }),
			'aria-label': minutes ? tr('Estimate {time}, change', { time: fmtMin(minutes) }) : tr('Set an estimate'),
			onclick: (e) => { e.preventDefault(); e.stopPropagation(); estimateMenu(chip, minutes, onPick) },
		}, fmtMin(shown ?? defaultEstimate()))
		return chip
	}

	function estimateMenu(anchor, current, onPick) {
		const custom = h('input', {
			type: 'text',
			class: 'imp-menu__input',
			placeholder: tr('e.g. 40m or 1h30'),
			'aria-label': tr('Other time'),
			onkeydown: (e) => {
				if (e.key !== 'Enter') return
				e.preventDefault()
				const v = custom.value.trim()
				const m = parseEstimate(`x ${/^\d+$/.test(v) ? `${v}m` : v}`)
				if (!m.estimate) { custom.classList.add('is-invalid'); return }
				closeMenu()
				onPick(m.estimate)
			},
		})
		openMenu(anchor, (close) => [
			h('div', { class: 'imp-menu__chips' }, ESTIMATE_PRESETS.map((m) => h('button', {
				type: 'button',
				class: `imp-chip ${m === current ? 'is-current' : ''}`,
				autofocus: m === current || (!current && m === ESTIMATE_PRESETS[0]),
				onclick: () => { close(); onPick(m) },
			}, fmtMin(m)))),
			custom,
			current ? menuItem(tr('No estimate (counts as {time})', { time: fmtMin(defaultEstimate()) }), () => { close(); onPick(null) }) : null,
		], { label: tr('Estimate') })
	}

	/**
	 * Text that turns into a field when clicked (or Enter/F2 when focused).
	 * Enter or leaving the field saves, Esc cancels.
	 */
	function editableText(value, { id, label, onSave, className = '', multiline = false, placeholder = '' }) {
		const span = h('span', {
			id,
			class: `imp-editable ${className}`,
			tabindex: '0',
			role: 'button',
			title: tr('Click to edit'),
			'aria-label': `${label}: ${value}`,
		}, value || placeholder)
		if (!value) span.classList.add('is-empty')
		const start = () => {
			const field = h(multiline ? 'textarea' : 'input', {
				class: `imp-editable__field ${className}`,
				'aria-label': label,
				maxlength: multiline ? null : 255,
				rows: multiline ? Math.max(2, value.split('\n').length) : null,
				placeholder,
			})
			field.value = value
			let finished = false
			const finish = async (save) => {
				if (finished) return
				finished = true
				const v = field.value
				if (save && v.trim() !== value.trim()) {
					field.disabled = true
					state.refocus = id
					await onSave(v)
				} else {
					field.replaceWith(span)
					span.focus()
				}
			}
			field.addEventListener('keydown', (e) => {
				if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) }
				if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true) }
			})
			field.addEventListener('blur', () => finish(true))
			span.replaceWith(field)
			field.focus()
			if (!multiline) field.select()
		}
		span.addEventListener('click', (e) => { e.stopPropagation(); start() })
		span.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); start() } })
		return span
	}

	/**
	 * Which upcoming block each task falls into, the way blocks are filled:
	 * a block takes tasks from the top until their remaining time fills it,
	 * the next block continues where it stopped.
	 */
	function planIntoBlocks(tasks, blocks) {
		const now = nowTs()
		const slots = blocks.map((b) => ({ block: b, seconds: b.end - Math.max(now, b.start), used: 0, tasks: [] }))
		let i = 0
		const where = new Map()
		for (const t of tasks) {
			while (i < slots.length && slots[i].tasks.length && slots[i].used >= slots[i].seconds) i++
			if (i >= slots.length) { where.set(t.id, null); continue }
			slots[i].tasks.push(t)
			slots[i].used += remainingMin(t) * 60
			where.set(t.id, i)
		}
		return { slots, where }
	}

	async function pageTasks() {
		const page = h('div', { class: 'imp-page imp-tasks' })
		if (!state.commitments.length) {
			page.append(h('div', { class: 'imp-empty' }, h('p', null, tr('Create a commitment first.')), h('a', { class: 'imp-button imp-button--primary', href: '#settings' }, tr('Create a commitment'))))
			return page
		}
		if (!commitmentById(state.tasksFor)) state.tasksFor = state.commitments[0].id
		const now = nowTs()
		const [all, blockData] = await Promise.all([
			Promise.all(state.commitments.map((c) => api('GET', `tasks?commitmentId=${c.id}&status=open`))),
			api('GET', `blocks?from=${now - 86400}&to=${now + 14 * 86400}`).catch(() => ({ blocks: [] })),
		])
		const open = all.reduce((n, list) => n + list.length, 0)
		const work = all.reduce((n, list) => n + list.reduce((m, t) => m + remainingMin(t), 0), 0)
		// Many commitments: the columns scroll sideways (wheel, trackpad, or these buttons)
		const prev = h('button', { type: 'button', class: 'imp-icon-btn', 'aria-label': tr('Previous commitments'), title: tr('Previous commitments'), hidden: true }, chevron(-1))
		const next = h('button', { type: 'button', class: 'imp-icon-btn', 'aria-label': tr('More commitments'), title: tr('More commitments'), hidden: true }, chevron(1))
		page.append(pageHeader('tasks', open ? `${trn('%n open task', '%n open tasks', open)} · ${tr('{time} of work', { time: fmtMin(work) })} · ${tr('each block takes tasks from the top')}` : tr('No open tasks'), h('div', { class: 'imp-arrows imp-tcols__nav' }, prev, next)))
		// Every commitment side by side, each a column of its queue (scrolls inside on wide windows)
		page.append(hscroll(h('div', { class: 'imp-tcols' }, state.commitments.map((c, k) => taskColumn(c, all[k], blockData.blocks, now))), prev, next))
		return page
	}

	function taskColumn(c, tasks, blocks, now) {
		const own = blocks.filter((b) => b.commitmentId === c.id && b.end > now).sort((a, b) => a.start - b.start)
		const plan = planIntoBlocks(tasks, own)
		const work = tasks.reduce((sum, t) => sum + remainingMin(t), 0)
		const week = own.reduce((sum, b) => sum + Math.max(0, Math.min(b.end, now + 7 * 86400) - Math.max(b.start, now)), 0)
		const list = h('ol', { class: 'imp-tq', 'aria-label': tr('Tasks of {name} by priority', { name: c.name }) })
		let lastSlot
		tasks.forEach((t, i) => {
			const slot = plan.where.get(t.id)
			if (slot !== lastSlot) {
				list.append(slot === null ? blockDivider(null) : blockDivider(plan.slots[slot]))
				lastSlot = slot
			}
			list.append(taskItem(t, i, tasks, c))
		})
		const mine = state.tasksFor === c.id
		return h('section', { class: `imp-tcol ${mine ? 'is-current' : ''}`, style: { '--c': c.color, '--on-c': onColor(c.color) }, 'data-cid': c.id },
			h('header', { class: 'imp-tcol__head' }, tile(c),
				h('div', null,
					h('h2', null, h('a', { href: `#c/${c.id}` }, c.name)),
					h('span', { class: 'imp-muted' }, tasks.length
						? `${tr('{time} of work', { time: fmtMin(work) })} · ${tr('{time} in blocks', { time: duration(week, { short: true }) })}`
						: tr('No open tasks'))),
				h('button', { type: 'button', class: 'imp-icon-btn imp-tcol__add', onclick: () => openComposer(c.id), title: tr('New task (N)'), 'aria-label': tr('New task for {name}', { name: c.name }) }, '+')),
			h('div', { class: 'imp-tcol__body' }, list, mine ? composer(c, tasks, own) : null))
	}

	function blockDivider(slot) {
		if (!slot) {
			return h('li', { class: 'imp-tq__block is-none', 'aria-hidden': 'true' },
				h('span', { class: 'imp-tq__blockname' }, tr('No block yet')),
				h('span', { class: 'imp-tq__blockmeta' }, tr('Add blocks to the calendar to plan these')))
		}
		const b = slot.block
		const current = b.start <= nowTs()
		const over = slot.used > slot.seconds
		return h('li', { class: `imp-tq__block ${current ? 'is-current' : ''} ${over ? 'is-over' : ''}`, 'aria-hidden': 'true', title: tr('Blocks take tasks from the top until their estimates fill them; unfinished tasks stay on top for the next block.') },
			h('span', { class: 'imp-tq__blockname' }, current ? tr('Now, until {time}', { time: fmt.time.format(at(b.end)) }) : blockTime(b), b.title && b.title !== commitmentById(b.commitmentId)?.name ? h('span', { class: 'imp-muted' }, ` · ${b.title}`) : null),
			h('span', { class: 'imp-tq__blockmeta' }, tr('{used} of {time}', { used: duration(slot.used, { short: true }), time: duration(slot.seconds, { short: true }) })))
	}

	async function moveTask(tasks, c, index, delta) {
		const ids = tasks.map((x) => x.id)
		const j = index + delta
		if (j < 0 || j >= ids.length) return
		;[ids[index], ids[j]] = [ids[j], ids[index]]
		state.refocus = `imp-tt-${tasks[index].id}`
		await api('POST', 'tasks-order', { commitmentId: c.id, ids })
		await render()
	}

	function taskItem(t, index, tasks, c) {
		const single = t.subtasks.length === 1 && t.subtasks[0].title === t.title
		const doneCount = t.subtasks.filter((x) => x.done).length
		const left = remainingMin(t)
		const total = t.subtasks.reduce((s, x) => s + (x.estimate ?? defaultEstimate()), 0)

		const li = h('li', {
			class: 'imp-tq__item',
			ondragstart: (e) => {
				if (e.target !== li) return
				e.dataTransfer.setData('text/plain', String(t.id))
				e.dataTransfer.effectAllowed = 'move'
				li.classList.add('is-dragging')
			},
			ondragend: () => { li.classList.remove('is-dragging'); li.draggable = false },
			ondragover: (e) => { if (dragSub) return; e.preventDefault(); li.classList.add('is-over') },
			ondragleave: () => li.classList.remove('is-over'),
			ondrop: async (e) => {
				e.preventDefault()
				li.classList.remove('is-over')
				if (dragSub) return
				const dragged = Number(e.dataTransfer.getData('text/plain'))
				if (!dragged || dragged === t.id) return
				const ids = tasks.map((x) => x.id).filter((x) => x !== dragged)
				ids.splice(ids.indexOf(t.id), 0, dragged)
				await api('POST', 'tasks-order', { commitmentId: c.id, ids })
				await render()
			},
			onkeydown: (e) => {
				if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !e.target.matches('.imp-tq__title')) return
				e.preventDefault()
				moveTask(tasks, c, index, e.key === 'ArrowUp' ? -1 : 1)
			},
		})

		const title = editableText(t.title, {
			id: `imp-tt-${t.id}`,
			label: tr('Task title'),
			className: 'imp-tq__title',
			onSave: async (v) => {
				if (!v.trim()) { await render(); return }
				await api('PUT', `tasks/${t.id}`, { title: v })
				await render()
			},
		})
		const singleSub = single ? t.subtasks[0] : null
		const head = h('div', { class: 'imp-tq__head' },
			singleSub ? h('input', { type: 'checkbox', class: 'imp-tq__check', checked: singleSub.done, 'aria-label': tr('Done: {title}', { title: t.title }), onchange: (e) => setSubtaskDone(t, singleSub, e.target.checked) }) : null,
			title,
			// (the phone puts these on their own line under the title)
			h('span', { class: 'imp-tq__info' },
				singleSub ? estimateChip(singleSub.estimate, (m) => saveSubtask(t, singleSub, { estimate: m }), { id: `imp-chip-${singleSub.id}` }) : null,
				t.carried > 0 ? h('span', { class: `imp-badge ${t.carried >= 3 ? 'is-stuck' : ''}`, title: trn('Not finished in %n earlier block', 'Not finished in %n earlier blocks', t.carried) }, tr('carried ×{n}', { n: t.carried })) : null,
				h('span', { class: 'imp-tq__meta' },
					singleSub
						? null
						: [`${doneCount}/${t.subtasks.length}`, ' · ', doneCount ? tr('{time} left', { time: fmtMin(left) }) : fmtMin(total)])),
			h('span', { class: 'imp-tq__actions' },
				h('button', { type: 'button', class: 'imp-icon-btn', onclick: () => { state.addingTo = t.id; render() }, 'aria-label': tr('Add subtask to {title}', { title: t.title }), title: tr('Add subtask') }, '+'),
				h('button', { type: 'button', class: 'imp-icon-btn', onclick: () => moveTask(tasks, c, index, -1), disabled: index === 0, 'aria-label': tr('Move up'), title: tr('Move up (Alt+↑)') }, '↑'),
				h('button', { type: 'button', class: 'imp-icon-btn', onclick: () => moveTask(tasks, c, index, 1), disabled: index === tasks.length - 1, 'aria-label': tr('Move down'), title: tr('Move down (Alt+↓)') }, '↓'),
				h('button', { type: 'button', class: 'imp-icon-btn imp-tq__more', 'aria-label': tr('More for {title}', { title: t.title }), 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); taskMenu(e.currentTarget, t, c, { tasks, index }) } }, '⋯')))

		const body = h('div', { class: 'imp-tq__main' }, head)
		if (!single) {
			body.append(h('div', { class: 'imp-tq__bar', 'aria-hidden': 'true' }, h('span', { style: { width: `${total ? Math.round(((total - left) / total) * 100) : 0}%` } })))
			// Checked subtasks fold away (still in the list, so reordering keeps them)
			const fold = doneCount > 0 && !(state.showDone || new Set()).has(t.id)
			const subs = h('ul', { class: `imp-subtasks imp-tq__subs ${fold ? 'hide-done' : ''}` })
			for (const s of t.subtasks) subs.append(subtaskRow(t, s))
			body.append(subs)
			if (doneCount) {
				body.append(h('button', {
					type: 'button',
					class: 'imp-link imp-tq__donetoggle',
					onclick: () => {
						state.showDone = state.showDone || new Set()
						if (fold) state.showDone.add(t.id)
						else state.showDone.delete(t.id)
						render()
					},
				}, fold ? trn('Show %n done', 'Show %n done', doneCount) : tr('Hide done')))
			}
		}
		if (state.noteFor === t.id || t.note) {
			body.append(editableNote(t))
		}
		if (state.addingTo === t.id) body.append(subtaskAdder(t))

		li.append(
			h('span', {
				class: 'imp-qitem__handle imp-tq__handle',
				title: tr('Drag to reorder'),
				'aria-hidden': 'true',
				onmousedown: () => { li.draggable = true },
				onmouseup: () => { li.draggable = false },
			}, '⋮⋮'),
			body)
		return li
	}

	function subtaskRow(t, s) {
		const li = h('li', { class: `imp-check imp-tq__sub ${s.done ? 'is-done' : ''}` },
			subtaskHandle(t),
			h('input', { type: 'checkbox', id: `imp-sub-${s.id}`, checked: s.done, 'aria-label': tr('Done: {title}', { title: s.title }), onchange: (e) => setSubtaskDone(t, s, e.target.checked) }),
			editableText(s.title, {
				id: `imp-st-${s.id}`,
				label: tr('Subtask title'),
				className: 'imp-tq__subtitle',
				onSave: async (v) => {
					if (!v.trim()) {
						if (t.subtasks.length > 1) await api('DELETE', `subtasks/${s.id}`)
						await render()
						return
					}
					const parsed = parseEstimate(v)
					await saveSubtask(t, s, parsed.estimate ? { title: parsed.title, estimate: parsed.estimate } : { title: v })
				},
			}),
			estimateChip(s.estimate, (m) => saveSubtask(t, s, { estimate: m }), { id: `imp-chip-${s.id}` }),
			t.subtasks.length > 1
				? h('button', {
					type: 'button',
					class: 'imp-icon-btn imp-tq__del',
					'aria-label': tr('Remove {title}', { title: s.title }),
					title: tr('Remove subtask'),
					onclick: async () => { await api('DELETE', `subtasks/${s.id}`); await render() },
				}, '×')
				: null)
		makeSubtaskDraggable(li, s, t)
		return li
	}

	async function saveSubtask(t, s, data) {
		if ('estimate' in data) state.refocus = state.refocus || `imp-chip-${s.id}`
		await api('PUT', `subtasks/${s.id}`, data)
		await render()
	}

	function editableNote(t) {
		const note = editableText(t.note || '', {
			id: `imp-note-${t.id}`,
			label: tr('Note'),
			className: 'imp-tq__note',
			multiline: true,
			placeholder: tr('Add a note'),
			onSave: async (v) => {
				state.noteFor = null
				await api('PUT', `tasks/${t.id}`, { note: v })
				await render()
			},
		})
		if (state.noteFor === t.id && !t.note) {
			state.noteFor = null
			setTimeout(() => note.click(), 0)
		}
		return note
	}

	function taskMenu(anchor, t, c, order) {
		const others = state.commitments.filter((x) => x.id !== c.id)
		openMenu(anchor, (close) => [
			// The phone has no arrows in the list: moving is here
			PHONE && order && order.index > 0 ? menuItem(tr('Move up'), () => { close(); moveTask(order.tasks, c, order.index, -1) }) : null,
			PHONE && order && order.index < order.tasks.length - 1 ? menuItem(tr('Move down'), () => { close(); moveTask(order.tasks, c, order.index, 1) }) : null,
			menuItem(t.note ? tr('Edit note') : tr('Add note'), () => {
				close()
				state.noteFor = t.id
				if (t.note) document.getElementById(`imp-note-${t.id}`)?.click()
				else render()
			}),
			menuItem(tr('Add subtask'), () => { close(); state.addingTo = t.id; render() }),
			others.length ? h('div', { class: 'imp-menu__heading' }, tr('Move to')) : null,
			others.map((x) => menuItem(x.name, async () => {
				close()
				await api('PUT', `tasks/${t.id}`, { commitmentId: x.id })
				toast(tr('Moved "{title}" to {name}', { title: t.title, name: x.name }))
				await render()
			}, { dot: x.color })),
			h('hr', { class: 'imp-menu__sep' }),
			menuItem(tr('Delete task'), async () => {
				close()
				if (!window.confirm(tr('Delete "{title}" and its subtasks?', { title: t.title }))) return
				await api('DELETE', `tasks/${t.id}`)
				await render()
			}, { danger: true }),
		], { label: tr('Task') })
	}

	// --- composer for new tasks ----------------------------------------------------

	const emptyDraft = () => ({ open: true, title: '', estimate: null, rows: [{ title: '', estimate: null }] })

	function openComposer(cid) {
		if (cid && cid !== state.tasksFor) { state.tasksFor = cid; state.composer = null }
		if (!state.composer) state.composer = emptyDraft()
		state.composer.open = true
		state.refocus = 'imp-composer-title'
		render().then(() => document.querySelector('.imp-composer')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
	}

	/** List markers people paste along with lines: "- ", "* ", "1. ", "[ ] " */
	const stripMarker = (line) => line.replace(/^\s*(?:[-*•–]\s+|\d+[.)]\s+)?(?:\[[ xX]?\]\s*)?/, '').trim()

	function composer(c, tasks, own) {
		const d = state.composer
		if (!d || !d.open) {
			return h('button', { type: 'button', class: 'imp-tq__new', onclick: () => openComposer(c.id) },
				h('span', { class: 'imp-tq__plus', 'aria-hidden': 'true' }, '+'), tr('New task'), h('kbd', null, 'N'))
		}

		const titleInput = h('input', {
			type: 'text',
			id: 'imp-composer-title',
			class: 'imp-composer__title',
			placeholder: tr('Task name'),
			'aria-label': tr('Task title'),
			maxlength: 255,
			value: d.title,
		})
		const rowsEl = h('ol', { class: 'imp-composer__rows', 'aria-label': tr('Subtasks, by priority') })
		const titleChipSlot = h('span', { class: 'imp-composer__titlechip' })
		const summary = h('div', { class: 'imp-composer__summary', 'aria-live': 'polite' })
		const submit = h('button', { type: 'submit', class: 'imp-button imp-button--primary' }, tr('Add task'))
		let dragging = null

		const rowEls = () => [...rowsEl.children]
		const rowData = (r) => {
			const p = parseEstimate(r.input.value)
			return { title: p.estimate ? p.title : r.input.value.trim(), estimate: p.estimate ?? r.estimate }
		}
		const filled = () => rowEls().map(rowData).filter((x) => x.title)

		const sync = () => {
			d.title = titleInput.value
			d.rows = rowEls().map((r) => ({ title: r.input.value, estimate: r.estimate }))
			const subs = filled()
			// Without subtasks the task itself gets a time
			titleChipSlot.replaceChildren()
			if (!subs.length) {
				const p = parseEstimate(titleInput.value)
				titleChipSlot.append(estimateChip(d.estimate, (m) => { d.estimate = m; sync(); titleInput.focus() }, { preview: p.estimate }))
			}
			const minutes = subs.length
				? subs.reduce((s, x) => s + (x.estimate ?? defaultEstimate()), 0)
				: (d.estimate ?? parseEstimate(titleInput.value).estimate ?? defaultEstimate())
			const lands = planIntoBlocks([...tasks, { id: 'new', subtasks: [{ done: false, estimate: minutes }] }], own)
			const slot = lands.where.get('new')
			summary.replaceChildren(
				h('strong', null, subs.length ? trn('%n subtask', '%n subtasks', subs.length) : tr('No subtasks')),
				' · ', fmtMin(minutes), ' · ',
				h('span', { class: slot === null ? 'imp-composer__warn' : '' }, slot === null
					? (own.length ? tr('no room in the blocks of the next 2 weeks') : tr('no block in the next 2 weeks'))
					: lands.slots[slot].block.start <= nowTs() ? tr('fits in the current block') : tr('lands in the block {when}', { when: blockTime(lands.slots[slot].block) })))
			submit.disabled = !titleInput.value.trim()
		}

		const focusEnd = (input) => { input.focus(); const n = input.value.length; input.setSelectionRange(n, n) }

		const commitRow = (r) => {
			const p = parseEstimate(r.input.value)
			if (p.estimate) {
				r.input.value = p.title
				r.estimate = p.estimate
			}
			r.refreshChip()
		}

		const makeRow = (data) => {
			const input = h('input', {
				type: 'text',
				class: 'imp-composer__input',
				maxlength: 255,
				placeholder: tr('Subtask, e.g. "Draft 45m"'),
				'aria-label': tr('Subtask'),
			})
			input.value = data.title
			const chipSlot = h('span', { class: 'imp-composer__chip' })
			const li = h('li', {
				class: 'imp-composer__row',
				ondragstart: (e) => { if (e.target !== li) return; dragging = li; li.classList.add('is-dragging'); e.dataTransfer.effectAllowed = 'move' },
				ondragend: () => { li.classList.remove('is-dragging'); li.draggable = false; dragging = null; sync() },
				ondragover: (e) => {
					if (!dragging || dragging === li) return
					e.preventDefault()
					const after = e.clientY > li.getBoundingClientRect().top + li.offsetHeight / 2
					rowsEl.insertBefore(dragging, after ? li.nextSibling : li)
				},
				ondrop: (e) => e.preventDefault(),
			},
			h('span', { class: 'imp-sub__handle imp-composer__handle', 'aria-hidden': 'true', title: tr('Drag to change priority (or Alt+↑/↓)'), onmousedown: () => { li.draggable = true }, onmouseup: () => { li.draggable = false } }, '⋮⋮'),
			h('span', { class: 'imp-composer__circle', 'aria-hidden': 'true' }),
			input,
			chipSlot,
			h('button', { type: 'button', class: 'imp-icon-btn imp-composer__del', tabindex: '-1', 'aria-label': tr('Remove subtask'), onclick: () => removeRow(li, true) }, '×'))
			li.input = input
			li.estimate = data.estimate
			li.refreshChip = () => {
				const p = parseEstimate(input.value)
				chipSlot.replaceChildren(input.value.trim() || li.estimate
					? estimateChip(p.estimate ? null : li.estimate, (m) => { commitRow(li); li.estimate = m; li.refreshChip(); sync(); focusEnd(input) }, { preview: p.estimate })
					: '')
			}
			li.refreshChip()

			input.addEventListener('input', () => { li.refreshChip(); sync() })
			input.addEventListener('blur', () => { commitRow(li); sync() })
			input.addEventListener('paste', (e) => {
				const text = e.clipboardData?.getData('text') || ''
				if (!text.includes('\n')) return
				e.preventDefault()
				const lines = text.split(/\r?\n/).map(stripMarker).filter(Boolean)
				let at = li
				if (!input.value.trim()) { input.value = lines.shift() || ''; commitRow(li) }
				for (const line of lines) {
					const r = makeRow({ title: line, estimate: null })
					rowsEl.insertBefore(r, at.nextSibling)
					commitRow(r)
					at = r
				}
				focusEnd(at.input)
				sync()
			})
			input.addEventListener('keydown', (e) => {
				const rows = rowEls()
				const i = rows.indexOf(li)
				if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
					e.preventDefault()
					commitRow(li)
					if (!input.value.trim()) return
					const next = rows[i + 1]
					if (next && !next.input.value.trim()) { next.input.focus(); return }
					const r = makeRow({ title: '', estimate: null })
					rowsEl.insertBefore(r, li.nextSibling)
					r.input.focus()
					sync()
				} else if (e.key === 'Backspace' && !input.value && input.selectionStart === 0) {
					e.preventDefault()
					removeRow(li, false)
				} else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
					e.preventDefault()
					if (e.key === 'ArrowUp' && rows[i - 1]) rowsEl.insertBefore(li, rows[i - 1])
					if (e.key === 'ArrowDown' && rows[i + 1]) rowsEl.insertBefore(rows[i + 1], li)
					input.focus()
					sync()
				} else if (e.key === 'ArrowUp' && !e.shiftKey) {
					e.preventDefault()
					rows[i - 1] ? focusEnd(rows[i - 1].input) : focusEnd(titleInput)
				} else if (e.key === 'ArrowDown' && !e.shiftKey && rows[i + 1]) {
					e.preventDefault()
					focusEnd(rows[i + 1].input)
				}
			})
			return li
		}

		const removeRow = (li, viaButton) => {
			const rows = rowEls()
			const i = rows.indexOf(li)
			if (rows.length === 1) {
				li.input.value = ''
				li.estimate = null
				li.refreshChip()
				viaButton ? li.input.focus() : focusEnd(titleInput)
			} else {
				li.remove()
				const target = rows[i - 1] || rows[i + 1]
				if (viaButton && rows[i + 1]) rows[i + 1].input.focus()
				else if (i === 0) focusEnd(titleInput)
				else focusEnd(target.input)
			}
			sync()
		}

		d.rows.forEach((r) => rowsEl.append(makeRow(r)))

		titleInput.addEventListener('input', sync)
		titleInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				if (titleInput.value.trim()) rowEls()[0].input.focus()
			} else if (e.key === 'ArrowDown') {
				e.preventDefault()
				rowEls()[0].input.focus()
			}
		})
		titleInput.addEventListener('paste', (e) => {
			const text = e.clipboardData?.getData('text') || ''
			if (!text.includes('\n')) return
			e.preventDefault()
			const lines = text.split(/\r?\n/).map(stripMarker).filter(Boolean)
			titleInput.value = lines.shift() || ''
			const first = rowEls()[0]
			if (lines.length && !first.input.value.trim()) first.remove()
			for (const line of lines) {
				const r = makeRow({ title: line, estimate: null })
				rowsEl.append(r)
				commitRow(r)
			}
			if (!rowsEl.children.length) rowsEl.append(makeRow({ title: '', estimate: null }))
			focusEnd(rowEls()[rowEls().length - 1].input)
			sync()
		})

		const close = () => {
			d.open = false
			render()
		}
		const form = h('form', {
			class: 'imp-composer',
			onsubmit: async (e) => {
				e.preventDefault()
				rowEls().forEach(commitRow)
				sync()
				const subs = filled()
				const name = titleInput.value.trim()
				if (!name) { titleInput.focus(); return }
				submit.disabled = true
				try {
					await api('POST', 'tasks', {
						commitmentId: c.id,
						title: name,
						estimate: subs.length ? null : d.estimate,
						subtasks: subs,
					})
				} catch (err) {
					submit.disabled = false
					return
				}
				state.composer = emptyDraft()
				state.refocus = 'imp-composer-title'
				await render()
				document.querySelector('.imp-composer')?.scrollIntoView({ block: 'nearest' })
			},
			onkeydown: (e) => {
				if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit() }
				if (e.key === 'Escape' && !menuEl) { e.preventDefault(); close() }
			},
		},
		h('div', { class: 'imp-composer__head' }, h('span', { class: 'imp-dot', style: { background: c.color } }), titleInput, titleChipSlot),
		rowsEl,
		h('div', { class: 'imp-composer__foot' },
			summary,
			h('div', { class: 'imp-composer__buttons' },
				h('button', { type: 'button', class: 'imp-button', onclick: close }, tr('Cancel')),
				submit,
				h('span', { class: 'imp-composer__keys imp-muted' }, IS_MAC ? '⌘↵' : 'Ctrl+↵'))))
		sync()
		return form
	}
	const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

	// "N" on the Tasks page opens the composer; on the Notes page it starts a note
	document.addEventListener('keydown', (e) => {
		if (state.route === 'notes' && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'n' || e.key === 'N') && !document.activeElement?.matches('input, textarea, select, [contenteditable]')) {
			const field = document.getElementById('imp-note-new')
			if (field) { e.preventDefault(); field.tagName === 'BUTTON' ? field.click() : field.focus() }
			return
		}
		if (state.route !== 'tasks' || e.metaKey || e.ctrlKey || e.altKey || (e.key !== 'n' && e.key !== 'N')) return
		if (document.activeElement?.matches('input, textarea, select, [contenteditable]') || menuEl) return
		e.preventDefault()
		openComposer()
	})

	// ---------------------------------------------------------------------------
	// Periods (shared by Done and Time)
	// ---------------------------------------------------------------------------

	const PERIODS = {
		day: { count: 14, label: () => tr('Days'), start: startOfDay, tick: (d) => fmt.dayShort.format(d), title: (d) => fmt.day.format(d) },
		week: { count: 12, label: () => tr('Weeks'), start: startOfWeek, tick: (d) => fmt.dayShort.format(d), title: (d) => tr('Week of {date}', { date: fmt.day.format(d) }) },
		month: { count: 12, label: () => tr('Months'), start: startOfMonth, tick: (d) => fmt.month.format(d), title: (d) => fmt.monthLong.format(d) },
	}

	/** Buckets for the selected period, oldest first. */
	function buckets() {
		const p = PERIODS[state.period]
		const end = addPeriod(p.start(new Date()), state.period, 1 - state.offset * p.count)
		const list = []
		for (let i = p.count; i >= 1; i--) {
			const s = addPeriod(end, state.period, -i)
			const e = addPeriod(end, state.period, -i + 1)
			list.push({ start: Math.floor(s / 1000), end: Math.floor(e / 1000), date: s })
		}
		return list
	}

	function periodControls() {
		const b = buckets()
		const p = PERIODS[state.period]
		return h('div', { class: 'imp-periods' },
			h('div', { class: 'imp-segmented', role: 'group', 'aria-label': tr('Period') }, Object.entries(PERIODS).map(([k, v]) => h('button', {
				class: state.period === k ? 'active' : '',
				'aria-pressed': state.period === k ? 'true' : 'false',
				onclick: () => { state.period = k; state.offset = 0; localStorageSet('period', k); render() },
			}, v.label()))),
			h('div', { class: 'imp-pager' },
				h('button', { class: 'imp-icon-btn', 'aria-label': tr('Earlier'), onclick: () => { state.offset++; render() } }, '‹'),
				h('span', null, `${p.title(b[0].date)} – ${p.title(b[b.length - 1].date)}`),
				h('button', { class: 'imp-icon-btn', 'aria-label': tr('Later'), disabled: state.offset === 0, onclick: () => { state.offset--; render() } }, '›')))
	}

	/**
	 * Stacked bar chart. series: [{id, name, color, values[]}], one value per bucket.
	 * ghost: optional per-series values drawn as outlined bars behind (planned time).
	 */
	function barChart({ series, labels, titles, format, ghost, goal }) {
		const W = 760
		const H = 260
		const pad = { l: 44, r: 8, t: 12, b: 28 }
		const n = labels.length
		const totals = labels.map((_, i) => series.reduce((s, x) => s + x.values[i], 0))
		const ghostTotals = ghost ? labels.map((_, i) => ghost.reduce((s, x) => s + x.values[i], 0)) : []
		const max = Math.max(1, ...totals, ...ghostTotals, goal ? goal.value * 1.08 : 0)
		const step = niceStep(max)
		const top = Math.ceil(max / step) * step
		const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / top)
		const slot = (W - pad.l - pad.r) / n
		const bw = Math.min(36, slot * 0.6)

		const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'imp-chart', role: 'img', 'aria-label': tr('Chart') })
		for (let v = 0; v <= top + 1e-9; v += step) {
			g.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }))
			g.append(svg('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, format(v, true)))
		}
		labels.forEach((label, i) => {
			const cx = pad.l + slot * i + slot / 2
			if (ghost && ghostTotals[i] > 0) {
				g.append(svg('rect', { x: cx - bw / 2 - 3, y: y(ghostTotals[i]), width: bw + 6, height: y(0) - y(ghostTotals[i]), class: 'ghost', rx: 3 },
					svg('title', null, `${titles[i]} — ${tr('Planned')}: ${format(ghostTotals[i])}`)))
			}
			let acc = 0
			series.forEach((s) => {
				const v = s.values[i]
				if (!v) return
				const y0 = y(acc)
				const y1 = y(acc + v)
				g.append(svg('rect', { x: cx - bw / 2, y: y1, width: bw, height: Math.max(1, y0 - y1 - 1), fill: s.color, rx: 2 },
					svg('title', null, `${titles[i]} — ${s.name}: ${format(v)}`)))
				acc += v
			})
			if (n <= 14 || i % 2 === 0) g.append(svg('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'tick' }, label))
		})
		if (goal) {
			g.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(goal.value), y2: y(goal.value), class: 'goal' }))
			g.append(svg('text', { x: W - pad.r, y: y(goal.value) - 5, 'text-anchor': 'end', class: 'goal-label' }, goal.label))
		}
		return g
	}
	function niceStep(max) {
		const raw = max / 4
		const mag = 10 ** Math.floor(Math.log10(raw))
		const norm = raw / mag
		return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
	}

	function legend(series) {
		return h('ul', { class: 'imp-legend' }, series.map((s) => h('li', null, h('span', { class: 'imp-dot', style: { background: s.color } }), s.name)))
	}

	// ---------------------------------------------------------------------------
	// Page: Notes (per commitment; tick them off, ticked ones show in Done)
	// ---------------------------------------------------------------------------

	async function pageNotes() {
		const page = h('div', { class: 'imp-page imp-notes' })
		if (!state.commitments.length) {
			page.append(h('div', { class: 'imp-empty' }, h('p', null, tr('Create a commitment first.')), h('a', { class: 'imp-button imp-button--primary', href: '#settings' }, tr('Create a commitment'))))
			return page
		}
		if (!commitmentById(state.notesFor)) state.notesFor = commitmentById(state.tasksFor) ? state.tasksFor : state.commitments[0].id
		const c = commitmentById(state.notesFor)
		page.style.setProperty('--c', c.color)
		const all = await api('GET', `notes?commitmentId=${c.id}`)
		const open = all.filter((n) => !n.done)
		const ticked = all.filter((n) => n.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))

		page.append(pageHeader('notes',
			[open.length ? trn('%n open note', '%n open notes', open.length) : tr('No notes for {name} yet.', { name: c.name }),
				ticked.length ? [' · ', trn('%n ticked', '%n ticked', ticked.length)] : null],
			h('div', { class: 'imp-tabs', role: 'tablist', 'aria-label': tr('Commitments') }, state.commitments.map((x) => h('button', {
				role: 'tab',
				'aria-selected': x.id === c.id ? 'true' : 'false',
				class: x.id === c.id ? 'active' : '',
				style: { '--c': x.color },
				onclick: () => { state.notesFor = x.id; state.noteEdit = null; render() },
			}, h('span', { class: 'imp-dot', style: { background: x.color } }), x.name)))))

		page.append(notesBody(c, open, ticked))
		return page
	}

	/** A commitment's notes: the composer, the open ones, the ticked ones folded away */
	function notesBody(c, open, ticked) {
		const out = document.createDocumentFragment()
		out.append(noteComposer(c))
		if (open.length) {
			out.append(h('ul', { class: 'imp-notes__list', 'aria-label': tr('Notes') }, open.map((n, i) => noteItem(n, i, open, c))))
		} else {
			out.append(h('div', { class: 'imp-notes__empty' },
				h('p', null, tr('Notes are for everything that isn\'t a task: ideas, things to ask, links, checklists.')),
				h('p', { class: 'imp-muted' }, PHONE ? tr('Tick a note when it\'s dealt with: it shows in Progress.') : tr('Tick a note when it\'s dealt with: it shows in Done.'))))
		}
		if (ticked.length) {
			out.append(h('details', { class: 'imp-notes__ticked', open: state.notesTickedOpen ? true : null, ontoggle: (e) => { state.notesTickedOpen = e.target.open } },
				h('summary', null, tr('Ticked ({count})', { count: ticked.length })),
				h('ul', { class: 'imp-notes__list' }, ticked.map((n) => noteItem(n, -1, ticked, c)))))
		}
		return out
	}

	// --- markdown (js/markdown.js parses; elements are built here, never from HTML) ---

	/**
	 * @param {string} text markdown
	 * @param {{onToggle?: (line: number, done: boolean) => void}} opts checklist items tickable if given
	 */
	function markdown(text, opts = {}) {
		const MD = window.TrackerMarkdown
		const wrap = h('div', { class: 'imp-md' })
		if (!MD) { wrap.append(h('p', { class: 'imp-md__plain' }, text)); return wrap }
		const inl = (nodes) => nodes.map((x) => {
			switch (x.t) {
				case 'text': return x.v
				case 'br': return h('br')
				case 'code': return h('code', null, x.v)
				case 'strong': return h('strong', null, inl(x.c))
				case 'em': return h('em', null, inl(x.c))
				case 'del': return h('del', null, inl(x.c))
				case 'link': {
					const href = MD.safeUrl(x.href)
					return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow', onclick: (e) => e.stopPropagation() }, inl(x.c)) : inl(x.c)
				}
				default: return null
			}
		})
		const blk = (list) => list.map((b) => {
			switch (b.t) {
				case 'h': return h(['h3', 'h4', 'h5', 'h6', 'h6', 'h6'][b.level - 1], { class: `imp-md__h${b.level}` }, inl(b.c))
				case 'p': return h('p', null, inl(b.c))
				case 'code': return h('pre', null, h('code', null, b.v))
				case 'quote': return h('blockquote', null, blk(b.b))
				case 'hr': return h('hr')
				case 'ul':
				case 'ol': {
					const isTasks = b.items.some((i) => i.task !== null)
					return h(b.t, { class: isTasks ? 'is-tasks' : '', start: b.t === 'ol' && b.start !== 1 ? String(b.start) : null },
						b.items.map((i) => h('li', { class: i.task === null ? '' : `is-task ${i.task ? 'is-checked' : ''}` },
							i.task === null ? null : h('input', {
								type: 'checkbox',
								checked: i.task,
								disabled: !opts.onToggle,
								'aria-label': MD.plainTitle(nodeText(i.c)) || tr('Checklist item'),
								onclick: (e) => e.stopPropagation(),
								onchange: (e) => opts.onToggle && opts.onToggle(i.line, e.target.checked),
							}),
							h('span', { class: 'imp-md__li' }, inl(i.c)),
							i.b.length ? blk(i.b) : null)))
				}
				default: return null
			}
		})
		wrap.append(...[blk(MD.parse(text))].flat(Infinity).filter((x) => x !== null && x !== undefined))
		return wrap
	}
	const nodeText = (nodes) => nodes.map((x) => (x.t === 'text' || x.t === 'code' ? x.v : x.c ? nodeText(x.c) : ' ')).join('')

	async function saveNoteOrder(c, ids) {
		await api('POST', 'notes-order', { commitmentId: c.id, ids })
		await render()
	}

	const noteFirstLine = (text) => {
		const t = window.TrackerMarkdown ? window.TrackerMarkdown.plainTitle(text) : String(text || '').split('\n')[0]
		return t.length > 60 ? t.slice(0, 59) + '…' : t
	}

	function noteItem(n, index, list, c) {
		const open = !n.done
		const editing = state.noteEdit && state.noteEdit.id === n.id
		const li = h('li', {
			class: `imp-note ${n.done ? 'is-done' : ''} ${editing ? 'is-editing' : ''}`,
			style: { '--c': c.color },
			ondragstart: (e) => {
				if (e.target !== li) return
				e.dataTransfer.setData('text/plain', String(n.id))
				e.dataTransfer.effectAllowed = 'move'
				li.classList.add('is-dragging')
			},
			ondragend: () => { li.classList.remove('is-dragging'); li.draggable = false },
			ondragover: (e) => { if (open && !editing) { e.preventDefault(); li.classList.add('is-over') } },
			ondragleave: () => li.classList.remove('is-over'),
			ondrop: async (e) => {
				e.preventDefault()
				li.classList.remove('is-over')
				const dragged = Number(e.dataTransfer.getData('text/plain'))
				if (!open || !dragged || dragged === n.id || !list.some((x) => x.id === dragged)) return
				const ids = list.map((x) => x.id).filter((x) => x !== dragged)
				ids.splice(ids.indexOf(n.id), 0, dragged)
				await saveNoteOrder(c, ids)
			},
		})

		if (editing) {
			li.append(noteEditor({
				id: `imp-ne-${n.id}`,
				value: state.noteEdit.text,
				label: tr('Edit note'),
				saveLabel: tr('Save'),
				onInput: (v) => { state.noteEdit.text = v },
				onCancel: () => { state.noteEdit = null; state.refocus = `imp-nt-${n.id}`; render() },
				onSave: async (v) => {
					if (!v.trim()) {
						if (!window.confirm(tr('Delete this note?'))) return false
						await api('DELETE', `notes/${n.id}`)
					} else {
						await api('PUT', `notes/${n.id}`, { text: v })
					}
					state.noteEdit = null
					state.refocus = `imp-nt-${n.id}`
					await render()
				},
			}))
			return li
		}

		const [doneTasks, allTasks] = window.TrackerMarkdown ? window.TrackerMarkdown.taskCount(n.text) : [0, 0]
		const content = markdown(n.text, {
			onToggle: open ? async (line, done) => {
				const text = window.TrackerMarkdown.toggleTask(n.text, line, done)
				state.refocus = null
				await api('PUT', `notes/${n.id}`, { text })
				await render()
			} : null,
		})
		const expanded = state.expandedNotes.has(n.id)
		content.classList.add('imp-note__content')
		if (!expanded) content.classList.add('is-clamped')
		const startEdit = () => {
			state.noteEdit = { id: n.id, text: n.text }
			// One editor at a time: an empty composer closes (a draft stays)
			if (state.noteDraft && !String(state.noteDraft.text || '').trim()) state.noteDraft.open = false
			render()
		}
		content.addEventListener('click', (e) => {
			if (window.getSelection && String(window.getSelection())) return // selecting text, not editing
			if (e.target.closest('a, input, button')) return
			startEdit()
		})
		const more = h('button', {
			type: 'button',
			class: 'imp-link imp-note__more',
			hidden: true,
			onclick: () => {
				if (state.expandedNotes.has(n.id)) state.expandedNotes.delete(n.id)
				else state.expandedNotes.add(n.id)
				render()
			},
		}, expanded ? tr('Show less') : tr('Show more'))
		// Only offer "Show more" when the note really is cut off
		requestAnimationFrame(() => {
			const limit = parseFloat(getComputedStyle(content).maxHeight)
			const cut = !expanded && Number.isFinite(limit) && content.scrollHeight > limit + 8
			content.classList.toggle('is-cut', cut)
			if (expanded || cut) more.hidden = false
		})

		li.append(...[
			open ? h('span', {
				class: 'imp-note__handle',
				title: tr('Drag to reorder'),
				'aria-hidden': 'true',
				onmousedown: () => { li.draggable = true },
				onmouseup: () => { li.draggable = false },
			}, '⋮⋮') : null,
			h('input', {
				type: 'checkbox',
				class: 'imp-note__tick',
				id: `imp-nc-${n.id}`,
				checked: n.done,
				'aria-label': tr(n.done ? 'Untick: {title}' : 'Tick: {title}', { title: noteFirstLine(n.text) }),
				title: n.done ? tr('Untick') : tr('Tick off (shows in Done)'),
				onchange: async (e) => {
					state.refocus = `imp-nc-${n.id}`
					await api('PUT', `notes/${n.id}`, { done: e.target.checked })
					await render()
				},
			}),
			h('div', { class: 'imp-note__body' },
				content,
				more,
				(allTasks || (n.done && n.doneAt)) ? h('div', { class: 'imp-note__meta' },
					allTasks ? h('span', { class: `imp-note__progress ${doneTasks === allTasks ? 'is-complete' : ''}`, title: tr('Checklist') },
						h('span', { class: 'imp-note__bar', 'aria-hidden': 'true' }, h('span', { style: { width: `${(doneTasks / allTasks) * 100}%` } })),
						tr('{done} of {total}', { done: doneTasks, total: allTasks })) : null,
					n.done && n.doneAt ? h('span', null, tr('Ticked {date}', { date: fmt.dateTime.format(at(n.doneAt)) })) : null) : null),
			h('div', { class: 'imp-note__actions' },
				open ? h('button', {
					type: 'button',
					id: `imp-nt-${n.id}`,
					class: 'imp-icon-btn',
					'aria-label': tr('Edit note: {title}', { title: noteFirstLine(n.text) }),
					title: tr('Edit'),
					onclick: startEdit,
					onkeydown: (e) => {
						// Alt+↑/↓ moves an open note
						if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
						e.preventDefault()
						const j = index + (e.key === 'ArrowUp' ? -1 : 1)
						if (j < 0 || j >= list.length) return
						const ids = list.map((x) => x.id)
						;[ids[index], ids[j]] = [ids[j], ids[index]]
						state.refocus = `imp-nt-${n.id}`
						saveNoteOrder(c, ids)
					},
				}, icon('M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4', 18)) : null,
				h('button', {
					type: 'button',
					class: 'imp-icon-btn imp-note__del',
					'aria-label': tr('Delete note: {title}', { title: noteFirstLine(n.text) }),
					title: tr('Delete note'),
					onclick: async () => {
						if (!window.confirm(tr('Delete this note?'))) return
						await api('DELETE', `notes/${n.id}`)
						await render()
					},
				}, icon('M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3', 18))),
		].filter(Boolean))
		return li
	}

	/** New note: a calm field that opens the editor. */
	function noteComposer(c) {
		if (state.noteDraft && state.noteDraft.for === c.id && state.noteDraft.open) {
			return h('div', { class: 'imp-notes__composer is-open' }, noteEditor({
				id: 'imp-note-new',
				value: state.noteDraft.text || '',
				label: tr('New note for {name}', { name: c.name }),
				placeholder: tr('Write a note… Markdown works: **bold**, - [ ] checklists, links'),
				saveLabel: tr('Add note'),
				autofocus: true,
				onInput: (v) => { state.noteDraft.text = v },
				onCancel: () => { state.noteDraft = { for: c.id, text: state.noteDraft.text, open: false }; render() },
				onSave: async (v) => {
					if (!v.trim()) return false
					await api('POST', 'notes', { commitmentId: c.id, text: v })
					// ready for the next one on a computer; on a phone the editor would fill the screen
					state.noteDraft = { for: c.id, text: '', open: !window.matchMedia('(hover: none)').matches }
					await render()
				},
			}))
		}
		const draft = state.noteDraft && state.noteDraft.for === c.id && state.noteDraft.text ? state.noteDraft.text : ''
		return h('button', {
			type: 'button',
			id: 'imp-note-new',
			class: 'imp-notes__composer',
			onclick: () => { state.noteDraft = { for: c.id, text: draft, open: true }; render() },
		}, icon('M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4', 18),
		h('span', null, draft ? noteFirstLine(draft) || tr('Write a note…') : tr('Write a note…')),
		draft ? h('span', { class: 'imp-chip is-default' }, tr('Draft')) : null)
	}

	/**
	 * Markdown editor: formatting toolbar, Write/Preview, shortcuts
	 * (Ctrl/⌘ B I K, Ctrl/⌘+Enter saves, Esc cancels), lists continue on Enter.
	 * onSave returns false to keep the editor open.
	 */
	function noteEditor({ id, value, label, placeholder = '', saveLabel, autofocus = true, onInput, onSave, onCancel }) {
		const field = h('textarea', { id, class: 'imp-ned__field', 'aria-label': label, placeholder, maxlength: 20000, rows: 4, spellcheck: 'true' })
		field.value = value || ''
		const preview = h('div', { class: 'imp-ned__preview', hidden: true, 'aria-live': 'polite' })
		const grow = () => { field.style.height = 'auto'; field.style.height = `${Math.min(field.scrollHeight + 2, Math.round(window.innerHeight * 0.6))}px` }
		let busy = false
		const save = async () => {
			if (busy) return
			busy = true
			saveBtn.disabled = true
			try {
				if ((await onSave(field.value)) === false) { busy = false; saveBtn.disabled = !field.value.trim() }
			} catch (e) {
				busy = false
				saveBtn.disabled = false
			}
		}
		const changed = () => { if (onInput) onInput(field.value); saveBtn.disabled = !field.value.trim(); grow() }

		// Replaces [start, end) and selects [selStart, selEnd) (undo keeps working where the browser allows)
		const replace = (start, end, text, selStart, selEnd) => {
			field.focus()
			field.setSelectionRange(start, end)
			let done = false
			try { done = document.execCommand('insertText', false, text) } catch (e) { done = false }
			if (!done || field.value.slice(start, start + text.length) !== text) field.setRangeText(text, start, end, 'end')
			field.setSelectionRange(selStart, selEnd)
			changed()
		}
		const wrapWith = (mark, placeholderText) => {
			const { selectionStart: s, selectionEnd: e, value: v } = field
			if (v.slice(s - mark.length, s) === mark && v.slice(e, e + mark.length) === mark) {
				// already formatted: undo it
				replace(s - mark.length, e + mark.length, v.slice(s, e), s - mark.length, e - mark.length)
				return
			}
			const inner = s === e ? placeholderText : v.slice(s, e)
			replace(s, e, mark + inner + mark, s + mark.length, s + mark.length + inner.length)
		}
		const lineRange = () => {
			const v = field.value
			const s = v.lastIndexOf('\n', field.selectionStart - 1) + 1
			let e = v.indexOf('\n', field.selectionEnd)
			if (e < 0) e = v.length
			return [s, e]
		}
		/** Adds the prefix to each selected line, or removes it when all have it */
		const prefixLines = (make, test) => {
			const [s, e] = lineRange()
			const lines = field.value.slice(s, e).split('\n')
			const all = lines.every((l) => test.test(l))
			const out = lines.map((l, i) => (all ? l.replace(test, '') : make(i) + l.replace(/^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '$1').replace(/^(#{1,6}|>)\s?/, ''))).join('\n')
			replace(s, e, out, s + out.length, s + out.length)
		}
		const link = () => {
			const { selectionStart: s, selectionEnd: e, value: v } = field
			const selected = v.slice(s, e)
			if (/^https?:\/\/\S+$/.test(selected)) {
				replace(s, e, `[${tr('link')}](${selected})`, s + 1, s + 1 + tr('link').length)
				return
			}
			const text = selected || tr('link')
			const url = 'https://'
			replace(s, e, `[${text}](${url})`, s + text.length + 3, s + text.length + 3 + url.length)
		}

		const tool = (title, glyph, run, extra = {}) => h('button', {
			type: 'button', class: 'imp-ned__tool', title, 'aria-label': title,
			onmousedown: (e) => e.preventDefault(), // keep the selection in the field
			onclick: () => { if (!preview.hidden) setMode(false); run() },
			...extra,
		}, glyph)
		const MOD = IS_MAC ? '⌘' : 'Ctrl+'
		const bar = h('div', { class: 'imp-ned__bar', role: 'toolbar', 'aria-label': tr('Formatting') },
			h('div', { class: 'imp-ned__tools' },
				tool(`${tr('Bold')} (${MOD}B)`, h('strong', null, 'B'), () => wrapWith('**', tr('bold'))),
				tool(`${tr('Italic')} (${MOD}I)`, h('em', null, 'I'), () => wrapWith('*', tr('italic'))),
				tool(tr('Strikethrough'), h('del', null, 'S'), () => wrapWith('~~', tr('text'))),
				h('span', { class: 'imp-ned__sep', 'aria-hidden': 'true' }),
				tool(tr('Heading'), 'H', () => prefixLines(() => '## ', /^#{1,6}\s+/)),
				tool(tr('Bulleted list'), icon('M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01', 18), () => prefixLines(() => '- ', /^\s*[-*+]\s+(?!\[[ xX]\])/)),
				tool(tr('Numbered list'), icon('M10 6h10M10 12h10M10 18h10M4 5h1v4M4 9h2M4 14.5a1 1 0 0 1 2 .5L4 18h2', 18), () => prefixLines((i) => `${i + 1}. `, /^\s*\d+[.)]\s+/)),
				tool(tr('Checklist'), icon('M4 5h4v4H4zM4 15h4v4H4zM5 17l1 1 1.5-2M11 7h9M11 17h9', 18), () => prefixLines(() => '- [ ] ', /^\s*[-*+]\s+\[[ xX]\]\s+/)),
				h('span', { class: 'imp-ned__sep', 'aria-hidden': 'true' }),
				tool(tr('Quote'), icon('M7 7h4v5H7l-1 4M14 7h4v5h-4l-1 4', 18), () => prefixLines(() => '> ', /^>\s?/)),
				tool(tr('Code'), icon('M8 8l-4 4 4 4M16 8l4 4-4 4', 18), () => wrapWith('`', tr('code'))),
				tool(`${tr('Link')} (${MOD}K)`, icon('M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1', 18), link)),
			h('div', { class: 'imp-ned__modes', role: 'tablist', 'aria-label': tr('Editor view') },
				h('button', { type: 'button', role: 'tab', class: 'is-active', 'aria-selected': 'true', onclick: () => setMode(false) }, tr('Write')),
				h('button', { type: 'button', role: 'tab', 'aria-selected': 'false', onclick: () => setMode(true) }, tr('Preview'))))
		const [writeTab, previewTab] = bar.querySelectorAll('[role=tab]')
		function setMode(showPreview) {
			preview.hidden = !showPreview
			field.hidden = showPreview
			writeTab.classList.toggle('is-active', !showPreview)
			previewTab.classList.toggle('is-active', showPreview)
			writeTab.setAttribute('aria-selected', String(!showPreview))
			previewTab.setAttribute('aria-selected', String(showPreview))
			if (showPreview) {
				preview.replaceChildren(field.value.trim() ? markdown(field.value) : h('p', { class: 'imp-muted' }, tr('Nothing to preview yet.')))
			} else {
				field.focus()
			}
		}

		field.addEventListener('input', changed)
		field.addEventListener('keydown', (e) => {
			const mod = e.metaKey || e.ctrlKey
			if (mod && e.key === 'Enter') { e.preventDefault(); save(); return }
			if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); return }
			if (mod && !e.shiftKey && !e.altKey) {
				const k = e.key.toLowerCase()
				if (k === 'b') { e.preventDefault(); wrapWith('**', tr('bold')); return }
				if (k === 'i') { e.preventDefault(); wrapWith('*', tr('italic')); return }
				if (k === 'k') { e.preventDefault(); link(); return }
			}
			const v = field.value
			const s = field.selectionStart
			const lineStart = v.lastIndexOf('\n', s - 1) + 1
			const line = v.slice(lineStart, v.indexOf('\n', s) < 0 ? v.length : v.indexOf('\n', s))
			const lm = /^(\s*)([-*+]|(\d+)([.)]))\s+(\[[ xX]\]\s+)?/.exec(line)
			if (e.key === 'Enter' && !e.shiftKey && !mod && !e.isComposing && lm && s === field.selectionEnd) {
				e.preventDefault()
				if (line.length === lm[0].length) {
					// Enter on an empty item ends the list
					replace(lineStart, lineStart + line.length, '', lineStart, lineStart)
					return
				}
				const marker = lm[3] ? `${Number(lm[3]) + 1}${lm[4]}` : lm[2]
				const next = `\n${lm[1]}${marker} ${lm[5] ? '[ ] ' : ''}`
				replace(s, s, next, s + next.length, s + next.length)
				return
			}
			if (e.key === 'Tab' && lm && !mod) {
				// Tab / Shift+Tab: nest list items
				e.preventDefault()
				if (e.shiftKey) {
					if (line.startsWith('  ')) replace(lineStart, lineStart + 2, '', Math.max(lineStart, s - 2), Math.max(lineStart, s - 2))
				} else {
					replace(lineStart, lineStart, '  ', s + 2, s + 2)
				}
			}
		})

		const saveBtn = h('button', { type: 'button', class: 'imp-button imp-button--primary', disabled: !field.value.trim(), onclick: save }, saveLabel)
		const editor = h('div', { class: 'imp-ned' },
			bar,
			field,
			preview,
			h('div', { class: 'imp-ned__foot' },
				h('span', { class: 'imp-muted imp-ned__hint' }, tr('Markdown'), ' · ', `${MOD}↵ ${tr('to save')}`),
				h('button', { type: 'button', class: 'imp-button', onclick: () => onCancel() }, tr('Cancel')),
				saveBtn))
		setTimeout(() => {
			grow()
			if (autofocus && document.body.contains(field)) {
				field.focus()
				field.setSelectionRange(field.value.length, field.value.length)
			}
		}, 0)
		return editor
	}

	// ---------------------------------------------------------------------------
	// Page: Done
	// ---------------------------------------------------------------------------

	/** One week on the timeline; hover a block to see what was done in it. */
	async function pageDone() {
		const page = h('div', { class: 'imp-page imp-report imp-done' })
		const ws = addPeriod(startOfWeek(new Date()), 'week', -state.doneWeek)
		const from = Math.floor(ws / 1000)
		const to = Math.floor(addPeriod(ws, 'week', 1) / 1000)
		const [done, blocks, sessions] = await Promise.all([
			api('GET', `done?from=${from}&to=${to}`),
			api('GET', `blocks?from=${from}&to=${to}`),
			api('GET', `sessions?from=${from}&to=${to}`),
		])

		const addBtn = h('button', { type: 'button', class: 'imp-button', onclick: () => addTimeEditor(addBtn, null) }, '+ ', tr('Add tracked time'))
		page.append(pageHeader('done',
			[doneCount(done), ' · ', tr('tracked {time}', { time: duration(sessions.reduce((sum, x) => sum + overlapSeconds(x.start, x.end ?? nowTs(), from, to), 0), { short: true }) })],
			addBtn,
			h('div', { class: 'imp-pager' },
				h('button', { class: 'imp-icon-btn', 'aria-label': tr('Previous week'), onclick: () => { state.doneWeek++; render() } }, '‹'),
				h('span', { class: 'imp-done__week' }, state.doneWeek === 0 ? tr('This week') : tr('Week of {date}', { date: fmt.day.format(ws) })),
				h('button', { class: 'imp-icon-btn', 'aria-label': tr('Next week'), disabled: state.doneWeek === 0, onclick: () => { state.doneWeek--; render() } }, '›'),
				state.doneWeek > 0 ? h('button', { class: 'imp-link', onclick: () => { state.doneWeek = 0; render() } }, tr('This week')) : null)))

		page.append(h('figure', { class: 'imp-figure' },
			weekTimeline({ start: from, blocks: blocks.blocks, overlaps: blocks.overlaps, sessions, done, onAddTime: addTimeEditor }, true),
			h('figcaption', null, timelineLegend(true))))
		return page
	}

	/** Worked but forgot to press play: add the time afterwards. `preset` from a block: commitment, start, end */
	function addTimeEditor(anchor, preset) {
		const now = nowTs()
		const last = Number(localStorageGet('addTimeCommitment', '')) || null
		const cid = preset ? preset.commitmentId : (commitmentById(last) ? last : null)
		const end = preset ? preset.end : now - (now % 300)
		const start = preset ? preset.start : end - 3600
		calPanel(anchor, () => {
			const who = h('select', { 'aria-label': tr('Commitment'), autofocus: true },
				h('option', { value: '', selected: cid === null }, tr('Unplanned')),
				state.commitments.map((c) => h('option', { value: c.id, selected: c.id === cid }, c.name)))
			const day = h('input', { type: 'date', required: true, max: dateValue(at(now)), value: dateValue(at(start)), 'aria-label': tr('Day') })
			const from = h('input', { type: 'time', required: true, value: timeValue(start), 'aria-label': tr('From') })
			const until = h('input', { type: 'time', required: true, value: timeValue(end), 'aria-label': tr('Until') })
			const save = async (e) => {
				e.preventDefault()
				const s = fromInputs(day.value, from.value)
				let en = fromInputs(day.value, until.value)
				if (!Number.isFinite(s) || !Number.isFinite(en)) return
				if (en <= s) en += 86400 // until after midnight
				const commitmentId = who.value ? Number(who.value) : null
				try { await api('POST', 'sessions', { commitmentId, start: s, end: en }) } catch (err) { return }
				localStorageSet('addTimeCommitment', who.value)
				closeCalPanel()
				toast(tr('Tracked time added'))
				await render()
			}
			return h('form', { class: 'imp-cvpanel__form', onsubmit: save },
				h('h2', null, tr('Add tracked time')),
				h('p', { class: 'imp-muted' }, tr('For time you worked without pressing play. It can\'t overlap time you tracked already.')),
				h('label', { class: 'imp-cvpanel__field' }, h('span', null, tr('Commitment')), who),
				h('label', { class: 'imp-cvpanel__field' }, h('span', null, tr('Day')), day),
				h('div', { class: 'imp-cvpanel__field' }, h('span', null, tr('Time')), h('span', { class: 'imp-cvpanel__pair' }, from, h('span', { 'aria-hidden': 'true' }, '–'), until)),
				h('div', { class: 'imp-cvpanel__actions' },
					h('span', { class: 'imp-cvpanel__spacer' }),
					h('button', { type: 'button', class: 'imp-button', onclick: () => closeCalPanel() }, tr('Cancel')),
					h('button', { type: 'submit', class: 'imp-button imp-button--primary' }, tr('Add'))))
		}, { label: tr('Add tracked time') })
	}

	// ---------------------------------------------------------------------------
	// Page: Time (summary of tracked vs planned)
	// ---------------------------------------------------------------------------

	function overlapSeconds(s, e, from, to) {
		return Math.max(0, Math.min(e, to) - Math.max(s, from))
	}

	async function pageTime() {
		const b = buckets()
		const from = b[0].start
		const to = b[b.length - 1].end
		const [sessions, blocks] = await Promise.all([
			api('GET', `sessions?from=${from}&to=${to}`),
			api('GET', `blocks?from=${from}&to=${to}`),
		])
		const now = nowTs()
		const page = h('div', { class: 'imp-page imp-report' }, pageHeader('time', tr('Hours per commitment: planned in blocks and tracked')))
		if (state.commitments.length) page.append(await hoursOverview())
		page.append(h('h2', { class: 'imp-report__sub' }, tr('Over time')), periodControls())

		const ids = [...state.commitments.map((c) => c.id)]
		if (sessions.some((s) => s.commitmentId === null)) ids.push(null)
		sessions.forEach((s) => { if (s.commitmentId !== null && !ids.includes(s.commitmentId)) ids.push(s.commitmentId) })

		const tracked = (id, x) => sessions.filter((s) => s.commitmentId === id).reduce((sum, s) => sum + overlapSeconds(s.start, s.end ?? now, x.start, x.end), 0)
		const planned = (id, x) => blocks.blocks.filter((bl) => bl.commitmentId === id).reduce((sum, bl) => sum + overlapSeconds(bl.start, bl.end, x.start, x.end), 0)

		const series = ids.map((id) => ({ id, name: nameOf(id), color: colorOf(id), values: b.map((x) => tracked(id, x) / 3600) }))
		const ghost = ids.map((id) => ({ id, values: b.map((x) => planned(id, x) / 3600) }))
		const p = PERIODS[state.period]
		// Goal line: sum of the weekly goals, only in the week view
		const goalSum = state.commitments.reduce((sum, c) => sum + (c.weeklyGoal || 0), 0)
		const goalLine = state.period === 'week' && goalSum ? { value: goalSum / 60, label: tr('Goal {time}', { time: fmtMin(goalSum) }) } : null
		const hours = (v, axis) => (axis ? `${Math.round(v * 10) / 10}h` : duration(v * 3600, { short: true }))

		page.append(h('figure', { class: 'imp-figure' },
			barChart({ series, ghost, goal: goalLine, labels: b.map((x) => p.tick(x.date)), titles: b.map((x) => p.title(x.date)), format: hours }),
			h('figcaption', null, legend(series),
				h('span', { class: 'imp-legend__ghost' }, h('span', { class: 'imp-ghost-swatch' }), tr('Planned in the calendar')),
				goalLine ? h('span', { class: 'imp-legend__ghost' }, h('span', { class: 'imp-goal-swatch' }), tr('Weekly goals')) : null)))

		// Table: one row per commitment, columns for the last periods + total
		const shown = b.slice(-6)
		const totalTracked = (id) => b.reduce((s, x) => s + tracked(id, x), 0)
		const totalPlanned = (id) => b.reduce((s, x) => s + planned(id, x), 0)
		// The same numbers as a table, folded away (less scrolling)
		page.append(h('details', { class: 'imp-sessions imp-report__table' }, h('summary', null, tr('As a table')), h('div', { class: 'imp-tablewrap' }, h('table', { class: 'imp-table' },
			h('thead', null, h('tr', null,
				h('th', { scope: 'col' }, tr('Commitment')),
				shown.map((x) => h('th', { scope: 'col', class: 'num' }, p.tick(x.date))),
				h('th', { scope: 'col', class: 'num' }, tr('Total ({count} {unit})', { count: b.length, unit: PERIODS[state.period].label().toLowerCase() })),
				h('th', { scope: 'col', class: 'num' }, tr('Planned ({count} {unit})', { count: b.length, unit: PERIODS[state.period].label().toLowerCase() })),
				goalSum ? h('th', { scope: 'col', class: 'num' }, tr('Weekly goal')) : null)),
			h('tbody', null, ids.map((id) => h('tr', null,
				h('th', { scope: 'row' }, h('span', { class: 'imp-dot', style: { background: colorOf(id) } }), nameOf(id)),
				shown.map((x) => {
					const sec = tracked(id, x)
					const g = state.period === 'week' ? commitmentById(id)?.weeklyGoal : null
					const met = g && sec / 60 >= g
					return h('td', { class: `num ${met ? 'is-met' : ''}`, title: met ? tr('Goal reached') : null }, sec ? duration(sec, { short: true }) : '–', met ? ' ✓' : '')
				}),
				h('td', { class: 'num strong' }, duration(totalTracked(id), { short: true })),
				h('td', { class: 'num imp-muted' }, id === null ? '–' : duration(totalPlanned(id), { short: true })),
				goalSum ? h('td', { class: 'num imp-muted' }, commitmentById(id)?.weeklyGoal ? fmtMin(commitmentById(id).weeklyGoal) : '–') : null))),
			h('tfoot', null, h('tr', null,
				h('th', { scope: 'row' }, tr('All')),
				shown.map((x) => h('td', { class: 'num' }, duration(ids.reduce((s, id) => s + tracked(id, x), 0), { short: true }))),
				h('td', { class: 'num strong' }, duration(ids.reduce((s, id) => s + totalTracked(id), 0), { short: true })),
				h('td', { class: 'num imp-muted' }, duration(ids.reduce((s, id) => s + (id === null ? 0 : totalPlanned(id)), 0), { short: true })),
				goalSum ? h('td', { class: 'num imp-muted' }, fmtMin(goalSum)) : null)))),
			h('p', { class: 'imp-muted imp-footnote' }, tr('"Planned" is the time in calendar blocks during the days shown. Blocks coming up are on the Now page.'))))

		// Recent sessions, editable by deletion
		const recent = [...sessions].sort((a, z) => z.start - a.start).slice(0, 15)
		if (recent.length) {
			page.append(h('details', { class: 'imp-sessions' },
				h('summary', null, tr('Recent tracking')),
				h('ul', null, recent.map((s) => h('li', null,
					h('span', { class: 'imp-dot', style: { background: colorOf(s.commitmentId) } }),
					h('span', null, nameOf(s.commitmentId)),
					h('span', { class: 'imp-muted' }, ` ${fmt.dateTime.format(at(s.start))} · ${s.end ? duration(s.end - s.start) : tr('running')}`),
					s.end ? h('button', {
						class: 'imp-icon-btn', 'aria-label': tr('Delete this entry'),
						onclick: async () => { if (window.confirm(tr('Delete this tracked time?'))) { await api('DELETE', `sessions/${s.id}`); await render() } },
					}, '×') : null)))))
		}
		return page
	}


	// ---------------------------------------------------------------------------
	// Hours per commitment: planned in calendar blocks vs. tracked
	// ---------------------------------------------------------------------------

	/** Week `offset` weeks from this one (Monday start). */
	function weekAt(offset) {
		const d = addPeriod(startOfWeek(new Date()), 'week', offset)
		return { start: Math.floor(d / 1000), end: Math.floor(addPeriod(d, 'week', 1) / 1000), date: d }
	}
	function monthAt(offset) {
		const d = addPeriod(startOfMonth(new Date()), 'month', offset)
		return { start: Math.floor(d / 1000), end: Math.floor(addPeriod(d, 'month', 1) / 1000), date: d }
	}
	const plannedIn = (blocks, cid, from, to) => blocks.filter((b) => b.commitmentId === cid).reduce((a, b) => a + overlapSeconds(b.start, b.end, from, to), 0)
	const trackedIn = (sessions, cid, from, to) => {
		const now = nowTs()
		return sessions.filter((x) => x.commitmentId === cid).reduce((a, x) => a + overlapSeconds(x.start, x.end ?? now, from, to), 0)
	}
	const hoursNum = (sec) => (Math.round((sec / 3600) * 100) / 100).toFixed(2)

	/** Downloads rows as a CSV file (opens a save dialog in the Mac app). */
	/** Saves a file you asked for: the apps ask where (their own dialog), a browser downloads it. @return false if cancelled */
	async function saveFile(name, text, type) {
		if (desktop && desktop.saveFile) return desktop.saveFile(name, text)
		const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name })
		document.body.append(a)
		a.click()
		setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 1000)
		return true
	}

	/** A file you pick: {name, text}, or null if cancelled. */
	function openFile(accept) {
		if (desktop && desktop.openFile) return desktop.openFile()
		return new Promise((resolve, reject) => {
			const input = h('input', { type: 'file', accept, hidden: true })
			const done = (v) => { input.remove(); resolve(v) }
			input.addEventListener('cancel', () => done(null))
			input.addEventListener('change', () => {
				const f = input.files && input.files[0]
				if (!f) return done(null)
				if (f.size > 64 * 1024 * 1024) { input.remove(); reject(new Error(tr('This file is too large.'))); return }
				f.text().then((text) => done({ name: f.name, text }), (e) => { input.remove(); reject(e) })
			})
			document.body.append(input)
			input.click()
		})
	}

	function downloadCsv(filename, rows) {
		const esc = (v) => {
			let s = String(v)
			// Spreadsheets run cells starting with = + - @ as formulas: keep names as text
			if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`
			return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
		}
		saveFile(filename, rows.map((r) => r.map(esc).join(',')).join('\n') + '\n', 'text/csv;charset=utf-8')
			.catch((e) => { if (!e.shown) toast(e.message || tr('Something went wrong.'), true) })
	}

	// ---------------------------------------------------------------------------
	// Backup: everything in one file, to keep or to bring to another device
	// ---------------------------------------------------------------------------

	/*
	 * {"format": "blockwise-backup", "version": 1, "exported": "<ISO date>", "records": [...]}
	 * Records are as sync sends them (type, id, fields, clock), so importing merges
	 * like a sync: per field the later change wins, and nothing is deleted.
	 * Encrypted: "records" is replaced by "encrypted": AES-256-GCM with a key from
	 * your passphrase (PBKDF2-SHA-256, 600 000 rounds, random salt), as drive sync.
	 */
	const BACKUP = { format: 'blockwise-backup', version: 1, iterations: 600000, aad: 'blockwise-backup-1' }
	const BACKUP_ORDER = { settings: 0, commitment: 1, task: 2, subtask: 3, note: 4, session: 5, block: 6 }
	const b64 = (u8) => {
		let s = ''
		for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
		return btoa(s)
	}
	const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

	async function backupKey(passphrase, salt, iterations) {
		const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey'])
		return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
	}

	async function sealBackup(plain, passphrase) {
		const salt = crypto.getRandomValues(new Uint8Array(16))
		const iv = crypto.getRandomValues(new Uint8Array(12))
		const key = await backupKey(passphrase, salt, BACKUP.iterations)
		const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(BACKUP.aad) }, key, new TextEncoder().encode(JSON.stringify(plain.records))))
		return { format: BACKUP.format, version: BACKUP.version, exported: plain.exported,
			encrypted: { cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA-256', iterations: BACKUP.iterations, salt: b64(salt), iv: b64(iv), data: b64(data) } }
	}

	/** The records of an encrypted backup. Throws on a wrong passphrase (or a changed file). */
	async function openBackup(file, passphrase) {
		const e = file.encrypted
		if (!e || e.cipher !== 'AES-256-GCM' || e.kdf !== 'PBKDF2-SHA-256' || !Number.isInteger(e.iterations) || e.iterations < 100000 || e.iterations > 10000000) throw new Error(tr('This is not a Blockwise backup.'))
		const key = await backupKey(passphrase, unb64(e.salt), e.iterations)
		let bytes
		try {
			bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv), additionalData: new TextEncoder().encode(BACKUP.aad) }, key, unb64(e.data))
		} catch (err) {
			throw new Error(tr('Wrong passphrase, or the file was changed.'))
		}
		return JSON.parse(new TextDecoder().decode(bytes))
	}

	/** A backup file's contents: {encrypted, records?, exported}. Throws if it isn't one. */
	function readBackup(text) {
		let file = null
		try { file = JSON.parse(text) } catch (e) { /* not JSON */ }
		if (!file || typeof file !== 'object' || file.format !== BACKUP.format) throw new Error(tr('This is not a Blockwise backup.'))
		if (file.version !== BACKUP.version) throw new Error(tr('This backup was made by a newer version of Blockwise. Update this one first.'))
		if (!file.encrypted && !Array.isArray(file.records)) throw new Error(tr('This is not a Blockwise backup.'))
		return file
	}

	const backupCounts = (records) => {
		const n = {}
		for (const r of records) if (r && typeof r === 'object' && typeof r.type === 'string') n[r.type] = (n[r.type] || 0) + 1
		return n
	}
	const backupSummary = (n) => [
		n.commitment && trn('%n commitment', '%n commitments', n.commitment),
		n.task && trn('%n task', '%n tasks', n.task),
		n.subtask && trn('%n subtask', '%n subtasks', n.subtask),
		n.note && trn('%n note', '%n notes', n.note),
		n.session && trn('%n tracked time', '%n tracked times', n.session),
		n.block && trn('%n block', '%n blocks', n.block),
	].filter(Boolean).join(', ')

	/** Settings → Your data: export a backup (encrypted if you like), import one */
	function backupSection() {
		const sec = h('section', { class: 'imp-settings__section imp-backup' }, h('h2', null, tr('Your data')))
		const show = (...nodes) => {
			sec.replaceChildren(h('h2', null, tr('Your data')), ...nodes)
			const first = sec.querySelector('input:not([type="checkbox"])')
			if (first) first.focus()
		}
		const busy = async (btn, fn) => {
			btn.disabled = true
			try { await fn() } catch (e) { if (!e.shown) toast(e.message || tr('Something went wrong.'), true) } finally { btn.disabled = false }
		}

		const home = () => {
			const encrypt = h('input', { type: 'checkbox', id: 'imp-backup-enc', checked: true })
			const pass1 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, 'aria-label': tr('Passphrase') , placeholder: tr('Passphrase') })
			const pass2 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, 'aria-label': tr('Passphrase again'), placeholder: tr('Passphrase again') })
			const passes = h('div', { class: 'imp-backup__pass' }, pass1, pass2,
				h('p', { class: 'imp-muted' }, tr('Nobody can open the file without it, not even you: write it down.')))
			encrypt.addEventListener('change', () => { passes.hidden = !encrypt.checked })
			const exportBtn = h('button', { type: 'submit', class: 'imp-button imp-button--primary' }, tr('Export'))
			const form = h('form', {
				class: 'imp-backup__form',
				onsubmit: (e) => {
					e.preventDefault()
					busy(exportBtn, async () => {
						if (encrypt.checked) {
							if ([...pass1.value].length < 8) throw new Error(tr('The passphrase needs at least 8 characters.'))
							if (pass1.value !== pass2.value) throw new Error(tr('The two passphrases are not the same.'))
						}
						const { records } = await api('GET', 'backup')
						const plain = { format: BACKUP.format, version: BACKUP.version, exported: new Date().toISOString(), records }
						const file = encrypt.checked ? await sealBackup(plain, pass1.value) : plain
						const name = `Blockwise-${isoDay(new Date())}${encrypt.checked ? '-encrypted' : ''}.json`
						if (await saveFile(name, JSON.stringify(file), 'application/json')) {
							pass1.value = pass2.value = ''
							toast(tr('Exported: {what}', { what: backupSummary(backupCounts(records)) || tr('nothing yet') }))
						}
					})
				},
			},
			h('div', { class: 'imp-check' }, encrypt, h('label', { for: 'imp-backup-enc' }, tr('Encrypt with a passphrase'))),
			passes, exportBtn)
			const importBtn = h('button', { type: 'button', class: 'imp-button' }, tr('Import a backup…'))
			importBtn.addEventListener('click', () => busy(importBtn, async () => {
				const picked = await openFile('.json,application/json')
				if (!picked) return
				const file = readBackup(picked.text)
				if (file.encrypted) askPassphrase(file, picked.name)
				else confirmImport(file.records, picked.name)
			}))
			show(
				h('p', { class: 'imp-muted' }, state.features.builtinCalendar
					? tr('A file with your commitments, tasks, notes, tracked time, blocks and settings: to keep, or to bring to another device.')
					: tr('A file with your commitments, tasks, notes, tracked time and settings: to keep, or to bring to another device. Blocks stay in your calendars.')),
				form,
				h('h3', null, tr('Import')),
				h('p', { class: 'imp-muted' }, tr('Adds a backup to what is here. Where something is in both, the later change wins; nothing is deleted.')),
				importBtn)
		}

		const askPassphrase = (file, name) => {
			const pass = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': tr('Passphrase'), placeholder: tr('Passphrase') })
			const openBtn = h('button', { type: 'submit', class: 'imp-button imp-button--primary' }, tr('Open'))
			show(h('p', null, tr('{file} is encrypted. Enter the passphrase it was exported with.', { file: name })),
				h('form', {
					class: 'imp-backup__form',
					onsubmit: (e) => {
						e.preventDefault()
						busy(openBtn, async () => confirmImport(await openBackup(file, pass.value), name))
					},
				}, pass, h('div', { class: 'imp-backup__actions' }, openBtn, h('button', { type: 'button', class: 'imp-button', onclick: home }, tr('Cancel')))))
		}

		const confirmImport = (records, name) => {
			if (!Array.isArray(records)) throw new Error(tr('This is not a Blockwise backup.'))
			const what = backupSummary(backupCounts(records))
			if (!what) throw new Error(tr('This backup is empty.'))
			const goBtn = h('button', { type: 'button', class: 'imp-button imp-button--primary' }, tr('Import'))
			goBtn.addEventListener('click', () => busy(goBtn, async () => {
				const sorted = records.filter((r) => r && typeof r === 'object' && !r.deleted)
					.sort((a, b) => (BACKUP_ORDER[a.type] ?? 9) - (BACKUP_ORDER[b.type] ?? 9))
				let applied = 0
				let blocks = 0
				const reasons = new Set()
				for (let i = 0; i < sorted.length; i += 500) {
					const r = await api('POST', 'backup', { records: sorted.slice(i, i + 500) })
					applied += r.applied || 0
					for (const x of r.rejected || []) {
						if (x.reason === 'Unknown type') blocks++
						else reasons.add(x.reason)
					}
				}
				await refresh()
				toast(tr('Imported {n} items.', { n: applied }))
				const notes = []
				if (blocks) notes.push(trn('%n block was not imported: here, blocks are events in your calendars.', '%n blocks were not imported: here, blocks are events in your calendars.', blocks))
				if (reasons.size) notes.push(tr('Some items were not imported: {reasons}', { reasons: [...reasons].slice(0, 3).map((x) => tr(x)).join('; ') }))
				if (notes.length) toast(notes.join(' '), true)
			}))
			show(h('p', null, tr('Import from {file}: {what}?', { file: name, what })),
				h('p', { class: 'imp-muted' }, tr('Where something is in both, the later change wins; nothing is deleted.')),
				h('div', { class: 'imp-backup__actions' }, goBtn, h('button', { type: 'button', class: 'imp-button', onclick: home }, tr('Cancel'))))
		}

		home()
		return sec
	}
	const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

	/** CSV: one row per week and commitment, planned and tracked hours. */
	function hoursCsv(commitments, blocks, sessions, weeks) {
		const rows = [['week_start', 'commitment', 'planned_hours', 'tracked_hours']]
		weeks.forEach((w) => commitments.forEach((c) => rows.push([isoDay(w.date), c.name, hoursNum(plannedIn(blocks, c.id, w.start, w.end)), w.start > nowTs() ? '' : hoursNum(trackedIn(sessions, c.id, w.start, w.end))])))
		return rows
	}

	// ---------------------------------------------------------------------------
	// Page: one commitment
	// ---------------------------------------------------------------------------

	async function pageCommitment() {
		const c = commitmentById(state.commitmentId)
		if (!c) {
			location.hash = '#now'
			return h('div')
		}
		const now = nowTs()
		const weeksBack = 12
		const from = Math.min(weekAt(-(weeksBack - 1)).start, monthAt(-1).start)
		const to = weekAt(5).start // through the next 4 weeks
		const [dash, sessions, blocksRes, tasks] = await Promise.all([
			api('GET', 'dashboard'),
			api('GET', `sessions?from=${from}&to=${now + 60}`),
			api('GET', `blocks?from=${from}&to=${to}`),
			api('GET', `tasks?commitmentId=${c.id}&status=open`),
		])
		const blocks = blocksRes.blocks.filter((b) => b.commitmentId === c.id)
		const entry = dash.commitments.find((e) => e.commitment.id === c.id) || {}
		const running = dash.running && dash.running.commitmentId === c.id
		const cal = state.calendars.find((x) => x.id === c.calendarId)
		const def = dash.settings.defaultEstimate || 15

		const page = h('div', { class: 'imp-page imp-cpage', style: { '--c': c.color, '--on-c': onColor(c.color) } })

		// 1. Header: the commitment in its color, this week against the goal, start/stop
		const wk = weekAt(0)
		const trackedWeek = trackedIn(sessions, c.id, wk.start, wk.end)
		const plannedWeek = plannedIn(blocks, c.id, wk.start, wk.end)
		const plannedLeft = plannedIn(blocks, c.id, Math.max(now, wk.start), wk.end)
		const coming = blocks.filter((b) => b.end > now).slice(0, 5)
		const head = h('header', { class: 'imp-cpage__head' }, tile(c),
			h('div', null,
				h('h1', null, c.name),
				h('p', null,
					c.weeklyGoal ? tr('{done} of {goal} this week', { done: duration(trackedWeek, { short: true }), goal: fmtMin(c.weeklyGoal) }) : tr('{time} tracked this week', { time: duration(trackedWeek, { short: true }) }),
					coming[0] ? ` · ${tr('next block {when}', { when: blockTime(coming[0]) })}` : ''),
				c.weeklyGoal ? h('div', { class: 'imp-cpage__goal', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': c.weeklyGoal, 'aria-valuenow': Math.floor(trackedWeek / 60), 'aria-label': tr('Weekly goal for {name}', { name: c.name }) },
					h('span', { style: { width: `${Math.min(100, (trackedWeek / 60 / c.weeklyGoal) * 100)}%` } })) : null),
			h('div', { class: 'imp-cpage__actions' },
				h('a', { class: 'imp-button', href: '#tasks', onclick: () => { state.tasksFor = c.id } }, tr('Tasks')),
				h('a', { class: 'imp-button', href: '#settings', title: cal ? tr('Calendar "{name}"', { name: cal.name }) : tr('No calendar linked'), onclick: () => { state.editingCommitment = c.id; state.creatingCommitment = false } }, tr('Edit')),
				h('button', {
					class: `imp-button imp-cpage__start ${running ? 'is-running' : ''}`,
					onclick: () => (running ? stopTracking() : startTracking(c.id)),
					'aria-label': running ? tr('Stop tracking {name}', { name: c.name }) : tr('Start tracking {name}', { name: c.name }),
				}, icon(running ? ICON_STOP : ICON_PLAY, 16, true), running ? tr('Stop') : tr('Start'))))

		// 2. Coming blocks: each as a bar as tall as it is long, and planning a new one
		const blocksCard = h('section', { class: 'imp-cpage__section imp-cpage__blocks' },
			h('div', { class: 'imp-cpage__titlebar' }, h('h2', null, tr('Coming blocks')),
				plannedLeft ? h('span', { class: 'imp-muted' }, tr('{time} still to come this week', { time: duration(plannedLeft, { short: true }) })) : null),
			coming.length
				? h('ul', null, coming.map((b) => h('li', { class: b.start <= now ? 'is-now' : '' },
					h('span', { class: 'imp-cpage__bar', style: { height: `${Math.round(Math.min(56, Math.max(18, (b.end - b.start) / 180)))}px` } }),
					h('span', null, h('strong', null, blockTime(b)), b.title ? h('span', { class: 'imp-muted' }, b.title) : null))))
				: h('p', { class: 'imp-muted' }, tr('No blocks planned.')),
			state.features.createBlocks ? newBlockForm(c) : null)

		// 3. Hours committed (for work or university)
		const rows = []
		for (let o = -4; o <= 4; o++) rows.push({ o, ...weekAt(o) })
		const avg = (list, fn) => (list.length ? list.reduce((a, w) => a + fn(w), 0) / list.length : 0)
		const lastFour = rows.filter((w) => w.o < 0)
		const nextFour = rows.filter((w) => w.o > 0)
		const m0 = monthAt(0)
		const m1 = monthAt(-1)
		const hoursSec = h('section', { class: 'imp-cpage__section' },
			h('div', { class: 'imp-cpage__titlebar' },
				h('h2', null, tr('Hours committed')),
				h('button', {
					class: 'imp-button',
					onclick: () => {
						const weeks = []
						for (let o = -(weeksBack - 1); o <= 4; o++) weeks.push(weekAt(o))
						downloadCsv(`${c.name.replace(/[^\w-]+/g, '_')}-hours.csv`, hoursCsv([c], blocks, sessions, weeks))
					},
				}, tr('Export CSV'))),
			h('p', { class: 'imp-cpage__lead' },
				tr('On average {past} per week in blocks over the last 4 weeks ({tracked} tracked), {next} per week planned for the next 4 weeks.', {
					past: duration(avg(lastFour, (w) => plannedIn(blocks, c.id, w.start, w.end)), { short: true }),
					tracked: duration(avg(lastFour, (w) => trackedIn(sessions, c.id, w.start, w.end)), { short: true }),
					next: duration(avg(nextFour, (w) => plannedIn(blocks, c.id, w.start, w.end)), { short: true }),
				})),
			h('p', { class: 'imp-muted' },
				tr('{month}: {planned} planned, {tracked} tracked', { month: fmt.monthLong.format(m0.date), planned: duration(plannedIn(blocks, c.id, m0.start, m0.end), { short: true }), tracked: duration(trackedIn(sessions, c.id, m0.start, m0.end), { short: true }) }),
				' · ',
				tr('{month}: {planned} planned, {tracked} tracked', { month: fmt.monthLong.format(m1.date), planned: duration(plannedIn(blocks, c.id, m1.start, m1.end), { short: true }), tracked: duration(trackedIn(sessions, c.id, m1.start, m1.end), { short: true }) })),
			// The weeks one by one, folded away (the summary above says it in short)
			h('details', { class: 'imp-cpage__weeks' }, h('summary', null, tr('Week by week')), h('div', { class: 'imp-tablewrap' }, h('table', { class: 'imp-table imp-table--compact' },
				h('thead', null, h('tr', null,
					h('th', { scope: 'col' }, tr('Week')),
					h('th', { scope: 'col', class: 'num' }, tr('In blocks')),
					h('th', { scope: 'col', class: 'num' }, tr('Tracked')),
					c.weeklyGoal ? h('th', { scope: 'col', class: 'num' }, tr('Goal')) : null)),
				h('tbody', null, rows.map((w) => {
					const p = plannedIn(blocks, c.id, w.start, w.end)
					const tsec = w.start > now ? null : trackedIn(sessions, c.id, w.start, w.end)
					const met = c.weeklyGoal && tsec !== null && tsec / 60 >= c.weeklyGoal
					return h('tr', { class: w.o === 0 ? 'is-current' : w.o > 0 ? 'is-future' : '' },
						h('th', { scope: 'row' }, w.o === 0 ? tr('This week') : tr('Week of {date}', { date: fmt.day.format(w.date) })),
						h('td', { class: 'num' }, p ? duration(p, { short: true }) : '–'),
						h('td', { class: `num ${met ? 'is-met' : ''}` }, tsec === null ? '' : tsec ? duration(tsec, { short: true }) : '–', met ? ' ✓' : ''),
						c.weeklyGoal ? h('td', { class: 'num imp-muted' }, fmtMin(c.weeklyGoal)) : null)
				}))))))

		// 4. Trend: 12 weeks
		const trendWeeks = []
		for (let o = -(weeksBack - 1); o <= 0; o++) trendWeeks.push(weekAt(o))
		const trackedSeries = trendWeeks.map((w) => trackedIn(sessions, c.id, w.start, w.end) / 3600)
		let streak = 0
		if (c.weeklyGoal) {
			// Weeks in a row with the goal reached, counting back from last week (this week counts once reached)
			const met = trendWeeks.map((w, i) => trackedSeries[i] * 60 >= c.weeklyGoal)
			let i = met[met.length - 1] ? met.length - 1 : met.length - 2
			for (; i >= 0 && met[i]; i--) streak++
		}
		const trendSec = h('section', { class: 'imp-cpage__section' },
			h('div', { class: 'imp-cpage__titlebar' },
				h('h2', null, tr('Last 12 weeks')),
				c.weeklyGoal ? h('span', { class: streak ? 'imp-goal__ok' : 'imp-muted' }, streak ? trn('Goal reached %n week in a row', 'Goal reached %n weeks in a row', streak) : tr('Goal not reached last week')) : null),
			h('figure', { class: 'imp-figure' },
				barChart({
					series: [{ id: c.id, name: c.name, color: c.color, values: trackedSeries }],
					ghost: [{ id: c.id, values: trendWeeks.map((w) => plannedIn(blocks, c.id, w.start, w.end) / 3600) }],
					goal: c.weeklyGoal ? { value: c.weeklyGoal / 60, label: tr('Goal {time}', { time: fmtMin(c.weeklyGoal) }) } : null,
					labels: trendWeeks.map((w) => fmt.dayShort.format(w.date)),
					titles: trendWeeks.map((w) => tr('Week of {date}', { date: fmt.day.format(w.date) })),
					format: (v, axis) => (axis ? `${Math.round(v * 10) / 10}h` : duration(v * 3600, { short: true })),
				}),
				h('figcaption', null,
					h('span', { class: 'imp-legend__ghost' }, h('span', { class: 'imp-dot', style: { background: c.color } }), tr('Tracked')),
					h('span', { class: 'imp-legend__ghost' }, h('span', { class: 'imp-ghost-swatch' }), tr('Planned in the calendar')))))

		// 5. Forecast
		const remaining = tasks.reduce((a, t) => a + t.subtasks.filter((x) => !x.done).reduce((b, x) => b + (x.estimate ?? def) * 60, 0), 0)
		const missing = tasks.reduce((a, t) => a + t.subtasks.filter((x) => !x.done && x.estimate === null).length, 0)
		const pace = avg(lastFour, (w) => trackedIn(sessions, c.id, w.start, w.end)) // seconds per week
		const ahead = plannedIn(blocks, c.id, now, weekAt(5).start)
		const forecast = []
		if (!remaining) {
			forecast.push(h('p', null, tr('No open work in the queue.')))
		} else {
			forecast.push(h('p', { class: 'imp-cpage__lead' }, trn('{time} of work left in %n open task', '{time} of work left in %n open tasks', tasks.length, { time: duration(remaining, { short: true }) }),
				missing ? h('span', { class: 'imp-muted' }, ` (${trn('%n subtask without estimate counted as {def}', '%n subtasks without estimate counted as {def} each', missing, { def: fmtMin(def) })})`) : null))
			if (pace > 0) {
				const weeks = remaining / pace
				const doneAt = new Date((now + weeks * 7 * 86400) * 1000)
				forecast.push(h('p', null, tr('At your pace of {pace} per week (last 4 weeks), that is about {weeks} of work: done around {date}.', {
					pace: duration(pace, { short: true }),
					weeks: weeks < 1 ? trn('%n day', '%n days', Math.max(1, Math.round(weeks * 7))) : trn('%n week', '%n weeks', Math.round(weeks * 10) / 10),
					date: fmt.day.format(doneAt),
				})))
			} else {
				forecast.push(h('p', { class: 'imp-muted' }, tr('No time tracked in the last 4 weeks, so there is no pace to forecast from yet.')))
			}
			forecast.push(h('p', null, tr('Blocks in the next 4 weeks: {time}.', { time: duration(ahead, { short: true }) }), ' ',
				ahead >= remaining
					? h('span', { class: 'imp-cap__ok' }, tr('Enough for the open tasks.'))
					: h('span', { class: 'imp-cap__warn' }, tr('{time} short of the open tasks.', { time: duration(remaining - ahead, { short: true }) }))))
		}
		const forecastSec = h('section', { class: 'imp-cpage__section' }, h('h2', null, tr('Forecast')), forecast)

		// 6. Block discipline: last 4 weeks
		const dFrom = weekAt(-4).start
		const past = blocks.filter((b) => b.end <= now && b.start >= dFrom)
		const mine = sessions.filter((x) => x.commitmentId === c.id)
		const inBlock = (b) => mine.reduce((a, x) => a + overlapSeconds(x.start, x.end ?? now, b.start, b.end), 0)
		const plannedPast = past.reduce((a, b) => a + (b.end - b.start), 0)
		const trackedInside = past.reduce((a, b) => a + inBlock(b), 0)
		const skipped = past.filter((b) => inBlock(b) === 0)
		const trackedAll = trackedIn(sessions, c.id, dFrom, now)
		const outside = Math.max(0, trackedAll - trackedInside)
		const keptSec = h('section', { class: 'imp-cpage__section' },
			h('h2', null, tr('Blocks kept')),
			plannedPast
				? [h('dl', { class: 'imp-stats' },
					h('div', null, h('dt', null, tr('Block time used')), h('dd', null, `${Math.round((trackedInside / plannedPast) * 100)}%`, h('small', null, ` · ${duration(trackedInside, { short: true })} / ${duration(plannedPast, { short: true })}`))),
					h('div', null, h('dt', null, tr('Blocks skipped')), h('dd', null, `${skipped.length}`, h('small', null, ` / ${past.length}`))),
					h('div', null, h('dt', null, tr('Tracked outside blocks')), h('dd', null, duration(outside, { short: true })))),
				skipped.length ? h('p', { class: 'imp-muted' }, tr('Skipped: {list}', { list: skipped.slice(-4).map((b) => fmt.day.format(at(b.start))).join(', ') })) : null,
				h('p', { class: 'imp-muted imp-footnote' }, tr('Last 4 weeks, blocks that have ended.'))]
				: h('p', { class: 'imp-muted' }, tr('No blocks in the last 4 weeks.')))

		// 8. Tasks, most often carried over first
		const sorted = [...tasks].sort((a, b) => b.carried - a.carried || a.position - b.position)
		const tasksSec = h('section', { class: 'imp-cpage__section imp-cpage__open' },
			h('div', { class: 'imp-cpage__titlebar' },
				h('h2', null, tr('Open tasks')),
				h('a', { href: '#tasks', onclick: () => { state.tasksFor = c.id } }, tr('Manage tasks'))),
			sorted.length
				? h('ul', { class: 'imp-cpage__tasks' }, sorted.map((t) => {
					const done = t.subtasks.filter((x) => x.done).length
					const left = remainingMin(t)
					return h('li', null,
						h('div', { class: 'imp-cpage__task' },
							h('span', { class: 'imp-cpage__tname' }, t.title),
							t.carried >= 2 ? h('span', { class: 'imp-badge is-stuck', title: tr('Not finished in earlier blocks') }, trn('carried over %n time', 'carried over %n times', t.carried)) : t.carried ? h('span', { class: 'imp-badge' }, tr('carried over')) : null,
							h('span', { class: 'imp-muted imp-cpage__tmeta' }, `${done}/${t.subtasks.length}`, left ? ` · ${tr('{time} left', { time: fmtMin(left) })}` : '')),
						h('div', { class: 'imp-cpage__tbar', 'aria-hidden': 'true' }, h('span', { style: { width: `${t.subtasks.length ? (done / t.subtasks.length) * 100 : 0}%` } })))
				}))
				: h('p', { class: 'imp-muted' }, tr('No open tasks.')))

		// The numbers at a glance, then blocks and tasks side by side, then the history
		const stat = (label, value, sub) => h('div', null, h('dt', null, label), h('dd', null, value, sub ? h('small', null, sub) : null))
		page.append(head,
			h('dl', { class: 'imp-cpage__stats' },
				stat(tr('Tracked'), duration(trackedWeek, { short: true }), c.weeklyGoal ? ` / ${fmtMin(c.weeklyGoal)}` : tr('this week')),
				stat(tr('In blocks'), duration(plannedWeek, { short: true }), tr('this week')),
				stat(tr('Block time used'), plannedPast ? `${Math.round((trackedInside / plannedPast) * 100)}%` : '–', tr('last 4 weeks')),
				stat(tr('Work left'), remaining ? duration(remaining, { short: true }) : '–', trn('%n open task', '%n open tasks', tasks.length))),
			h('div', { class: 'imp-cpage__row' }, blocksCard, tasksSec),
			h('div', { class: 'imp-cpage__row imp-cpage__row--chart' }, trendSec, h('div', null, forecastSec, keptSec)),
			hoursSec)
		return page
	}

	/** Time page: hours per commitment, for work or university. */
	async function hoursOverview() {
		const now = nowTs()
		const from = Math.min(weekAt(-4).start, monthAt(-1).start)
		const to = Math.max(weekAt(5).start, monthAt(1).start)
		const [sessions, res] = await Promise.all([
			api('GET', `sessions?from=${from}&to=${now + 60}`),
			api('GET', `blocks?from=${from}&to=${to}`),
		])
		const blocks = res.blocks
		const past4 = [-4, -3, -2, -1].map(weekAt)
		const next4 = [1, 2, 3, 4].map(weekAt)
		const perWeek = (list, fn) => list.reduce((a, w) => a + fn(w), 0) / list.length
		const m0 = monthAt(0)
		const list = state.commitments
		const total = { pp: 0, tp: 0, pn: 0, pm: 0, tm: 0, g: 0 }
		const rowsData = list.map((c) => {
			const r = {
				c,
				pp: perWeek(past4, (w) => plannedIn(blocks, c.id, w.start, w.end)),
				tp: perWeek(past4, (w) => trackedIn(sessions, c.id, w.start, w.end)),
				pn: perWeek(next4, (w) => plannedIn(blocks, c.id, w.start, w.end)),
				pm: plannedIn(blocks, c.id, m0.start, m0.end),
				tm: trackedIn(sessions, c.id, m0.start, m0.end),
				g: (c.weeklyGoal || 0) * 60,
			}
			Object.keys(total).forEach((k) => { total[k] += r[k] })
			return r
		})
		const d = (sec) => (sec ? duration(sec, { short: true }) : '–')
		return h('section', { class: 'imp-hours' },
			h('div', { class: 'imp-cpage__titlebar' },
				h('h2', null, tr('Hours per commitment')),
				h('button', {
					class: 'imp-button',
					onclick: () => {
						const weeks = []
						for (let o = -4; o <= 4; o++) weeks.push(weekAt(o))
						downloadCsv('tracker-hours.csv', hoursCsv(list, blocks, sessions, weeks))
					},
				}, tr('Export CSV'))),
			h('div', { class: 'imp-tablewrap' }, h('table', { class: 'imp-table' },
				h('thead', null,
					h('tr', null,
						h('th', { scope: 'col', rowspan: 2 }, tr('Commitment')),
						h('th', { scope: 'colgroup', colspan: 2, class: 'imp-table__group' }, tr('Last 4 weeks, per week')),
						h('th', { scope: 'col', class: 'num', rowspan: 2 }, tr('Next 4 weeks, per week')),
						h('th', { scope: 'colgroup', colspan: 2, class: 'imp-table__group' }, fmt.monthLong.format(m0.date)),
						h('th', { scope: 'col', class: 'num', rowspan: 2 }, tr('Goal / week'))),
					h('tr', null,
						h('th', { scope: 'col', class: 'num' }, tr('In blocks')),
						h('th', { scope: 'col', class: 'num' }, tr('Tracked')),
						h('th', { scope: 'col', class: 'num' }, tr('In blocks')),
						h('th', { scope: 'col', class: 'num' }, tr('Tracked')))),
				h('tbody', null, rowsData.map((r) => h('tr', null,
					h('th', { scope: 'row' }, h('a', { href: `#c/${r.c.id}` }, h('span', { class: 'imp-dot', style: { background: r.c.color } }), r.c.name)),
					h('td', { class: 'num' }, d(r.pp)),
					h('td', { class: 'num strong' }, d(r.tp)),
					h('td', { class: 'num' }, d(r.pn)),
					h('td', { class: 'num' }, d(r.pm)),
					h('td', { class: 'num strong' }, d(r.tm)),
					h('td', { class: 'num imp-muted' }, d(r.g))))),
				h('tfoot', null, h('tr', null,
					h('th', { scope: 'row' }, tr('All')),
					h('td', { class: 'num' }, d(total.pp)), h('td', { class: 'num' }, d(total.tp)), h('td', { class: 'num' }, d(total.pn)),
					h('td', { class: 'num' }, d(total.pm)), h('td', { class: 'num' }, d(total.tm)), h('td', { class: 'num imp-muted' }, d(total.g)))))),
			h('p', { class: 'imp-muted imp-footnote' }, tr('"In blocks" is the time in calendar events of the commitment; "Tracked" is the time you recorded with play. The CSV has one row per week and commitment.')))
	}

	// ---------------------------------------------------------------------------
	// Page: Settings (commitments + Pomodoro)
	// ---------------------------------------------------------------------------

	async function pageSettings() {
		await loadState()
		// No title: the bar already says where you are, and everything fits on one screen
		// Light or dark: right in the title bar
		const theme = await getTheme()
		const look = (mode, label, d) => h('button', {
			type: 'button',
			role: 'radio',
			class: theme === mode ? 'active' : '',
			'aria-checked': theme === mode ? 'true' : 'false',
			title: label,
			onclick: async () => { await setTheme(mode); render() },
		}, icon(d, 16), h('span', null, label))
		const page = h('div', { class: 'imp-page imp-settings' }, pageHeader('settings', tr('Commitments, calendar, timer and reminders'),
			h('div', { class: 'imp-tabs imp-looks', role: 'radiogroup', 'aria-label': tr('Appearance') },
				look('system', tr('Automatic'), 'M4 5h16v11H4zM9 20h6M12 16v4'),
				look('light', tr('Light'), 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'),
				look('dark', tr('Dark'), 'M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z'))))

		// Commitments
		const sec = h('section', { class: 'imp-settings__section' }, h('h2', null, tr('Commitments')),
			h('p', { class: 'imp-muted' }, state.features.builtinCalendar
				? tr('Each commitment has its own calendar in Blockwise for its blocks.')
				: tr('Each commitment is a calendar. Name and color stay in sync with the Calendar app. Blocks of different commitments must not overlap; other calendars are ignored.')))
		const list = h('ul', { class: 'imp-clist' })
		state.commitments.forEach((c) => list.append(commitmentRow(c)))
		sec.append(list, newCommitmentForm())
		// Two columns: commitments and calendar; appearance, timer and reminders
		const left = h('div', { class: 'imp-settings__col' }, sec, backupSection())
		const right = h('div', { class: 'imp-settings__col' })
		page.append(left, right)
		if (desktop && desktop.calendarMode) left.append(await calendarSourceSection())


		// Pomodoro & reminders
		const s = state.settings
		const num = (key, label, min, max) => h('div', { class: 'imp-field imp-field--num' },
			h('span', null, label),
			stepper(key, s[key], { min, max, step: key === 'defaultEstimate' ? 5 : 1, unit: key === 'sessionsBeforeLongBreak' ? '' : tr('min'), label }))
		const pomoToggle = h('input', { type: 'checkbox', id: 'imp-pomo', name: 'pomodoro', checked: s.pomodoro })
		const calToggle = h('input', { type: 'checkbox', id: 'imp-showcal', name: 'showCalendar', checked: s.showCalendar !== false })
		right.append(h('section', { class: 'imp-settings__section' },
			h('h2', null, tr('Pomodoro mode')),
			h('form', {
				class: 'imp-settings__form',
				onsubmit: async (e) => {
					e.preventDefault()
					const data = Object.fromEntries(new FormData(e.target).entries())
					data.pomodoro = pomoToggle.checked
					data.showCalendar = calToggle.checked
					state.settings = await api('PUT', 'settings', data)
					toast(tr('Settings saved'))
					render()
				},
			},
			h('div', { class: 'imp-check' }, pomoToggle, h('label', { for: 'imp-pomo' }, tr('Use Pomodoro mode when tracking'))),
			h('p', { class: 'imp-muted' }, tr('Short breaks count as tracked time. At the long break, tracking stops; press play again after it.')),
			h('div', { class: 'imp-grid' },
				num('focusMinutes', tr('Focus time'), 5, 180),
				num('shortBreakMinutes', tr('Short break'), 1, 60),
				num('longBreakMinutes', tr('Long break'), 1, 120),
				num('sessionsBeforeLongBreak', tr('Sessions before a long break'), 1, 12)),
			h('h2', null, tr('Planning and reminders')),
			h('div', { class: 'imp-grid' },
				num('reminderMinutes', tr('Remind me before a block ends'), 0, 120),
				num('defaultEstimate', tr('Estimate for subtasks without one'), 5, 600)),
			state.features.calendarView ? h('div', { class: 'imp-check imp-settings__toggle' }, calToggle,
				h('label', { for: 'imp-showcal' }, h('strong', null, tr('Show the Calendar page')), h('span', { class: 'imp-muted' }, tr('Off: plan blocks in your calendar app instead. Blocks keep working either way.')))) : null,
			h('button', { class: 'imp-button imp-button--primary', type: 'submit' }, tr('Save settings')))))
		return page
	}

	/** The Mac app: blocks in Blockwise's own calendar, or in Apple Calendar */
	async function calendarSourceSection() {
		const info = await desktop.calendarMode()
		const sec = h('section', { class: 'imp-settings__section imp-calsource' }, h('h2', null, tr('Calendar')))
		if (!info || !info.available) {
			sec.append(h('p', { class: 'imp-muted' }, tr('With Nextcloud, blocks are in your Nextcloud calendars.')))
			return sec
		}
		const option = (mode, title, text) => h('label', { class: `imp-calsource__opt ${info.mode === mode ? 'is-current' : ''}` },
			h('input', { type: 'radio', name: 'calmode', value: mode, checked: info.mode === mode }),
			h('span', null, h('strong', null, title), h('span', { class: 'imp-muted' }, text)))
		const form = h('form', {
			class: 'imp-calsource__form',
			onsubmit: async (e) => {
				e.preventDefault()
				const mode = new FormData(form).get('calmode')
				if (mode === info.mode) return
				const r = await desktop.setCalendarMode(mode)
				if (r && r.changed) {
					toast(r.message || tr('Calendar changed'))
					await refresh()
				}
			},
		},
		option('builtin', tr('Built-in calendar'), tr('Blocks live in Blockwise and sync with your data. No calendar access needed.')),
		option('apple', tr('Apple Calendar'), tr('Blocks are events in Apple Calendar (iCloud, Google, Exchange…). Your built-in blocks are copied there, and each commitment gets a calendar.')),
		h('p', { class: 'imp-muted' }, info.mode === 'apple'
			? tr('Going back copies the events of your commitments\' calendars (from 3 months ago to a year ahead) into the built-in calendar.')
			: tr('Blockwise asks macOS for calendar access when you switch.')),
		h('button', { class: 'imp-button imp-button--primary', type: 'submit' }, tr('Switch calendar')))
		sec.append(form)
		return sec
	}

	const PALETTE = ['#6c5ce7', '#e8590c', '#0fa37f', '#0082c9', '#d4a017', '#c2185b', '#2e9b5f', '#24223a']

	/** Color swatches, the last one opens the system color picker */
	function swatches(value, onPick) {
		const custom = h('input', { type: 'color', value, 'aria-label': tr('Other color'), oninput: (e) => pick(e.target.value) })
		const wrap = h('div', { class: 'imp-swatches', role: 'radiogroup', 'aria-label': tr('Color') })
		const pick = (v) => {
			value = v
			for (const b of wrap.querySelectorAll('button')) b.setAttribute('aria-checked', b.dataset.color === v ? 'true' : 'false')
			wrap.querySelector('.imp-swatches__custom').classList.toggle('is-on', !PALETTE.includes(v))
			onPick(v)
		}
		wrap.append(...PALETTE.map((p) => h('button', { type: 'button', role: 'radio', 'aria-checked': p === value ? 'true' : 'false', 'aria-label': p, 'data-color': p, style: { '--sw': p }, onclick: () => pick(p) })),
			h('label', { class: `imp-swatches__custom ${PALETTE.includes(value) ? '' : 'is-on'}`, title: tr('Other color') }, custom))
		return wrap
	}

	/** − 25 + : a number with buttons (no browser spinners) */
	function stepper(name, value, { min, max, step = 1, unit = '', label, placeholder } = {}) {
		const input = h('input', { type: 'number', name, min, max, step, value: value ?? '', placeholder, inputmode: 'decimal', 'aria-label': label })
		const nudge = (d) => {
			const v = input.value === '' ? (d > 0 ? min : min) : Number(input.value) + d * step
			input.value = String(Math.round(Math.min(max, Math.max(min, v)) * 100) / 100)
			input.dispatchEvent(new Event('input', { bubbles: true }))
		}
		return h('span', { class: 'imp-stepper' },
			h('button', { type: 'button', 'aria-label': tr('Less'), onclick: () => nudge(-1) }, '−'),
			input, unit ? h('span', { class: 'imp-stepper__unit' }, unit) : null,
			h('button', { type: 'button', 'aria-label': tr('More'), onclick: () => nudge(1) }, '+'))
	}

	/** A commitment in Settings: its tile, name and goal; Edit opens the editor in place */
	function commitmentRow(c) {
		if (state.editingCommitment === c.id) return h('li', null, commitmentEditor(c))
		const cal = state.calendars.find((x) => x.id === c.calendarId)
		return h('li', { class: 'imp-clist__item' }, tile(c),
			h('div', { class: 'imp-clist__text' },
				h('strong', null, c.name),
				h('span', { class: 'imp-muted' },
					c.weeklyGoal ? tr('{time} per week', { time: fmtMin(c.weeklyGoal) }) : tr('No weekly goal'),
					!state.features.builtinCalendar ? ` · ${cal ? tr('Calendar "{name}"', { name: cal.name }) : tr('No calendar linked')}` : '')),
			h('button', { type: 'button', class: 'imp-icon-btn imp-clist__edit', 'aria-label': tr('Edit {name}', { name: c.name }), title: tr('Edit'), onclick: () => { state.editingCommitment = c.id; state.creatingCommitment = false; render() } },
				icon('M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4', 18)))
	}

	/** Create or edit a commitment: name, color, weekly goal and (with Nextcloud) its calendar */
	function commitmentEditor(c) {
		const used = state.commitments.map((x) => x.color.toLowerCase())
		let color = c ? c.color : PALETTE.find((p) => !used.includes(p)) || PALETTE[state.commitments.length % PALETTE.length]
		const card = h('form', { class: 'imp-ceditor', style: { '--c': color } })
		const name = h('input', { type: 'text', value: c ? c.name : '', placeholder: tr('e.g. Thesis'), 'aria-label': tr('Name'), maxlength: 255, required: true })
		const preview = h('span', { class: 'imp-tile', 'aria-hidden': 'true' }, (c ? c.name : '').trim().charAt(0).toUpperCase() || '+')
		name.addEventListener('input', () => { preview.textContent = name.value.trim().charAt(0).toUpperCase() || '+' })
		const goal = stepper('goal', c && c.weeklyGoal ? Math.round((c.weeklyGoal / 60) * 10) / 10 : '', { min: 0, max: 168, step: 0.5, unit: tr('h/week'), label: tr('Weekly goal in hours'), placeholder: '–' })
		// With Nextcloud a commitment is a calendar: a new one, or one of yours
		const free = state.calendars.filter((x) => !x.linked || (c && x.id === c.calendarId))
		const calSelect = state.features.builtinCalendar ? null : h('select', { 'aria-label': tr('Calendar'), onchange: () => { if (!c) name.disabled = calSelect.value !== 'new' } },
			c && c.calendarId === null ? h('option', { value: '', selected: true }, tr('No calendar')) : null,
			c ? null : h('option', { value: 'new' }, tr('Create a new calendar')),
			free.map((x) => h('option', { value: x.id, selected: c && x.id === c.calendarId }, c ? x.name : tr('Use calendar "{name}"', { name: x.name }))),
			c ? h('option', { value: 'new' }, tr('New calendar')) : null)
		const close = () => { state.editingCommitment = null; state.creatingCommitment = false; render() }
		card.addEventListener('submit', async (e) => {
			e.preventDefault()
			const hours = goal.querySelector('input').value
			const weeklyGoal = hours ? Math.round(Number(hours) * 60) : null
			if (c) {
				const body = { name: name.value, color, weeklyGoal }
				const sel = calSelect ? calSelect.value : ''
				if (sel === 'new') Object.assign(body, { relink: true, calendarId: null })
				else if (sel && Number(sel) !== c.calendarId) Object.assign(body, { relink: true, calendarId: Number(sel) })
				await api('PUT', `commitments/${c.id}`, body)
				toast(tr('Saved'))
			} else {
				const fromCal = calSelect && calSelect.value !== 'new'
				if (!fromCal && !name.value.trim()) { name.focus(); return }
				const made = await api('POST', 'commitments', fromCal ? { calendarId: Number(calSelect.value) } : { name: name.value, color })
				if (weeklyGoal && made && made.id) await api('PUT', `commitments/${made.id}`, { weeklyGoal })
				toast(tr('Commitment created'))
			}
			state.editingCommitment = null
			state.creatingCommitment = false
			await refresh()
		})
		card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close() } })
		/** Deleting asks in the card: and whether its calendar and events go too */
		const askDelete = (foot) => {
			const builtin = state.features.builtinCalendar
			const how = state.features.deleteCalendar
			const cal = !builtin && how && c.calendarId !== null ? state.calendars.find((x) => x.id === c.calendarId) : null
			const box = h('input', { type: 'checkbox' })
			const hint = h('p', { class: 'imp-ceditor__hint', hidden: true }, how === 'trash'
				? tr('You can restore it from the trash bin in the Calendar app.')
				: tr('This can\'t be undone.'))
			box.addEventListener('change', () => { hint.hidden = !box.checked; go.textContent = box.checked ? tr('Delete both') : tr('Delete') })
			const go = h('button', {
				type: 'button', class: 'imp-button imp-button--danger',
				onclick: async () => {
					go.disabled = true
					try {
						await api('DELETE', `commitments/${c.id}${box.checked ? '?calendar=1' : ''}`)
					} catch (e) {
						go.disabled = false
						toast(e.message, true)
						return
					}
					state.editingCommitment = null
					toast(box.checked ? tr('Commitment and calendar deleted') : tr('Commitment deleted'))
					await refresh()
				},
			}, tr('Delete'))
			const panel = h('div', { class: 'imp-ceditor__confirm', role: 'group', 'aria-label': tr('Delete') },
				h('p', { class: 'imp-ceditor__ask' }, builtin
					? tr('Delete "{name}" with its tasks, notes and blocks?', { name: c.name })
					: tr('Delete "{name}" with its tasks and notes?', { name: c.name })),
				h('p', { class: 'imp-ceditor__hint' }, tr('Tracked time stays, as unplanned time.')),
				cal ? h('label', { class: 'imp-ceditor__check' }, box, h('span', {}, how === 'trash'
					? tr('Also move its calendar "{calendar}" and all its events to the trash bin', { calendar: cal.name })
					: tr('Also delete its calendar "{calendar}" and all its events from Apple Calendar', { calendar: cal.name })))
					: (!builtin && c.calendarId !== null ? h('p', { class: 'imp-ceditor__hint' }, tr('Its calendar and events are kept.')) : null),
				cal ? hint : null,
				h('div', { class: 'imp-ceditor__foot' },
					h('span', { class: 'imp-ceditor__spacer' }),
					h('button', { type: 'button', class: 'imp-button', onclick: () => panel.replaceWith(foot) }, tr('Cancel')),
					go))
			foot.replaceWith(panel)
			;(cal ? box : go).focus()
		}
		card.append(...[
			h('div', { class: 'imp-ceditor__head' }, preview, name),
			h('div', { class: 'imp-ceditor__row' }, h('span', { class: 'imp-ceditor__label' }, tr('Color')), swatches(color, (v) => { color = v; card.style.setProperty('--c', v) })),
			h('div', { class: 'imp-ceditor__row' }, h('span', { class: 'imp-ceditor__label' }, tr('Weekly goal')), goal),
			calSelect ? h('div', { class: 'imp-ceditor__row' }, h('span', { class: 'imp-ceditor__label' }, tr('Calendar')), calSelect) : null,
			h('div', { class: 'imp-ceditor__foot' },
				c ? h('button', { type: 'button', class: 'imp-button imp-button--danger', onclick: (e) => askDelete(e.currentTarget.parentNode) }, tr('Delete')) : null,
				h('span', { class: 'imp-ceditor__spacer' }),
				h('button', { type: 'button', class: 'imp-button', onclick: close }, tr('Cancel')),
				h('button', { type: 'submit', class: 'imp-button imp-button--primary' }, c ? tr('Save') : tr('Create')))].filter(Boolean))
		setTimeout(() => { if (card.isConnected && !c) name.focus() })
		return card
	}

	function newCommitmentForm() {
		if (state.creatingCommitment) return commitmentEditor(null)
		return h('button', { type: 'button', class: 'imp-clist__new', onclick: () => { state.creatingCommitment = true; state.editingCommitment = null; render() } }, '+ ', tr('New commitment'))
	}

	// ---------------------------------------------------------------------------
	// Page: Calendar (built in: the Mac app without Apple Calendar)
	// Day, week and month like Apple Calendar: drag to plan a block, drag it to
	// move it, drag its lower edge to change its length, click it for what to do.
	// ---------------------------------------------------------------------------

	const HOUR_PX = 48
	const SNAP_MIN = 15
	const REPEATS = () => [['', tr('Never')], ['daily', tr('Every day')], ['weekdays', tr('Every weekday')], ['weekly', tr('Every week')], ['biweekly', tr('Every 2 weeks')], ['monthly', tr('Every month')]]
	const repeatLabel = (r) => (REPEATS().find(([k]) => k === (r || '')) || [null, ''])[1]
	const tsOf = (d) => Math.floor(d.getTime() / 1000)
	const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
	const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
	const minutesOf = (ts) => { const d = at(ts); return d.getHours() * 60 + d.getMinutes() }
	const atMinutes = (day, min) => tsOf(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, min))
	const pad2 = (n) => String(n).padStart(2, '0')
	const dateValue = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
	const timeValue = (ts) => { const d = at(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}` }
	const fromInputs = (date, time) => {
		const [y, mo, d] = date.split('-').map(Number)
		const [hh, mm] = time.split(':').map(Number)
		return tsOf(new Date(y, mo - 1, d, hh, mm))
	}
	const calFmt = {
		month: new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }),
		day: new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
		dayShort: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }),
		range: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }),
		weekday: new Intl.DateTimeFormat(locale, { weekday: 'short' }),
		hour: new Intl.DateTimeFormat(locale, { hour: 'numeric' }),
	}
	let calBusy = false // a drag or a panel open: no automatic re-render
	let calTouching = false // a finger on the planner (maybe a swipe): no re-render under it
	/** Repeats follow this device's local time (across DST) */
	const userTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined } catch (e) { return undefined } }

	function calDays() {
		const d = startOfDay(state.calDate)
		if (state.calView === 'day') return [d]
		if (state.calView === '3days') return [d, addDays(d, 1), addDays(d, 2)]
		if (state.calView === 'week') return Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(d), i))
		const first = startOfWeek(startOfMonth(d))
		return Array.from({ length: 42 }, (_, i) => addDays(first, i))
	}
	/** Phone: a sideways swipe on the planner goes to the next or previous days (or month) */
	function calSwipe(el) {
		swipeSides(el, (dir) => { state.calSlide = dir; calMove(dir) }, () => !calBusy)
	}

	/**
	 * Phone: a quick sideways swipe on `el` calls go(+1) (to the left: next) or go(-1).
	 * Not while `free()` says no (a block being moved), nor from a text field.
	 */
	function swipeSides(el, go, free = () => true) {
		let s = null
		el.addEventListener('pointerdown', (e) => {
			const typing = e.target.closest && e.target.closest('input[type=text], textarea, [contenteditable="true"], .imp-ned')
			s = e.pointerType === 'mouse' || !e.isPrimary || typing ? null : { x: e.clientX, y: e.clientY, id: e.pointerId, t: Date.now(), drag: false }
			calTouching = !!s
		}, true)
		el.addEventListener('pointermove', (e) => { if (s && !free()) s.drag = true }, true)
		el.addEventListener('pointerup', (e) => {
			if (!s || s.id !== e.pointerId) return
			calTouching = false
			const dx = e.clientX - s.x
			const dy = e.clientY - s.y
			// Not while a block is held or moved: then the finger carries the block
			const swipe = !s.drag && free() && Math.abs(dx) > 56 && Math.abs(dx) > 2 * Math.abs(dy) && Date.now() - s.t < 900
			s = null
			if (!swipe) return
			e.stopPropagation()
			go(dx < 0 ? 1 : -1)
		}, true)
		el.addEventListener('pointercancel', () => { s = null; calTouching = false }, true)
	}

	function calMove(n) {
		const d = new Date(state.calDate)
		if (state.calView === 'day') d.setDate(d.getDate() + n)
		else if (state.calView === '3days') d.setDate(d.getDate() + 3 * n)
		else if (state.calView === 'week') d.setDate(d.getDate() + 7 * n)
		else { d.setDate(1); d.setMonth(d.getMonth() + n) }
		state.calDate = startOfDay(d)
		render()
	}
	function calSetView(v) {
		state.calView = v
		localStorageSet(PHONE ? 'calViewPhone' : 'calView', v)
		render()
	}

	async function pageCalendar() {
		await loadState()
		const page = h('div', { class: 'imp-page imp-cv' })
		if (!calendarShown()) {
			page.append(h('div', { class: 'imp-empty' }, h('p', null, tr('Your blocks are in your calendar app.')),
				state.features.calendarView ? h('a', { class: 'imp-button', href: '#settings' }, tr('Show the Calendar page')) : null))
			return page
		}
		if (!state.commitments.length) {
			page.append(h('div', { class: 'imp-empty' }, h('p', null, tr('Create a commitment first: each one has its own calendar for its blocks.')), h('a', { class: 'imp-button imp-button--primary', href: '#settings' }, tr('Create a commitment'))))
			return page
		}
		const days = calDays()
		const from = tsOf(days[0])
		const to = tsOf(addDays(days[days.length - 1], 1))
		const { blocks } = await api('GET', `blocks?from=${from}&to=${to}`)
		state.calBlocks = blocks
		page.append(calHeader(days, blocks), state.calView === 'month' ? monthGrid(days, blocks) : timeGrid(days, blocks))
		return page
	}

	function calHeader(days, blocks) {
		const from = tsOf(days[0]), to = tsOf(addDays(days[days.length - 1], 1))
		const planned = blocks.reduce((sum, b) => sum + Math.max(0, Math.min(b.end, to) - Math.max(b.start, from)), 0)
		const d = state.calDate
		const title = state.calView === 'month' ? calFmt.month.format(d)
			: state.calView === 'day' ? calFmt.day.format(d)
				: calFmt.range.formatRange ? calFmt.range.formatRange(days[0], days[6]) : `${calFmt.dayShort.format(days[0])} – ${calFmt.dayShort.format(days[6])} ${days[6].getFullYear()}`
		const seg = (v, label, key) => h('button', { type: 'button', class: state.calView === v ? 'active' : '', 'aria-pressed': state.calView === v ? 'true' : 'false', title: `${label} (${key})`, onclick: () => calSetView(v) }, label)
		return h('header', { class: 'imp-cv__head' },
			h('h1', null, title),
			planned ? h('span', { class: 'imp-cv__planned' }, tr('{hours} planned', { hours: fmtMin(Math.round(planned / 60)) })) : null,
			h('div', { class: 'imp-cv__nav' },
				h('button', { type: 'button', class: 'imp-button imp-cv__arrow', 'aria-label': tr('Previous'), title: tr('Previous (←)'), onclick: () => calMove(-1) }, '‹'),
				h('button', { type: 'button', class: 'imp-button', title: tr('Today (T)'), onclick: () => { state.calDate = startOfDay(new Date()); state.calScroll = null; render() } }, tr('Today')),
				h('button', { type: 'button', class: 'imp-button imp-cv__arrow', 'aria-label': tr('Next'), title: tr('Next (→)'), onclick: () => calMove(1) }, '›')),
			h('div', { class: 'imp-cv__views', role: 'group', 'aria-label': tr('View') }, seg('day', tr('Day'), 'D'), seg('week', tr('Week'), 'W'), seg('month', tr('Month'), 'M')),
			h('button', {
				type: 'button', class: 'imp-button imp-button--primary', title: tr('New block (N)'),
				onclick: (e) => {
					const day = state.calView === 'day' || state.calView === 'month' ? startOfDay(state.calDate) : (days.find((x) => sameDay(x, new Date())) || days[0])
					const now = new Date()
					const startMin = sameDay(day, now) ? Math.ceil((now.getHours() * 60 + now.getMinutes()) / 30) * 30 : 9 * 60
					blockEditor(e.currentTarget, { start: atMinutes(day, startMin), end: atMinutes(day, startMin + 60) })
				},
			}, '+ ', tr('New block')))
	}

	/** Side by side where blocks overlap (each gets a column of its cluster) */
	function layoutDay(list) {
		const sorted = [...list].sort((a, b) => a.top - b.top || b.bottom - a.bottom)
		let cluster = []
		let clusterEnd = -1
		const flush = () => {
			const cols = Math.max(1, ...cluster.map((x) => x.col + 1))
			for (const x of cluster) x.cols = cols
			cluster = []
		}
		for (const x of sorted) {
			if (x.top >= clusterEnd) { flush(); clusterEnd = -1 }
			const used = new Set(cluster.filter((y) => y.bottom > x.top).map((y) => y.col))
			let c = 0
			while (used.has(c)) c++
			x.col = c
			cluster.push(x)
			clusterEnd = Math.max(clusterEnd, x.bottom)
		}
		flush()
		return sorted
	}

	function timeGrid(days, blocks, busy = []) {
		const today = new Date()
		const n = days.length
		const head = h('div', { class: 'imp-cv__dayheads', style: { '--days': n } },
			h('div', { class: 'imp-cv__corner' }),
			days.map((d) => h('button', {
				type: 'button',
				class: `imp-cv__dayhead ${sameDay(d, today) ? 'is-today' : ''}`,
				title: calFmt.day.format(d),
				onclick: () => { state.calDate = d; calSetView('day') },
			}, h('span', { class: 'imp-cv__wd' }, calFmt.weekday.format(d)), h('span', { class: 'imp-cv__dn' }, d.getDate()))))
		const hours = h('div', { class: 'imp-cv__hours', 'aria-hidden': 'true' },
			Array.from({ length: 23 }, (_, i) => h('span', { style: { top: `${(i + 1) * HOUR_PX}px` } }, calFmt.hour.format(new Date(2000, 0, 1, i + 1)))))
		const cols = days.map((d) => {
			const col = h('div', { class: `imp-cv__col ${sameDay(d, today) ? 'is-today' : ''}`, 'data-day': tsOf(d), role: 'group', 'aria-label': calFmt.day.format(d) })
			const dayStart = tsOf(d)
			const dayEnd = tsOf(addDays(d, 1))
			const items = blocks.filter((b) => b.end > dayStart && b.start < dayEnd).map((b) => {
				const top = b.start <= dayStart ? 0 : minutesOf(b.start)
				const bottom = b.end >= dayEnd ? 24 * 60 : Math.max(top + 15, minutesOf(b.end) || 24 * 60)
				return { b, top, bottom, clipStart: b.start < dayStart, clipEnd: b.end > dayEnd }
			})
			// Other calendars: grey, behind the blocks, and not in the way of planning
			const others = busy.filter((b) => b.end > dayStart && b.start < dayEnd).map((b) => {
				const top = b.start <= dayStart ? 0 : minutesOf(b.start)
				return { b, top, bottom: b.end >= dayEnd ? 24 * 60 : Math.max(top + 15, minutesOf(b.end) || 24 * 60) }
			})
			for (const x of layoutDay(others)) col.append(busyEvent(x))
			for (const x of layoutDay(items)) col.append(calEvent(x))
			if (sameDay(d, today)) {
				const m = today.getHours() * 60 + today.getMinutes()
				col.append(h('div', { class: 'imp-cv__now', style: { top: `${(m / 60) * HOUR_PX}px` }, 'aria-hidden': 'true' }))
			}
			return col
		})
		const body = h('div', { class: 'imp-cv__body', style: { '--days': n, height: `${24 * HOUR_PX}px` } }, hours, h('div', { class: 'imp-cv__cols' }, cols))
		const scroll = h('div', { class: 'imp-cv__scroll', onscroll: (e) => { state.calScroll = e.target.scrollTop } }, body)
		// Opens at the current hour (or 7:00), then where you left it
		// (once the grid is on the page: it may be added a few frames later)
		let tries = 60
		const place = () => {
			if (!document.contains(scroll) || !scroll.clientHeight) { if (tries--) requestAnimationFrame(place); return }
			const inView = days.some((d) => sameDay(d, today))
			scroll.scrollTop = state.calScroll ?? Math.max(0, ((inView ? today.getHours() - 1.5 : 7) * HOUR_PX))
		}
		requestAnimationFrame(place)
		calPointer(body)
		return h('div', { class: 'imp-cv__grid' }, head, scroll)
	}

	function busyEvent({ b, top, bottom, col, cols }) {
		return h('div', {
			class: `imp-cv__busy ${bottom - top < 40 ? 'is-short' : ''}`,
			title: `${b.title}, ${blockTime(b)}`,
			style: { top: `${(top / 60) * HOUR_PX}px`, height: `${((bottom - top) / 60) * HOUR_PX - 2}px`, left: `calc(${(col / cols) * 100}% + 1px)`, width: `calc(${100 / cols}% - 3px)` },
		}, h('span', { class: 'imp-cv__busytitle' }, b.title || tr('Busy')))
	}

	/** Your other calendars' events for [from, to) when shown (Settings), else none */
	async function busyTime(from, to) {
		if (!desktop || !desktop.busy || localStorageGet('busyOn', '0') !== '1') return []
		try {
			const off = new Set(JSON.parse(localStorageGet('busyOff', '[]')))
			const cals = (await desktop.otherCalendars(state.commitments.map((c) => c.calendarUrl).filter(Boolean), false)) || []
			const ids = cals.map((c) => c.id).filter((id) => !off.has(id))
			return ids.length ? ((await desktop.busy(from, to, ids)) || []) : []
		} catch (e) { return [] }
	}

	function calEvent({ b, top, bottom, col, cols, clipEnd }) {
		const c = commitmentById(b.commitmentId)
		const color = c ? c.color : '#888'
		const title = b.title || (c ? c.name : '')
		const short = bottom - top < 40
		const el = h('div', {
			class: `imp-cv__ev ${short ? 'is-short' : ''} ${b.end <= nowTs() ? 'is-past' : ''}`,
			role: 'button',
			tabindex: '0',
			'aria-label': `${title}, ${blockTime(b)}${b.repeat ? `, ${repeatLabel(b.repeat)}` : ''}`,
			style: { top: `${(top / 60) * HOUR_PX}px`, height: `${((bottom - top) / 60) * HOUR_PX - 2}px`, left: `calc(${(col / cols) * 100}% + 1px)`, width: `calc(${100 / cols}% - 3px)`, '--c': color, '--on-c': onColor(color) },
			onkeydown: (e) => {
				if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); blockSummary(el, b) }
				if ((e.key === 'Delete' || e.key === 'Backspace') && b.series) { e.preventDefault(); deleteBlock(el, b) }
			},
		},
		// The commitment in bold; below it, the block's title and time
		h('span', { class: 'imp-cv__evtitle' }, c ? c.name : title, b.repeat ? h('span', { class: 'imp-cv__rep', title: repeatLabel(b.repeat), 'aria-hidden': 'true' }, ' ↻') : null),
		short ? null : h('span', { class: 'imp-cv__evtime' }, b.title && c && b.title !== c.name ? `${b.title} · ` : '', `${hourMin.format(at(b.start))}–${hourMin.format(at(b.end))}`),
		clipEnd ? null : h('span', { class: 'imp-cv__resize', 'aria-hidden': 'true' }))
		el.calBlock = b
		return el
	}

	/** Drag on the grid: plan a block; drag a block: move it; drag its lower edge: resize it */
	function calPointer(body) {
		let drag = null
		const snap = (min) => Math.round(min / SNAP_MIN) * SNAP_MIN
		const colAt = (x) => [...body.querySelectorAll('.imp-cv__col')].find((c) => { const r = c.getBoundingClientRect(); return x >= r.left && x < r.right })
		const minAt = (col, y) => Math.max(0, Math.min(24 * 60, ((y - col.getBoundingClientRect().top) / HOUR_PX) * 60))
		const dayOf = (col) => at(Number(col.dataset.day))
		const begin = (target, x, y, pointerId, held) => {
			const ev = target.closest('.imp-cv__ev')
			const col = target.closest('.imp-cv__col')
			if (!col || !document.contains(col)) return false
			if (ev) {
				const b = ev.calBlock
				// Only on the server (its calendar isn't on this phone): it opens, it doesn't move
				if (!b.series) { if (!held) blockSummary(ev, b); return false }
				drag = { kind: target.classList.contains('imp-cv__resize') ? 'resize' : 'move', el: ev, b, x0: x, y0: y, moved: false, col, grab: minAt(col, y) - minutesOf(b.start), dur: (b.end - b.start) / 60 }
				if (held) ev.classList.add('is-dragging')
			} else {
				const m = snap(minAt(col, y) - SNAP_MIN / 2)
				const ghost = h('div', { class: 'imp-cv__ev imp-cv__ghost', style: { top: `${(m / 60) * HOUR_PX}px`, height: `${HOUR_PX - 2}px`, left: '1px', width: 'calc(100% - 3px)' } }, h('span', { class: 'imp-cv__evtime' }, ''))
				drag = { kind: 'create', col, start: m, end: m + 60, ghost, x0: x, y0: y, moved: false }
				if (held) {
					col.append(ghost)
					ghost.firstChild.textContent = `${timeValue(atMinutes(dayOf(col), m))}–${timeValue(atMinutes(dayOf(col), m + 60))}`
				}
			}
			calBusy = true
			try { body.setPointerCapture(pointerId) } catch (err) { /* the finger is gone */ }
			if (held && navigator.vibrate) { try { navigator.vibrate(12) } catch (err) { /* not allowed */ } }
			return true
		}
		// A finger scrolls the grid; holding it still a moment picks up a block or starts planning one
		let hold = null
		const HOLD_MS = 450
		body.addEventListener('pointerdown', (e) => {
			if (e.button !== 0) return
			if (e.pointerType === 'touch') {
				const target = e.target
				const x0 = e.clientX
				const y0 = e.clientY
				hold = { x0, y0, target, timer: setTimeout(() => { hold = null; begin(target, x0, y0, e.pointerId, true) }, HOLD_MS) }
				return
			}
			if (begin(e.target, e.clientX, e.clientY, e.pointerId, false)) e.preventDefault()
		})
		// While a block is held, the finger moves it instead of scrolling
		body.addEventListener('touchmove', (e) => { if (drag) e.preventDefault() }, { passive: false })
		body.addEventListener('contextmenu', (e) => { if (hold || drag) e.preventDefault() })
		body.addEventListener('pointermove', (e) => {
			if (hold && Math.hypot(e.clientX - hold.x0, e.clientY - hold.y0) > 8) { clearTimeout(hold.timer); hold = null }
			if (!drag) return
			if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return
			drag.moved = true
			if (drag.kind === 'create') {
				if (!drag.ghost.isConnected) drag.col.append(drag.ghost)
				const m = snap(minAt(drag.col, e.clientY))
				const a = Math.min(drag.start, m)
				const z = Math.max(drag.start + SNAP_MIN, m)
				drag.from = m < drag.start ? a : drag.start
				drag.to = m < drag.start ? drag.start + SNAP_MIN : z
				Object.assign(drag.ghost.style, { top: `${(drag.from / 60) * HOUR_PX}px`, height: `${((drag.to - drag.from) / 60) * HOUR_PX - 2}px` })
				drag.ghost.firstChild.textContent = `${timeValue(atMinutes(dayOf(drag.col), drag.from))}–${timeValue(atMinutes(dayOf(drag.col), drag.to))}`
				return
			}
			drag.el.classList.add('is-dragging')
			if (drag.kind === 'resize') {
				const top = minutesOf(drag.b.start)
				drag.newEnd = Math.max(top + SNAP_MIN, snap(minAt(drag.col, e.clientY)))
				drag.el.style.height = `${((drag.newEnd - top) / 60) * HOUR_PX - 2}px`
				return
			}
			const col = colAt(e.clientX) || drag.col
			const start = Math.max(0, Math.min(24 * 60 - SNAP_MIN, snap(minAt(col, e.clientY) - drag.grab)))
			if (col !== drag.el.parentNode) col.append(drag.el)
			Object.assign(drag.el.style, { top: `${(start / 60) * HOUR_PX}px`, left: '1px', width: 'calc(100% - 3px)' })
			drag.target = { col, start }
			// Where it will land, on the block itself
			const label = drag.el.querySelector('.imp-cv__evtime')
			if (label) label.textContent = `${calFmt.weekday.format(dayOf(col))} ${timeValue(atMinutes(dayOf(col), start))}–${timeValue(atMinutes(dayOf(col), start + drag.dur))}`
		})
		const end = async (e) => {
			if (hold) {
				// A quick tap: a block opens; an empty hour says how to plan
				clearTimeout(hold.timer)
				const ev = e.type === 'pointerup' ? hold.target.closest('.imp-cv__ev') : null
				hold = null
				if (ev) blockSummary(ev, ev.calBlock)
				else if (e.type === 'pointerup' && !state.calHinted) { state.calHinted = true; toast(tr('Hold an empty hour to plan a block')) }
				return
			}
			if (!drag) return
			const d = drag
			drag = null
			calBusy = false
			if (d.kind === 'create') {
				const day = dayOf(d.col)
				const from = d.moved ? d.from : d.start
				const to = d.moved ? d.to : d.start + 60
				if (!d.ghost.isConnected) d.col.append(d.ghost)
				Object.assign(d.ghost.style, { top: `${(from / 60) * HOUR_PX}px`, height: `${((to - from) / 60) * HOUR_PX - 2}px` })
				blockEditor(d.ghost, { start: atMinutes(day, from), end: atMinutes(day, to) }, () => d.ghost.remove())
				return
			}
			if (!d.moved) { blockSummary(d.el, d.b); return }
			if (e && e.type === 'pointercancel') { render(); return }
			if (d.kind === 'resize') {
				const day = startOfDay(at(d.b.start))
				await changeBlock(d.el, d.b, { start: d.b.start, end: atMinutes(day, d.newEnd) })
			} else if (d.target) {
				const start = atMinutes(dayOf(d.target.col), d.target.start)
				await changeBlock(d.el, d.b, { start, end: start + (d.b.end - d.b.start) })
			}
		}
		body.addEventListener('pointerup', end)
		body.addEventListener('pointercancel', end)
	}

	function monthGrid(days, blocks) {
		const today = new Date()
		const month = state.calDate.getMonth()
		const grid = h('div', { class: 'imp-cv__month' },
			days.slice(0, 7).map((d) => h('div', { class: 'imp-cv__mwd', 'aria-hidden': 'true' }, calFmt.weekday.format(d))))
		for (const d of days) {
			const s = tsOf(d)
			const e = tsOf(addDays(d, 1))
			const list = blocks.filter((b) => b.end > s && b.start < e)
			const MAX = 4
			const cell = h('div', {
				class: `imp-cv__mday ${d.getMonth() !== month ? 'is-other' : ''} ${sameDay(d, today) ? 'is-today' : ''}`,
				ondblclick: (ev) => { if (ev.target === cell || ev.target.classList.contains('imp-cv__mlist')) blockEditor(cell, { start: atMinutes(d, 9 * 60), end: atMinutes(d, 10 * 60) }) },
			},
			h('button', { type: 'button', class: 'imp-cv__mnum', title: calFmt.day.format(d), onclick: () => { state.calDate = d; calSetView('day') } }, d.getDate()),
			h('ul', { class: 'imp-cv__mlist' },
				list.slice(0, list.length > MAX ? MAX - 1 : MAX).map((b) => {
					const c = commitmentById(b.commitmentId)
					const chip = h('button', { type: 'button', class: 'imp-cv__chip', style: { '--c': c ? c.color : '#888' }, onclick: () => blockSummary(chip, b), title: `${b.title || (c && c.name) || ''}, ${blockTime(b)}` },
						h('span', { class: 'imp-dot', style: { background: c ? c.color : '#888' } }),
						h('span', { class: 'imp-cv__chiptime' }, fmt.time.format(at(b.start))),
						h('span', { class: 'imp-cv__chiptitle' }, b.title || (c ? c.name : '')))
					return h('li', null, chip)
				}),
				list.length > MAX ? h('li', null, h('button', { type: 'button', class: 'imp-cv__more', onclick: () => { state.calDate = d; calSetView('day') } }, tr('{n} more', { n: list.length - MAX + 1 }))) : null))
			grid.append(cell)
		}
		return grid
	}

	// --- panels: what to do in a block, plan or change one ---

	let calPanelEl = null
	function closeCalPanel() {
		if (!calPanelEl) return
		const back = calPanelEl.returnFocus
		const done = calPanelEl.onClose
		calPanelEl.remove()
		calPanelEl = null
		calBusy = false
		if (done) done()
		if (back && document.contains(back)) back.focus()
	}
	// The keyboard opened (the page got shorter): the field you're typing in stays in view in the sheet
	if (PHONE) window.addEventListener('resize', () => {
		const f = document.activeElement
		if (calPanelEl && f && calPanelEl.contains(f) && f !== calPanelEl) setTimeout(() => f.scrollIntoView({ block: 'nearest' }), 50)
	})
	function calPanel(anchor, build, { label, onClose } = {}) {
		closeCalPanel()
		closeMenu()
		const el = h('div', { class: `imp-cvpanel ${PHONE ? 'imp-cvpanel--sheet' : ''}`, role: 'dialog', 'aria-label': label || '' })
		el.openedAt = Date.now()
		el.returnFocus = anchor
		el.onClose = onClose
		el.addEventListener('mousedown', (e) => e.stopPropagation())
		el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCalPanel() } })
		// Inside the app (its look and colors), fixed to the window
		document.getElementById('tracker-app').append(el)
		calPanelEl = el
		calBusy = true
		const place = () => {
			if (PHONE || !document.contains(anchor)) return // the phone: a sheet at the bottom
			const r = anchor.getBoundingClientRect()
			const w = el.offsetWidth
			const hgt = el.offsetHeight
			let left = r.right + 10
			if (left + w > window.innerWidth - 8) left = r.left - w - 10
			if (left < 8) left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8)
			const top = Math.min(Math.max(8, r.top), window.innerHeight - hgt - 8)
			el.style.left = `${left}px`
			el.style.top = `${top}px`
		}
		const fill = async () => {
			const focused = el.contains(document.activeElement) && document.activeElement.id ? document.activeElement.id : null
			el.replaceChildren(...[await build(fill)].flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false))
			place()
			if (focused) document.getElementById(focused)?.focus()
		}
		// The phone: no keyboard until you tap a field (it would cover the sheet)
		if (PHONE) el.tabIndex = -1
		// The tap that opened the sheet ends with a click where the sheet now is: not on its buttons
		// (a real tap on the sheet starts with a finger down on it)
		const opened = performance.now()
		let ghost = true
		el.addEventListener('pointerdown', () => { ghost = false }, true)
		el.addEventListener('click', (e) => {
			if (ghost && performance.now() - opened < 600) { e.preventDefault(); e.stopPropagation() }
			ghost = false
		}, true)
		fill().then(() => setTimeout(() => (PHONE ? el.querySelector('[autofocus]') || el : el.querySelector('[autofocus]') || el.querySelector('input, button'))?.focus({ preventScroll: PHONE }), 0))
		return el
	}
	// A tap on the phone sends a mousedown after the touch: not a click outside the panel it just opened
	document.addEventListener('mousedown', () => { if (calPanelEl && Date.now() - calPanelEl.openedAt > 500) closeCalPanel() })
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && calPanelEl) { e.preventDefault(); closeCalPanel() } })

	/** "This block only" or "all future blocks" for a repeating block: 'this' | 'future' | null */
	function askScope(anchor, del) {
		return new Promise((resolve) => {
			let answered = false
			const pick = (v) => { answered = true; closeCalPanel(); resolve(v) }
			calPanel(anchor, () => [
				h('p', { class: 'imp-cvpanel__q' }, del ? tr('Delete this block, or all future ones too?') : tr('Change this block, or all future ones too?')),
				h('p', { class: 'imp-muted' }, tr('It is a repeating block.')),
				h('div', { class: 'imp-cvpanel__actions imp-cvpanel__actions--stack' },
					h('button', { type: 'button', class: 'imp-button imp-button--primary', autofocus: true, onclick: () => pick('this') }, del ? tr('Delete this block only') : tr('This block only')),
					h('button', { type: 'button', class: `imp-button ${del ? 'imp-button--danger' : ''}`, onclick: () => pick('future') }, del ? tr('Delete all future blocks') : tr('All future blocks')),
					h('button', { type: 'button', class: 'imp-button', onclick: () => pick(null) }, tr('Cancel'))),
			], { label: tr('Repeating block'), onClose: () => { if (!answered) resolve(null) } })
		})
	}

	async function changeBlock(anchor, b, changes) {
		let scope = 'all'
		if (b.repeat) {
			scope = await askScope(anchor, false)
			if (!scope) { render(); return false }
		}
		try {
			await api('PUT', `blocks/${b.series}/${b.occurrence}`, { ...changes, scope, tz: userTz() })
		} catch (e) { render(); return false }
		await render()
		return true
	}
	async function deleteBlock(anchor, b) {
		let scope = 'all'
		if (b.repeat) {
			scope = await askScope(anchor, true)
			if (!scope) return
		}
		closeCalPanel()
		await api('DELETE', `blocks/${b.series}/${b.occurrence}?scope=${scope}`)
		toast(tr('Block deleted'))
		await render()
	}

	/** Click on a block: when, and what to do in it (the commitment's tasks planned for it) */
	function blockSummary(anchor, b) {
		const c = commitmentById(b.commitmentId)
		if (!c) return
		calPanel(anchor, async (refill) => {
			const now = nowTs()
			const [tasks, upcoming] = await Promise.all([
				api('GET', `tasks?commitmentId=${c.id}&status=open`),
				api('GET', `blocks?from=${now}&to=${Math.max(now, b.end) + 86400}`).then((r) => r.blocks).catch(() => []),
			])
			const own = upcoming.filter((x) => x.commitmentId === c.id && x.end > now).sort((x, y) => x.start - y.start)
			const plan = planIntoBlocks(tasks, own)
			const slotIndex = own.findIndex((x) => x.uid === b.uid)
			const mine = slotIndex >= 0 ? plan.slots[slotIndex].tasks : []
			const before = slotIndex >= 0 ? plan.slots.slice(0, slotIndex).reduce((n, s) => n + s.tasks.length, 0) : 0
			const past = b.end <= now
			const isNow = b.start <= now && now < b.end
			const tracking = isNow && !!state.running && state.running.commitmentId === c.id
			const toggle = async (t, s, done) => {
				await api('PUT', `subtasks/${s.id}`, { done })
				refill()
			}
			const taskRow = (t) => {
				const single = t.subtasks.length === 1 && t.subtasks[0].title === t.title
				const box = (s, title) => {
					const id = `imp-calsub-${s.id}`
					return h(title ? 'div' : 'li', { class: 'imp-check' },
						h('input', { type: 'checkbox', id, checked: s.done, onchange: (e) => toggle(t, s, e.target.checked) }),
						h('label', { for: id }, s.title),
						s.estimate ? h('span', { class: 'imp-est' }, fmtMin(s.estimate)) : null)
				}
				if (single) return h('li', { class: 'imp-cvpanel__task' }, box(t.subtasks[0], true))
				return h('li', { class: 'imp-cvpanel__task' },
					h('div', { class: 'imp-cvpanel__tname' }, t.title, h('span', { class: 'imp-muted' }, ` ${t.subtasks.filter((x) => x.done).length}/${t.subtasks.length}`)),
					h('ul', { class: 'imp-subtasks' }, t.subtasks.map((s) => box(s, false))))
			}
			const length = b.end - b.start
			const work = mine.reduce((sum, t) => sum + remainingMin(t) * 60, 0)
			const list = past ? [] : slotIndex >= 0 ? mine : tasks
			return [
				h('div', { class: 'imp-cvpanel__head', style: { '--c': c.color } },
					h('h2', null, b.title || c.name),
					h('p', null, h('span', { class: 'imp-dot', style: { background: c.color } }), ' ', c.name),
					h('p', { class: 'imp-muted' }, `${calFmt.day.format(at(b.start))}`, h('br'), `${fmt.time.format(at(b.start))}–${fmt.time.format(at(b.end))} · ${duration(length, { short: true })}`,
						b.repeat ? [h('br'), `↻ ${repeatLabel(b.repeat)}`, b.until ? `, ${tr('until {date}', { date: calFmt.dayShort.format(at(b.until)) })}` : ''] : null)),
				h('div', { class: 'imp-cvpanel__actions' },
					// The block being tracked right now: how long so far and Stop, not "Start now"
					tracking
						? [h('span', { class: 'imp-cvpanel__live', style: { '--c': c.color } }, h('span', { class: 'imp-dot', style: { background: c.color } }), tr('Tracking'), ' ', h('span', { 'data-live': 'elapsed', 'data-ts': state.running.start }, clock(nowTs() - state.running.start))),
							h('button', { type: 'button', class: 'imp-button', onclick: async () => { closeCalPanel(); await stopTracking() } }, icon(ICON_STOP, 14, true), tr('Stop'))]
						: !past ? h('button', { type: 'button', class: 'imp-button imp-button--primary', onclick: async () => { closeCalPanel(); await startTracking(c.id) } }, isNow ? tr('Start now') : tr('Start')) : null,
					b.series ? h('button', { type: 'button', class: 'imp-button', onclick: () => blockEditor(anchor, b) }, tr('Edit')) : null,
					b.series ? h('button', { type: 'button', class: 'imp-button imp-button--danger', onclick: () => deleteBlock(anchor, b) }, tr('Delete')) : null),
				h('h3', { class: 'imp-cvpanel__sub' }, past ? tr('This block is over') : slotIndex >= 0 ? tr('To do in this block') : tr('Open tasks')),
				past ? h('p', { class: 'imp-muted' }, tr('Unfinished tasks stay on top for the next block.'))
					: list.length
						? [h('p', { class: 'imp-muted' }, slotIndex >= 0
							? [tr('{used} of {time}', { used: duration(work, { short: true }), time: duration(plan.slots[slotIndex].seconds, { short: true }) }), before ? ` · ${trn('%n task in earlier blocks', '%n tasks in earlier blocks', before)}` : '']
							: tr('From the top of the queue.')),
						h('ul', { class: 'imp-cvpanel__tasks' }, list.slice(0, 12).map(taskRow)),
						list.length > 12 ? h('p', { class: 'imp-muted' }, tr('{n} more', { n: list.length - 12 })) : null]
						: h('p', { class: 'imp-muted' }, tasks.length ? tr('Earlier blocks take all open tasks.') : tr('No open tasks for {name}.', { name: c.name })),
				h('a', { class: 'imp-cvpanel__link', href: `#c/${c.id}`, onclick: () => closeCalPanel() }, tr('Open {name}', { name: c.name }), ' →'),
			]
		}, { label: b.title || c.name })
	}

	/** Plan a block, or change one (`b` from the calendar) */
	function blockEditor(anchor, b, onClose) {
		const isNew = !b.series
		const lastUsed = Number(localStorageGet('calCommitment', '')) || null
		const cid = b.commitmentId || (commitmentById(lastUsed) ? lastUsed : state.commitments[0].id)
		calPanel(anchor, () => {
			const title = h('input', { type: 'text', value: b.title || '', placeholder: (commitmentById(cid) || {}).name || '', maxlength: '255', 'aria-label': tr('Title'), autofocus: !PHONE })
			const who = h('select', { 'aria-label': tr('Commitment'), onchange: () => { title.placeholder = (commitmentById(Number(who.value)) || {}).name || '' } },
				state.commitments.map((c) => h('option', { value: c.id, selected: c.id === cid }, c.name)))
			const day = h('input', { type: 'date', required: true, value: dateValue(at(b.start)), 'aria-label': tr('Day') })
			const from = h('input', { type: 'time', required: true, step: 300, value: timeValue(b.start), 'aria-label': tr('From') })
			const to = h('input', { type: 'time', required: true, step: 300, value: timeValue(b.end), 'aria-label': tr('Until') })
			const choices = b.repeat === 'custom' ? [...REPEATS(), ['custom', tr('Custom (as set in your calendar)')]] : REPEATS()
			const repeat = h('select', { 'aria-label': tr('Repeat'), onchange: () => { endsRow.hidden = !repeat.value } }, choices.map(([k, label]) => h('option', { value: k, selected: k === (b.repeat || '') }, label)))
			const ends = h('select', { 'aria-label': tr('End repeat'), onchange: () => { untilIn.hidden = ends.value !== 'on' } },
				h('option', { value: 'never', selected: !b.until }, tr('Never')), h('option', { value: 'on', selected: !!b.until }, tr('On date')))
			const untilIn = h('input', { type: 'date', value: b.until ? dateValue(at(b.until)) : dateValue(addDays(at(b.start), 28)), 'aria-label': tr('End repeat on'), hidden: !b.until })
			const endsRow = h('label', { class: 'imp-cvpanel__field', hidden: !b.repeat }, h('span', null, tr('End repeat')), h('span', { class: 'imp-cvpanel__pair' }, ends, untilIn))
			const save = async (e) => {
				e.preventDefault()
				const s = fromInputs(day.value, from.value)
				let en = fromInputs(day.value, to.value)
				if (!Number.isFinite(s) || !Number.isFinite(en)) return
				if (en <= s) en += 86400 // ends after midnight
				const until = repeat.value && ends.value === 'on' && untilIn.value ? fromInputs(untilIn.value, '23:59') : null
				const body = { commitmentId: Number(who.value), title: title.value.trim(), start: s, end: en, repeat: repeat.value, until }
				localStorageSet('calCommitment', who.value)
				if (isNew) {
					try { await api('POST', 'blocks', { ...body, title: body.title || null, tz: userTz() }) } catch (err) { return }
					closeCalPanel()
					toast(tr('Block planned'))
					await render()
					return
				}
				// Only what changed: a rule made in another calendar app stays as it is
				if (body.repeat === (b.repeat || '') && until === (b.until || null)) { delete body.repeat; delete body.until }
				if (body.commitmentId === b.commitmentId) delete body.commitmentId
				closeCalPanel()
				await changeBlock(anchor, b, body)
			}
			return h('form', { class: 'imp-cvpanel__form', onsubmit: save },
				h('h2', null, isNew ? tr('New block') : tr('Edit block')),
				h('label', { class: 'imp-cvpanel__field' }, h('span', null, tr('Title')), title),
				h('label', { class: 'imp-cvpanel__field' }, h('span', null, tr('Commitment')), who),
				h('label', { class: 'imp-cvpanel__field' }, h('span', null, tr('Day')), day),
				h('div', { class: 'imp-cvpanel__field' }, h('span', null, tr('Time')), h('span', { class: 'imp-cvpanel__pair' }, from, h('span', { 'aria-hidden': 'true' }, '–'), to)),
				h('label', { class: 'imp-cvpanel__field' }, h('span', null, tr('Repeat')), repeat),
				endsRow,
				h('div', { class: 'imp-cvpanel__actions' },
					!isNew ? h('button', { type: 'button', class: 'imp-button imp-button--danger', onclick: () => deleteBlock(anchor, b) }, tr('Delete')) : null,
					h('span', { class: 'imp-cvpanel__spacer' }),
					h('button', { type: 'button', class: 'imp-button', onclick: () => closeCalPanel() }, tr('Cancel')),
					h('button', { type: 'submit', class: 'imp-button imp-button--primary' }, isNew ? tr('Add') : tr('Save'))))
		}, { label: isNew ? tr('New block') : tr('Edit block'), onClose })
	}

	// Keys on the calendar: ← → move, T today, D W M views, N new block
	document.addEventListener('keydown', (e) => {
		if (state.route !== 'calendar' || e.metaKey || e.ctrlKey || e.altKey || calPanelEl || menuEl) return
		if (document.activeElement?.matches('input, textarea, select, [contenteditable]')) return
		const k = e.key.toLowerCase()
		if (e.key === 'ArrowLeft') calMove(-1)
		else if (e.key === 'ArrowRight') calMove(1)
		else if (k === 't') { state.calDate = startOfDay(new Date()); state.calScroll = null; render() }
		else if (k === 'd') calSetView('day')
		else if (k === 'w') calSetView('week')
		else if (k === 'm') calSetView('month')
		else if (k === 'n') document.querySelector('.imp-cv__head .imp-button--primary')?.click()
		else return
		e.preventDefault()
	})

	// ---------------------------------------------------------------------------
	// The phone: tabs at the bottom (Now, Tasks, Calendar, Done, Time), a bar on
	// top of each page, the timer first on Now and as a small bar on the other
	// tabs. Notes and a commitment's details are on its own page (tap its name);
	// Settings and the account behind the button at the top right.
	// ---------------------------------------------------------------------------

	const ICON_ME = 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0'
	const ICON_BACK = 'M19 12H5M11 6l-6 6 6 6'
	const routeIcon = (id) => ROUTES.find((x) => x.id === id).icon

	function phoneTabs() {
		const tab = (id, label, d, onclick) => h('li', null, h('a', { href: `#${id}`, class: state.route === id ? 'active' : '', 'aria-current': state.route === id ? 'page' : null, onclick },
			h('span', { class: 'imp-tab__ind' }, icon(d, 22)), h('span', { class: 'imp-tab__label' }, label)))
		return h('nav', { class: 'imp-tabbar', 'aria-label': tr('Main') }, h('ul', null,
			tab('now', tr('Now'), routeIcon('now')),
			tab('tasks', tr('Tasks'), routeIcon('tasks')),
			// The planner, wherever the blocks live (built in, or the phone's calendars)
			calendarShown() ? tab('calendar', tr('Calendar'), ICON_CAL) : null,
			// Done and Time, together: what you got done and how far your goals are
			tab('progress', tr('Progress'), routeIcon('time'))))
	}

	/** A tab's top bar: title, a line under it, actions, and Settings */
	function phoneBar(title, sub, ...actions) {
		return h('header', { class: 'imp-pbar' },
			h('div', { class: 'imp-pbar__text' }, h('h1', null, title), sub ? h('p', null, sub) : null),
			h('div', { class: 'imp-pbar__actions' }, actions,
				h('a', { class: 'imp-pbar__me', href: '#settings', 'aria-label': tr('Settings and account'), title: tr('Settings and account') }, icon(ICON_ME, 22))))
	}

	/** A page opened from a tab (a commitment, Settings): back on the left */
	function phoneBack(title, sub, ...actions) {
		const back = (e) => {
			e.preventDefault()
			if (history.length > 1) history.back()
			else location.hash = '#now'
		}
		return h('header', { class: 'imp-pbar imp-pbar--back' },
			h('a', { class: 'imp-pbar__back', href: '#now', onclick: back, 'aria-label': tr('Back'), title: tr('Back') }, icon(ICON_BACK, 22)),
			h('div', { class: 'imp-pbar__text' }, typeof title === 'string' ? h('h1', null, title) : title, sub ? h('p', null, sub) : null),
			actions.length ? h('div', { class: 'imp-pbar__actions' }, actions) : null)
	}

	/** While tracking, on every tab but Now: what runs, for how long, and Stop */
	function miniTimer() {
		const r = state.running
		if (!r || state.route === 'now') return null
		const color = r.commitmentId === null ? 'var(--tl-accent)' : colorOf(r.commitmentId)
		return h('div', { class: 'imp-mini', style: { '--c': color, '--on-c': r.commitmentId === null ? '#fff' : onColor(color) } },
			h('a', { class: 'imp-mini__text', href: '#now', 'aria-label': tr('{name} is running. Open the timer.', { name: nameOf(r.commitmentId) }) },
				h('span', { class: 'imp-mini__name' }, nameOf(r.commitmentId)),
				h('span', { class: 'imp-mini__clock', 'data-live': 'elapsed', 'data-ts': r.start }, clock(nowTs() - r.start))),
			h('button', { type: 'button', class: 'imp-mini__stop', onclick: () => stopTracking() }, icon(ICON_STOP, 14, true), tr('Stop')))
	}

	/** Commitments as chips to pick one (Tasks) */
	function commitmentChips(current, onPick) {
		const row = hscroll(h('div', { class: 'imp-pchips', role: 'tablist', 'aria-label': tr('Commitments') }, state.commitments.map((x) => h('button', {
			type: 'button',
			role: 'tab',
			class: 'imp-pchip',
			'aria-selected': x.id === current ? 'true' : 'false',
			onclick: () => onPick(x),
		}, h('span', { class: 'imp-dot', style: { background: x.color } }), x.name))))
		// The chosen one in view (after a swipe it may be off to the side)
		requestAnimationFrame(() => {
			const on = row.querySelector('[aria-selected="true"]')
			if (!on || !row.isConnected) return
			const left = on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2
			row.scrollLeft = Math.max(0, left)
		})
		return row
	}

	const noCommitments = () => h('div', { class: 'imp-empty' },
		h('p', null, tr('Create your first commitment, for example Thesis or Work. It gets its own calendar: every event you put there is a work block.')),
		h('a', { class: 'imp-button imp-button--primary', href: '#settings', onclick: () => { state.creatingCommitment = true } }, tr('Create a commitment')))

	/** The dashboard and this week's tracked time per commitment (Now) */
	async function dashboardWithWeek() {
		const weekStart = Math.floor(startOfWeek(new Date()) / 1000)
		const weekEnd = Math.floor(addPeriod(startOfWeek(new Date()), 'week', 1) / 1000)
		const [d, weekSessions] = await Promise.all([
			api('GET', 'dashboard'),
			api('GET', `sessions?from=${weekStart}&to=${weekEnd}`),
		])
		const nowS = nowTs()
		d.week = { start: weekStart, end: weekEnd, tracked: {} }
		for (const x of weekSessions) {
			d.week.tracked[x.commitmentId] = (d.week.tracked[x.commitmentId] || 0) + overlapSeconds(x.start, x.end ?? nowS, weekStart, weekEnd)
		}
		state.dashboard = d
		state.running = d.running
		state.longBreakUntil = d.longBreakUntil
		state.settings = d.settings
		return d
	}

	// --- Now ---------------------------------------------------------------------

	async function phoneNow() {
		const d = await dashboardWithWeek()
		const today = new Date()
		const page = h('div', { class: 'imp-page imp-pnow' })
		const sub = h('p', null, new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' }).format(today))
		const bar = phoneBar(new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(today), null)
		bar.querySelector('.imp-pbar__text').append(sub)
		page.append(bar)
		if (!d.commitments.length) {
			page.append(noCommitments())
			return page
		}
		if (d.overlaps.length) {
			page.append(h('section', { class: 'imp-warning', role: 'alert' },
				h('strong', null, trn('%n overlap between commitments', '%n overlaps between commitments', d.overlaps.length)),
				h('p', { class: 'imp-muted' }, tr('Move one of them in the Calendar app.'))))
		}
		page.append(timerStrip(d))
		page.append(h('section', { class: 'imp-pweek', 'aria-labelledby': 'imp-pweek-h' },
			h('div', { class: 'imp-psec__head' }, h('h2', { id: 'imp-pweek-h' }, tr('This week')), h('span', { class: 'imp-muted' }, tr('Tap a ring to start'))),
			goalRings(d)))
		const todayEl = h('section', { class: 'imp-ptoday', 'aria-labelledby': 'imp-ptoday-h' })
		page.append(todayEl)
		fillToday(todayEl, d, sub)
		page.append(blockCard(d))
		return page
	}

	/** Today's blocks as a list: drawn at once from last time, then from the calendars */
	async function fillToday(el, d, sub) {
		const day = new Date(new Date().setHours(0, 0, 0, 0))
		const from = Math.floor(day / 1000)
		const to = Math.floor(addPeriod(day, 'day', 1) / 1000)
		const cached = state.dayCache && state.dayCache.from === from ? state.dayCache.blocks : null
		drawToday(el, d, from, to, cached, sub)
		let blocks
		try { blocks = (await api('GET', `blocks?from=${from}&to=${to}`)).blocks } catch (e) { blocks = cached || [] }
		blocks = blocks.filter((b) => b.start < to && b.end > from).sort((a, b) => a.start - b.start)
		state.dayCache = { from, blocks }
		drawToday(el, d, from, to, blocks, sub)
	}

	function drawToday(el, d, from, to, blocks, sub) {
		const now = nowTs()
		const waiting = !blocks || (!blocks.length && desktop && desktop.loading && desktop.loading())
		const planned = (blocks || []).reduce((sum, b) => sum + Math.min(b.end, to) - Math.max(b.start, from), 0)
		if (sub) sub.textContent = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' }).format(at(from)) + (planned ? ` · ${tr('{hours} planned', { hours: fmtMin(Math.round(planned / 60)) })}` : '')
		const row = (b) => {
			const c = commitmentById(b.commitmentId) || { id: b.commitmentId, name: nameOf(b.commitmentId), color: colorOf(b.commitmentId) }
			const entry = d.commitments.find((e) => e.commitment.id === c.id)
			const inside = b.start <= now && now < b.end
			const isNext = !inside && entry && entry.nextBlock && entry.nextBlock.start === b.start
			const tasks = entry && (inside || isNext) ? entry.plannedTaskIds.length : 0
			const running = d.running && d.running.commitmentId === c.id
			const range = `${hourMin.format(at(b.start))} – ${hourMin.format(at(b.end))}`
			const extra = inside ? null : tasks ? trn('%n task', '%n tasks', tasks) : null
			return h('li', { class: `imp-prow ${inside ? 'is-now' : ''} ${b.end <= now ? 'is-past' : ''}`, style: { '--c': c.color, '--on-c': onColor(c.color) } },
				tile(c),
				h('a', { class: 'imp-prow__text', href: `#c/${c.id}` },
					h('strong', null, c.name, b.title && b.title !== c.name ? h('span', { class: 'imp-muted' }, ` · ${b.title}`) : null),
					h('span', { class: 'imp-muted' }, range, extra ? ` · ${extra}` : '')),
				inside ? h('span', { class: 'imp-prow__now' }, tr('Now')) : null,
				b.end > now && !running
					? h('button', { type: 'button', class: 'imp-prow__play', onclick: () => startTracking(c.id), 'aria-label': tr('Start tracking {name}', { name: c.name }), title: tr('Start') }, icon(ICON_PLAY, 16, true))
					: null)
		}
		const skRow = () => h('li', { class: 'imp-prow imp-prow--sk', 'aria-hidden': 'true' },
			h('span', { class: 'imp-sk imp-sk--tile' }),
			h('span', { class: 'imp-skrow__text' }, h('span', { class: 'imp-sk', style: { width: '45%', height: '12px' } }), h('span', { class: 'imp-sk', style: { width: '65%', height: '10px' } })))
		el.replaceChildren(
			h('h2', { id: 'imp-ptoday-h' }, tr('Today')),
			waiting
				? h('ol', { class: 'imp-plist', 'aria-busy': 'true', 'aria-label': tr('Loading…') }, skRow(), skRow(), skRow())
				: blocks.length
					? h('ol', { class: 'imp-plist' }, blocks.map(row))
					: h('p', { class: 'imp-muted imp-pempty' }, tr('No blocks planned.'), ' ', calendarShown() ? h('a', { href: '#calendar' }, tr('Plan a block')) : null))
	}

	// --- Tasks ---------------------------------------------------------------------

	async function phoneTasks() {
		const notes = state.tasksView === 'notes'
		const page = h('div', { class: `imp-page imp-ptasks ${notes ? 'imp-ptasks--notes' : ''}` })
		page.append(phoneBar(notes ? tr('Notes') : tr('Tasks'), null))
		if (!state.commitments.length) {
			page.append(noCommitments())
			return page
		}
		if (!commitmentById(state.tasksFor)) state.tasksFor = state.commitments[0].id
		const c = commitmentById(state.tasksFor)
		const now = nowTs()
		const pick = (x) => { state.tasksFor = x.id; state.notesFor = x.id; state.composer = null; render() }
		page.append(commitmentChips(c.id, pick))
		// The same commitment's tasks or notes: one switch, the chips and the swipe stay
		const seg = (v, label) => h('button', {
			type: 'button',
			role: 'tab',
			'aria-selected': (state.tasksView === 'notes') === (v === 'notes') ? 'true' : 'false',
			onclick: () => { state.tasksView = v; render() },
		}, label)
		page.append(h('div', { class: 'imp-pseg', role: 'tablist', 'aria-label': c.name }, seg('tasks', tr('Tasks')), seg('notes', tr('Notes'))))
		let col
		if (notes) {
			const all = await api('GET', `notes?commitmentId=${c.id}`)
			state.notesFor = c.id
			col = h('div', { class: 'imp-notes' }, notesBody(c, all.filter((n) => !n.done), all.filter((n) => n.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))))
		} else {
			const [tasks, blockData] = await Promise.all([
				api('GET', `tasks?commitmentId=${c.id}&status=open`),
				api('GET', `blocks?from=${now - 86400}&to=${now + 14 * 86400}`).catch(() => ({ blocks: [] })),
			])
			col = taskColumn(c, tasks, blockData.blocks, now)
		}
		// Swipe sideways for the next or previous commitment (the chips follow)
		if (state.tasksSlide) { col.classList.add(state.tasksSlide > 0 ? 'imp-pslide--next' : 'imp-pslide--prev'); state.tasksSlide = 0 }
		// (on the whole screen, so an empty commitment can be swiped past too)
		page.swipe = [(dir) => {
			const list = state.commitments
			const i = list.findIndex((x) => x.id === c.id)
			const next = list[(i + dir + list.length) % list.length]
			if (!next || next.id === c.id) return
			state.tasksSlide = dir
			pick(next)
		}, () => !document.querySelector('.imp-menu, .imp-ned')]
		page.append(col)
		return page
	}

	// --- Progress (Done and Time together) ------------------------------------------

	/** Progress: the week's goals, its days (planned and tracked), the chosen day, the last four weeks */
	async function phoneProgress() {
		const ws = addPeriod(startOfWeek(new Date()), 'week', -state.doneWeek)
		const from = Math.floor(ws / 1000)
		const to = Math.floor(addPeriod(ws, 'week', 1) / 1000)
		const weeks = [-3, -2, -1, 0].map(weekAt)
		const now = nowTs()
		const [done, blocks, sessions, recent] = await Promise.all([
			api('GET', `done?from=${from}&to=${to}`),
			api('GET', `blocks?from=${from}&to=${to}`),
			api('GET', `sessions?from=${from}&to=${to}`),
			api('GET', `sessions?from=${weeks[0].start}&to=${now + 60}`),
		])
		const days = Array.from({ length: 7 }, (_, i) => {
			const start = Math.floor(addPeriod(ws, 'day', i) / 1000)
			const end = Math.floor(addPeriod(ws, 'day', i + 1) / 1000)
			const planned = blocks.blocks.reduce((s, b) => s + overlapSeconds(b.start, b.end, start, end), 0)
			const tracked = sessions.reduce((s, x) => s + overlapSeconds(x.start, x.end ?? now, start, end), 0)
			return { i, start, end, planned, tracked, date: at(start) }
		})
		// The day shown: today in this week, else Monday (or the one picked)
		const todayIdx = days.findIndex((x) => x.start <= now && now < x.end)
		if (state.doneDay === undefined || state.doneDay === null || state.doneDayWeek !== state.doneWeek) {
			state.doneDay = todayIdx >= 0 ? todayIdx : 0
			state.doneDayWeek = state.doneWeek
		}
		const day = days[state.doneDay]
		const totalTracked = days.reduce((s, x) => s + x.tracked, 0)
		const totalPlanned = days.reduce((s, x) => s + x.planned, 0)
		const page = h('div', { class: `imp-page imp-pdone imp-pprogress ${state.doneSlide > 0 ? 'imp-pslide--next' : state.doneSlide < 0 ? 'imp-pslide--prev' : ''}` })
		state.doneSlide = 0
		const week = (n) => { state.doneWeek = n; state.doneDay = null; render() }
		// Swipe sideways: the next or previous day (into the next or previous week), never past today
		page.swipe = [(dir) => {
			let w = state.doneWeek
			let i = state.doneDay + dir
			if (i > 6) { if (w === 0) return; w -= 1; i = 0 }
			if (i < 0) { w += 1; i = 6 }
			if (w === 0 && Math.floor(addPeriod(startOfWeek(new Date()), 'day', i) / 1000) > now) return
			Object.assign(state, { doneWeek: w, doneDay: i, doneDayWeek: w, doneSlide: dir })
			render()
		}]
		page.append(phoneBar(tr('Progress'), state.doneWeek === 0 ? tr('This week') : tr('Week of {date}', { date: fmt.day.format(ws) }),
			// Swipe for other days; these for screen readers and keyboards, and This week to come back
			h('button', { type: 'button', class: 'imp-sr', onclick: () => week(state.doneWeek + 1) }, tr('Previous week')),
			state.doneWeek ? h('button', { type: 'button', class: 'imp-sr', onclick: () => week(state.doneWeek - 1) }, tr('Next week')) : null,
			state.doneWeek ? h('button', { type: 'button', class: 'imp-button imp-pcal__today', onclick: () => week(0) }, tr('This week')) : null))

		// Weekly goals in the week shown (this week: what's left, and whether blocks cover it)
		const current = state.doneWeek === 0
		const trackedIn = (id) => sessions.filter((x) => x.commitmentId === id).reduce((sum, x) => sum + overlapSeconds(x.start, x.end ?? now, from, to), 0)
		const plannedLeft = (id) => blocks.blocks.filter((b) => b.commitmentId === id).reduce((sum, b) => sum + overlapSeconds(b.start, b.end, Math.max(now, from), to), 0)
		const withGoal = state.commitments.filter((c) => c.weeklyGoal)
		const without = state.commitments.filter((c) => !c.weeklyGoal)
		const daysLeft = Math.max(0, Math.ceil((to - now) / 86400))
		const goals = h('section', { class: 'imp-pcard', 'aria-labelledby': 'imp-pgoals-h' },
			h('div', { class: 'imp-psec__head' }, h('h2', { id: 'imp-pgoals-h' }, tr('Weekly goals')), current ? h('span', { class: 'imp-muted' }, trn('%n day left', '%n days left', daysLeft)) : null))
		if (withGoal.length) {
			goals.append(h('ul', { class: 'imp-pbars' }, withGoal.map((c) => {
				const sec = trackedIn(c.id)
				const goal = c.weeklyGoal * 60
				const left = Math.max(0, goal - sec)
				const plan = plannedLeft(c.id)
				const note = !left ? tr('Goal reached') : !current ? tr('{left} short', { left: duration(left, { short: true }) }) : plan >= left
					? tr('{left} to go · {planned} planned', { left: duration(left, { short: true }), planned: duration(plan, { short: true }) })
					: tr('{left} to go · {planned} planned: plan more blocks', { left: duration(left, { short: true }), planned: duration(plan, { short: true }) })
				return h('li', { style: { '--c': c.color } },
					h('div', { class: 'imp-pbars__label' },
						h('a', { href: `#c/${c.id}` }, h('span', { class: 'imp-dot', style: { background: c.color } }), c.name),
						h('span', { class: 'imp-muted' }, h('strong', null, duration(sec, { short: true })), ' ', tr('of {goal}', { goal: fmtMin(c.weeklyGoal) }))),
					h('div', { class: 'imp-pbars__track', 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.min(100, Math.round((sec / goal) * 100))}%` } })),
					h('span', { class: `imp-pbars__note ${left && (current ? plan < left : true) ? 'is-short' : ''}` }, note))
			})))
		} else {
			goals.append(h('p', { class: 'imp-muted' }, tr('No weekly goals yet. Set one for a commitment in Settings.')))
		}
		if (without.length) {
			goals.append(h('p', { class: 'imp-muted imp-pnogoal' }, tr('No goal: {list}', { list: without.map((c) => `${c.name} ${duration(trackedIn(c.id), { short: true })}`).join(' · ') })))
		}
		page.append(goals)

		// The week: planned and tracked per day, as pairs of bars on one scale
		const max = Math.max(3600, ...days.map((x) => Math.max(x.planned, x.tracked)))
		const px = (sec) => `${Math.max(sec ? 4 : 0, Math.round((sec / max) * 64))}px`
		const wd = new Intl.DateTimeFormat(locale, { weekday: 'narrow' })
		page.append(h('section', { class: 'imp-pcard imp-pweekbars', 'aria-label': tr('The week') },
			h('div', { class: 'imp-psec__head' },
				h('strong', null, tr('{time} tracked', { time: duration(totalTracked, { short: true }) })),
				h('span', { class: 'imp-muted' }, tr('of {time} planned', { time: duration(totalPlanned, { short: true }) }))),
			h('div', { class: 'imp-pdays', role: 'tablist', 'aria-label': tr('Day') }, days.map((x) => h('button', {
				type: 'button',
				role: 'tab',
				class: `imp-pday ${x.i === todayIdx ? 'is-today' : ''}`,
				'aria-selected': x.i === state.doneDay ? 'true' : 'false',
				'aria-label': `${fmt.day.format(x.date)}: ${tr('{tracked} tracked of {planned} planned', { tracked: duration(x.tracked, { short: true }), planned: duration(x.planned, { short: true }) })}`,
				onclick: () => { state.doneDay = x.i; render() },
			},
			h('span', { class: 'imp-pday__bars', 'aria-hidden': 'true' },
				h('span', { class: 'imp-pday__planned', style: { height: px(x.planned) } }),
				h('span', { class: 'imp-pday__tracked', style: { height: x.start > now ? '0px' : px(x.tracked) } })),
			h('span', { class: 'imp-pday__letter' }, wd.format(x.date)),
			h('span', { class: 'imp-pday__num' }, x.date.getDate())))),
			h('div', { class: 'imp-plegend', 'aria-hidden': 'true' },
				h('span', null, h('span', { class: 'imp-plegend__planned' }), tr('Planned')),
				h('span', null, h('span', { class: 'imp-plegend__tracked' }), tr('Tracked')))))

		// The day: hours per commitment against the plan, then what was checked off
		const ids = [...new Set([...blocks.blocks.map((b) => b.commitmentId), ...sessions.map((x) => x.commitmentId)])]
		const rows = ids.map((id) => ({
			id,
			planned: blocks.blocks.filter((b) => b.commitmentId === id).reduce((s, b) => s + overlapSeconds(b.start, b.end, day.start, day.end), 0),
			tracked: sessions.filter((x) => x.commitmentId === id).reduce((s, x) => s + overlapSeconds(x.start, x.end ?? now, day.start, day.end), 0),
		})).filter((r) => r.planned || r.tracked).sort((a, b) => b.planned + b.tracked - a.planned - a.tracked)
		const addBtn = h('button', { type: 'button', class: 'imp-button', onclick: () => addTimeEditor(addBtn, null) }, '+ ', tr('Add tracked time'))
		page.append(h('section', { class: 'imp-pcard imp-pdayhours', 'aria-labelledby': 'imp-pday-h' },
			h('div', { class: 'imp-psec__head' },
				h('h2', { id: 'imp-pday-h' }, new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'short' }).format(day.date)),
				h('span', { class: 'imp-muted' }, day.planned ? tr('{tracked} of {planned}', { tracked: duration(day.tracked, { short: true }), planned: duration(day.planned, { short: true }) }) : duration(day.tracked, { short: true }))),
			rows.length
				? h('ul', { class: 'imp-pbars' }, rows.map((r) => h('li', { style: { '--c': colorOf(r.id) } },
					h('div', { class: 'imp-pbars__label' },
						h('span', null, h('span', { class: 'imp-dot', style: { background: colorOf(r.id) } }), nameOf(r.id)),
						h('span', { class: 'imp-muted' }, r.planned ? tr('{tracked} of {planned}', { tracked: duration(r.tracked, { short: true }), planned: duration(r.planned, { short: true }) }) : tr('{time} tracked', { time: duration(r.tracked, { short: true }) }))),
					h('div', { class: 'imp-pbars__track', 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.round((r.tracked / Math.max(r.planned, r.tracked, 1)) * 100)}%` } })))))
				: h('p', { class: 'imp-muted' }, day.start > now ? tr('Nothing planned yet.') : tr('Nothing planned or tracked.')),
			addBtn))

		const ticked = done.filter((x) => x.doneAt >= day.start && x.doneAt < day.end)
		page.append(h('section', { class: 'imp-pcard imp-pticked', 'aria-labelledby': 'imp-pticked-h' },
			h('h2', { id: 'imp-pticked-h' }, ticked.length ? tr('Checked off · {n}', { n: ticked.length }) : tr('Checked off')),
			ticked.length
				? h('ul', null, ticked.map((x) => h('li', { style: { '--c': colorOf(x.commitmentId) } },
					h('span', { class: 'imp-pticked__check', 'aria-hidden': 'true' }, icon('M5 12.5l4.5 4.5L19 7.5', 12)),
					h('span', { class: 'imp-pticked__title' }, x.task && x.task !== x.title ? `${x.task}: ${x.title}` : x.title),
					h('span', { class: 'imp-muted' }, hourMin.format(at(x.doneAt))))))
				: h('p', { class: 'imp-muted' }, tr('Nothing checked off this day.'))))

		// The last four weeks, all commitments: tap one to see it
		const totals = weeks.map((w) => recent.reduce((sum, x) => sum + overlapSeconds(x.start, x.end ?? now, w.start, w.end), 0))
		const top = Math.max(3600, ...totals)
		page.append(h('section', { class: 'imp-pcard', 'aria-labelledby': 'imp-pweeks-h' },
			h('div', { class: 'imp-psec__head' }, h('h2', { id: 'imp-pweeks-h' }, tr('Tracked per week')), h('span', { class: 'imp-muted' }, tr('all commitments'))),
			h('ol', { class: 'imp-pweeks' }, weeks.map((w, i) => h('li', { class: 3 - i === state.doneWeek ? 'is-current' : '' },
				h('button', {
					type: 'button',
					class: 'imp-pweeks__btn',
					'aria-pressed': 3 - i === state.doneWeek ? 'true' : 'false',
					'aria-label': `${i === 3 ? tr('This week') : tr('Week of {date}', { date: fmt.day.format(w.date) })}: ${duration(totals[i], { short: true })}`,
					onclick: () => week(3 - i),
				},
				h('span', { class: 'imp-pweeks__val' }, duration(totals[i], { short: true })),
				h('span', { class: 'imp-pweeks__bar', style: { height: `${Math.max(4, Math.round((totals[i] / top) * 110))}px` }, 'aria-hidden': 'true' }),
				h('span', { class: 'imp-muted' }, i === 3 ? tr('This week') : fmt.day.format(w.date))))))))

		// Everything else (charts by month and year, the table, CSV export): folded away
		const more = h('details', { class: 'imp-pmore', ontoggle: async (e) => {
			if (!e.target.open || more.dataset.filled) return
			more.dataset.filled = '1'
			more.append(await pageTime())
		} }, h('summary', null, tr('More: charts, table, CSV export')))
		page.append(more)
		return page
	}

	// --- one commitment: its tasks, notes, and the rest ----------------------------------------

	async function phoneCommitment() {
		const c = commitmentById(state.commitmentId)
		if (!c) {
			location.hash = '#now'
			return h('div')
		}
		const tab = ['tasks', 'notes', 'overview'].includes(state.cTab) ? state.cTab : 'tasks'
		const now = nowTs()
		const wk = weekAt(0)
		const weekSessions = await api('GET', `sessions?from=${wk.start}&to=${now + 60}`)
		const sec = weekSessions.filter((x) => x.commitmentId === c.id).reduce((s, x) => s + overlapSeconds(x.start, x.end ?? now, wk.start, wk.end), 0)
		const running = state.running && state.running.commitmentId === c.id
		const page = h('div', { class: 'imp-page imp-pcommit', style: { '--c': c.color, '--on-c': onColor(c.color) } })
		page.append(phoneBack(h('h1', { class: 'imp-pcommit__name' }, tile(c), h('span', null, c.name)),
			c.weeklyGoal ? tr('Goal {goal} a week · {done} so far', { goal: fmtMin(c.weeklyGoal), done: duration(sec, { short: true }) }) : tr('{time} this week', { time: duration(sec, { short: true }) }),
			h('button', {
				type: 'button',
				class: 'imp-pcommit__play',
				onclick: () => (running ? stopTracking() : startTracking(c.id)),
				'aria-label': running ? tr('Stop tracking {name}', { name: c.name }) : tr('Start tracking {name}', { name: c.name }),
			}, icon(running ? ICON_STOP : ICON_PLAY, 18, true))))
		const tabBtn = (id, label) => h('button', { type: 'button', role: 'tab', 'aria-selected': tab === id ? 'true' : 'false', onclick: () => { state.cTab = id; render() } }, label)
		page.append(h('div', { class: 'imp-ptabs', role: 'tablist', 'aria-label': c.name },
			tabBtn('tasks', tr('Tasks')), tabBtn('notes', tr('Notes')), tabBtn('overview', tr('Overview')),
			h('a', { class: 'imp-ptabs__edit', href: '#settings', onclick: () => { state.editingCommitment = c.id; state.creatingCommitment = false } }, tr('Edit'))))
		if (tab === 'tasks') {
			const [tasks, blockData] = await Promise.all([
				api('GET', `tasks?commitmentId=${c.id}&status=open`),
				api('GET', `blocks?from=${now - 86400}&to=${now + 14 * 86400}`).catch(() => ({ blocks: [] })),
			])
			state.tasksFor = c.id
			page.append(taskColumn(c, tasks, blockData.blocks, now))
		} else if (tab === 'notes') {
			const all = await api('GET', `notes?commitmentId=${c.id}`)
			state.notesFor = c.id
			page.append(h('div', { class: 'imp-notes' }, notesBody(c, all.filter((n) => !n.done), all.filter((n) => n.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)))))
		} else {
			page.append(await pageCommitment())
		}
		return page
	}

	// --- Calendar (blocks in Blockwise): Day, 3 days, Month --------------------------------

	async function phoneCalendar() {
		if (!['day', '3days', 'month'].includes(state.calView)) state.calView = '3days'
		await loadState()
		const page = h('div', { class: 'imp-page imp-cv imp-pcal' })
		if (!calendarShown() || !state.commitments.length) {
			page.append(phoneBar(tr('Calendar'), null))
			page.append(!state.commitments.length ? noCommitments() : h('div', { class: 'imp-empty' }, h('p', null, tr('The calendar is off in Settings.'))))
			return page
		}
		// Another device moved the blocks to the account's calendar: this one needs to allow it too
		const f = state.features || {}
		if (f.calendarHome && f.calendarHome !== 'builtin' && f.calendarKind === 'builtin' && desktop.useAccountCalendar) {
			const name = f.calendarHome === 'google' ? 'Google Calendar' : 'Outlook'
			page.append(phoneBar(tr('Calendar'), null))
			page.append(h('div', { class: 'imp-empty imp-paccal__ask' },
				h('p', null, tr('Your blocks are in {calendar}. Allow it on this device to see and plan them.', { calendar: name })),
				h('button', { type: 'button', class: 'imp-button imp-button--primary', onclick: async (e) => {
					e.currentTarget.disabled = true
					try { await desktop.useAccountCalendar(true); await refresh() } catch (x) { toast(x.message, true); e.currentTarget.disabled = false }
				} }, tr('Allow {calendar}', { calendar: name }))))
			return page
		}
		const days = calDays()
		const from = tsOf(days[0])
		const to = tsOf(addDays(days[days.length - 1], 1))
		const [{ blocks }, busy] = await Promise.all([api('GET', `blocks?from=${from}&to=${to}`), state.calView === 'month' ? [] : busyTime(from, to)])
		state.calBlocks = blocks
		const d = state.calDate
		const short = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' })
		const title = state.calView === 'month' ? calFmt.month.format(d)
			: state.calView === 'day' ? new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'short' }).format(d)
				: short.formatRange ? short.formatRange(days[0], days[2]) : `${short.format(days[0])} – ${short.format(days[2])}`
		const planned = blocks.reduce((sum, b) => sum + Math.max(0, Math.min(b.end, to) - Math.max(b.start, from)), 0)
		const isToday = days.some((x) => sameDay(x, new Date()))
		// Always a second line: the grid mustn't jump when the blocks arrive
		page.append(phoneBar(title, planned ? tr('{hours} planned', { hours: fmtMin(Math.round(planned / 60)) }) : tr('Nothing planned yet.'),
			// Swipe sideways for other days (no arrows; these two only for screen readers and keyboards)
			h('button', { type: 'button', class: 'imp-sr', onclick: () => calMove(-1) }, tr('Previous')),
			h('button', { type: 'button', class: 'imp-sr', onclick: () => calMove(1) }, tr('Next')),
			isToday && state.calView !== 'month' ? null : h('button', { type: 'button', class: 'imp-button imp-pcal__today', onclick: () => { state.calDate = startOfDay(new Date()); state.calScroll = null; render() } }, tr('Today'))))
		const seg = (v, label) => h('button', { type: 'button', role: 'tab', 'aria-selected': state.calView === v ? 'true' : 'false', onclick: () => calSetView(v) }, label)
		page.append(h('div', { class: 'imp-pcal__views', role: 'tablist', 'aria-label': tr('View') }, seg('day', tr('Day')), seg('3days', tr('3 days')), seg('month', tr('Month'))))
		const view = state.calView === 'month' ? monthGrid(days, blocks) : timeGrid(days, blocks, busy)
		// After a swipe, the new days slide in from that side
		if (state.calSlide) { view.classList.add(state.calSlide > 0 ? 'imp-pcal--next' : 'imp-pcal--prev'); state.calSlide = 0 }
		calSwipe(view)
		page.append(view)
		page.append(h('button', {
			type: 'button',
			class: 'imp-pcal__fab',
			onclick: (e) => {
				const day = state.calView === 'month' ? startOfDay(state.calDate) : (days.find((x) => sameDay(x, new Date())) || days[0])
				const now = new Date()
				const startMin = sameDay(day, now) ? Math.ceil((now.getHours() * 60 + now.getMinutes()) / 30) * 30 : 9 * 60
				blockEditor(e.currentTarget, { start: atMinutes(day, startMin), end: atMinutes(day, startMin + 60) })
			},
		}, icon('M12 5v14M5 12h14', 22), tr('Block')))
		return page
	}

	/** Notes (reached from a commitment's page): its notes, other commitments one tap away */
	async function phoneNotes() {
		const c = commitmentById(state.notesFor)
		if (c) state.tasksFor = c.id
		state.tasksView = 'notes'
		location.replace('#tasks')
		return h('div')
	}

	/**
	 * Settings: blocks in the account's calendar (Google Calendar with Google Drive).
	 * Every device follows; the blocks' titles and times are then stored by the
	 * calendar's provider (tasks, notes and tracked time stay end-to-end encrypted).
	 */
	async function accountCalendarSettings() {
		const info = await desktop.accountCalendar().catch(() => null)
		if (!info) return h('div', { hidden: true })
		const name = info.provider === 'google' ? 'Google Calendar' : 'Outlook'
		const on = info.home === info.provider
		const box = h('section', { class: 'imp-card imp-pbusy imp-paccal' })
		const sw = h('input', {
			type: 'checkbox',
			role: 'switch',
			checked: on,
			'aria-describedby': 'imp-paccal-d',
			onchange: async () => {
				const want = sw.checked
				sw.disabled = true
				try {
					if (!want && !confirm(tr('Copy your blocks back into Blockwise? The events stay in {calendar}.', { calendar: name }))) { sw.checked = true; return }
					const r = await desktop.useAccountCalendar(want)
					toast(want ? trn('%n block moved to {calendar}.', '%n blocks moved to {calendar}.', r.copied, { calendar: name }) : trn('%n block copied into Blockwise.', '%n blocks copied into Blockwise.', r.copied))
					state.calBlocks = null
					state.dayCache = null
					await refresh()
				} catch (e) {
					sw.checked = !want
					toast(e.message || tr('Something went wrong.'), true)
				} finally {
					sw.disabled = false
				}
			},
		})
		box.append(h('label', { class: 'imp-pbusy__head' },
			h('span', null, h('strong', null, tr('Blocks in {calendar}', { calendar: name })),
				h('span', { class: 'imp-muted', id: 'imp-paccal-d' }, tr('Each commitment gets its own calendar there; plan here or there, on every device. Their titles and times are then stored by {provider} (tasks, notes and tracked time stay end-to-end encrypted).', { provider: info.provider === 'google' ? 'Google' : 'Microsoft' }))),
			sw))
		if (on && !info.allowed) {
			// Moved by another device: this one needs the permission too
			box.append(h('div', { class: 'imp-paccal__ask' },
				h('p', null, tr('Your blocks are in {calendar}. Allow it on this device to see and plan them.', { calendar: name })),
				h('button', { type: 'button', class: 'imp-button imp-button--primary', onclick: async (e) => {
					e.currentTarget.disabled = true
					try { await desktop.useAccountCalendar(true); await refresh() } catch (x) { toast(x.message, true); e.currentTarget.disabled = false }
				} }, tr('Allow {calendar}', { calendar: name }))))
		}
		if (on && info.waiting) box.append(h('p', { class: 'imp-muted imp-pbusy__none' }, trn('%n change waiting to reach the calendar', '%n changes waiting to reach the calendar', info.waiting)))
		return box
	}

	/** Settings: your other calendars as grey busy time in Calendar (nothing copied, nothing synced) */
	async function busySettings() {
		const on = localStorageGet('busyOn', '0') === '1'
		const box = h('section', { class: 'imp-card imp-pbusy' })
		const sw = h('input', {
			type: 'checkbox',
			role: 'switch',
			checked: on,
			'aria-describedby': 'imp-pbusy-d',
			onchange: async () => {
				if (sw.checked) {
					// The phone asks for calendar access the first time
					const cals = await desktop.otherCalendars([], true).catch(() => null)
					if (!cals) { sw.checked = false; toast(tr('Blockwise may not read your calendar.')); return }
				}
				localStorageSet('busyOn', sw.checked ? '1' : '0')
				render()
			},
		})
		box.append(h('label', { class: 'imp-pbusy__head' },
			h('span', null, h('strong', null, tr('Show my other calendars')),
				h('span', { class: 'imp-muted', id: 'imp-pbusy-d' }, tr('Their events appear as grey busy time in Calendar, so you plan around them. Nothing is copied or synced.'))),
			sw))
		if (on) {
			const cals = (await desktop.otherCalendars(state.commitments.map((c) => c.calendarUrl).filter(Boolean), false).catch(() => [])) || []
			let off = []
			try { off = JSON.parse(localStorageGet('busyOff', '[]')) } catch (e) { off = [] }
			if (!cals.length) box.append(h('p', { class: 'imp-muted imp-pbusy__none' }, tr('No other calendars on this phone.')))
			box.append(h('ul', { class: 'imp-pbusy__list' }, cals.map((c) => h('li', null, h('label', null,
				h('input', {
					type: 'checkbox',
					checked: !off.includes(c.id),
					onchange: (e) => {
						const now = new Set(off)
						if (e.target.checked) now.delete(c.id)
						else now.add(c.id)
						off = [...now]
						localStorageSet('busyOff', JSON.stringify(off))
					},
				}),
				h('span', { class: 'imp-dot', style: { background: c.color } }),
				h('span', { class: 'imp-pbusy__name' }, c.name),
				h('span', { class: 'imp-muted' }, c.account))))))
		}
		return box
	}

	async function phoneSettings() {
		const page = h('div', { class: 'imp-page imp-psettings' })
		page.append(phoneBack(tr('Settings'), null))
		page.append(h('button', { type: 'button', class: 'imp-paccount', onclick: () => desktop.account() },
			icon(ICON_ME, 22),
			h('span', null, h('strong', null, tr('Account and sync')), h('span', { class: 'imp-muted' }, tr('Where your data is, sync, export'))),
			chevron(1)))
		if (desktop.accountCalendar) page.append(await accountCalendarSettings())
		if (desktop.otherCalendars && calendarShown()) page.append(await busySettings())
		page.append(await pageSettings())
		return page
	}

	// ---------------------------------------------------------------------------
	// Boot
	// ---------------------------------------------------------------------------

	const PAGES = PHONE
		? { now: phoneNow, tasks: phoneTasks, notes: phoneNotes, progress: phoneProgress, settings: phoneSettings, commitment: phoneCommitment, calendar: phoneCalendar }
		: { now: pageNow, tasks: pageTasks, notes: pageNotes, done: pageDone, time: pageTime, settings: pageSettings, commitment: pageCommitment, calendar: pageCalendar }

	function routeFromHash() {
		const r = (location.hash || '#now').slice(1)
		// #calendar/20261110: the calendar on that day
		const cd = /^calendar(?:\/(\d{4})(\d{2})(\d{2}))?$/.exec(r)
		if (cd) {
			state.route = 'calendar'
			if (cd[1]) { state.calDate = new Date(Number(cd[1]), Number(cd[2]) - 1, Number(cd[3])); state.calScroll = null }
			return
		}
		const m = /^c\/(\d+)$/.exec(r)
		if (m) {
			state.route = 'commitment'
			state.commitmentId = Number(m[1])
			return
		}
		// The phone's Progress holds what were Done and Time (old links still land there)
		const name = PHONE && (r === 'done' || r === 'time') ? 'progress' : r
		state.route = PAGES[name] && name !== 'commitment' ? name : 'now'
	}

	async function boot() {
		const root = document.getElementById('tracker-app')
		if (!root) return
		routeFromHash()
		// The apps show a splash screen while this loads (no "Loading…" in a corner)
		const splash = document.getElementById('splash')
		const ready = () => {
			if (!splash) return
			splash.classList.add('is-done')
			setTimeout(() => splash.remove(), 400)
		}
		if (!splash) root.replaceChildren(h('div', { class: 'imp-loading' }, tr('Loading…')))
		try {
			await loadState()
		} catch (e) {
			root.replaceChildren(h('p', { class: 'imp-empty' }, tr('Could not load your commitments. Reload to try again.')))
			ready()
			return
		}
		await render()
		ready()
		// (a planner sheet left open doesn't follow to another page)
		window.addEventListener('hashchange', () => { if (calPanelEl) closeCalPanel(); routeFromHash(); state.offset = 0; render() })
		if (desktop && desktop.onChanged) {
			// Not while something is being typed or a form, editor or menu is open (it would be lost):
			// the next page shown reads the new data anyway
			const busy = () => document.activeElement?.matches('input, textarea, select') || !!document.querySelector('#imp-main form, .imp-ned, .imp-menu, .imp-cvpanel')
			desktop.onChanged(() => { if (!busy()) refresh() })
		}
		// Waiting for Nextcloud: a small "Updating" label (only if it takes a moment)
		if (desktop && desktop.onLoading) {
			const label = h('span', { class: 'imp-updating__text' }, tr('Updating from Nextcloud'))
			const spin = h('span', { class: 'imp-updating__spin', 'aria-hidden': 'true' })
			const pill = h('div', { class: 'imp-updating', role: 'status', hidden: true }, spin, label)
			document.body.append(pill)
			let t = null
			let offlineUntil = 0
			desktop.onLoading((on) => {
				if (Date.now() < offlineUntil) return
				clearTimeout(t)
				if (on) t = setTimeout(() => { pill.hidden = false }, 400)
				else pill.hidden = true
			})
			// Nextcloud down or out of reach: everything keeps working here and syncs later
			if (desktop.onOffline) desktop.onOffline(() => {
				clearTimeout(t)
				offlineUntil = Date.now() + 6000
				pill.classList.add('is-offline')
				spin.hidden = true
				label.textContent = tr('Nextcloud is unreachable. Saved on this phone; it syncs when it\'s back.')
				pill.hidden = false
				t = setTimeout(() => {
					pill.hidden = true
					pill.classList.remove('is-offline')
					spin.hidden = false
					label.textContent = tr('Updating from Nextcloud')
				}, 6000)
			})
		}
		setInterval(tick, 1000)
		// Keep blocks and the queue current
		setInterval(() => {
			if ((state.route === 'now' || (state.route === 'calendar' && !calBusy && !calTouching)) && document.visibilityState === 'visible' && !document.activeElement?.matches('input, textarea, select')) render()
		}, 60000)
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible' && state.route === 'now') render()
		})
	}

	/**
	 * Plan a block (apps with the phone's calendar): a timed event in the
	 * commitment's calendar, which syncs to Nextcloud with the calendar.
	 */
	function newBlockForm(c) {
		const wrap = h('section', { class: 'imp-cpage__section imp-newblock' })
		const pad = (n) => String(n).padStart(2, '0')
		const closed = () => wrap.replaceChildren(h('button', { class: 'imp-button', type: 'button', onclick: open }, tr('Plan a block')))
		function open() {
			const start = new Date()
			start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0)
			const end = new Date(start.getTime() + 3600e3)
			const day = h('input', { type: 'date', required: true, value: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`, 'aria-label': tr('Day') })
			const from = h('input', { type: 'time', required: true, value: `${pad(start.getHours())}:${pad(start.getMinutes())}`, 'aria-label': tr('From') })
			const until = h('input', { type: 'time', required: true, value: `${pad(end.getHours())}:${pad(end.getMinutes())}`, 'aria-label': tr('Until') })
			const title = h('input', { type: 'text', placeholder: c.name, maxlength: '255', 'aria-label': tr('Title') })
			const at = (t) => {
				const [y, mo, d] = day.value.split('-').map(Number)
				const [hh, mm] = t.split(':').map(Number)
				return Math.floor(new Date(y, mo - 1, d, hh, mm).getTime() / 1000)
			}
			const save = async (e) => {
				e.preventDefault()
				const s = at(from.value)
				let en = at(until.value)
				if (!Number.isFinite(s) || !Number.isFinite(en)) return
				if (en <= s) en += 86400 // ends after midnight
				try {
					await api('POST', 'blocks', { commitmentId: c.id, start: s, end: en, title: title.value.trim() || null })
				} catch (err) { return }
				toast(tr('Block planned'))
				await render()
			}
			wrap.replaceChildren(
				h('h2', null, tr('Plan a block')),
				h('form', { class: 'imp-newblock__form', onsubmit: save },
					h('label', null, h('span', null, tr('Day')), day),
					h('label', null, h('span', null, tr('From')), from),
					h('label', null, h('span', null, tr('Until')), until),
					h('label', { class: 'imp-newblock__title' }, h('span', null, tr('Title')), title),
					h('div', { class: 'imp-newblock__actions' },
						h('button', { class: 'imp-button', type: 'button', onclick: closed }, tr('Cancel')),
						h('button', { class: 'imp-button imp-button--primary', type: 'submit' }, tr('Save')))))
			day.focus()
		}
		closed()
		return wrap
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
	else boot()
})()
