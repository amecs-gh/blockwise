/* The menu bar panel: timer, the current block's subtasks, quick add, commitments. */
;(function () {
	'use strict'
	const { h, icon, ICONS, duration, clock, onColor, parseEstimate } = window.ui
	const app = window.trackerApp
	let t = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? v[k] : m))
	let state = null
	let busy = false
	let addTo = null // task id selected in quick add
	let fmt = null

	const nowTs = () => Math.floor(Date.now() / 1000) + (state ? state.skew : 0)

	function pomodoroPhase(start, s, now) {
		const F = s.focusMinutes * 60
		const S = s.shortBreakMinutes * 60
		const n = s.sessionsBeforeLongBreak
		const longAt = start + n * F + (n - 1) * S
		const e = now - start
		if (now >= longAt) return { kind: 'long', round: n, of: n, endsAt: longAt }
		const i = Math.floor(e / (F + S))
		const inRound = e - i * (F + S)
		if (inRound < F) return { kind: 'focus', round: i + 1, of: n, endsAt: start + i * (F + S) + F }
		return { kind: 'short', round: i + 1, of: n, endsAt: start + (i + 1) * (F + S) }
	}

	function dayLabel(ts) {
		const d = new Date(ts * 1000)
		const today = new Date(); today.setHours(0, 0, 0, 0)
		const that = new Date(d); that.setHours(0, 0, 0, 0)
		const diff = Math.round((that - today) / 86400000)
		if (diff === 0) return t('Today')
		if (diff === 1) return t('Tomorrow')
		return fmt.day.format(d)
	}
	const blockTime = (b) => `${dayLabel(b.start)}, ${fmt.time.format(new Date(b.start * 1000))}–${fmt.time.format(new Date(b.end * 1000))}`

	async function act(fn) {
		if (busy) return
		busy = true
		document.body.classList.add('is-busy')
		try {
			await fn()
		} catch (e) {
			showError(e.message)
		} finally {
			busy = false
			document.body.classList.remove('is-busy')
		}
	}

	function showError(msg) {
		const el = document.getElementById('err')
		if (!el) return
		el.textContent = msg
		el.hidden = false
		setTimeout(() => { el.hidden = true }, 5000)
	}

	// --- pieces -------------------------------------------------------------------

	function timer(d) {
		const r = d.running
		const now = nowTs()
		if (!r) {
			const lb = d.longBreakUntil && d.longBreakUntil > now
			return h('section', { class: 'p-timer is-idle' },
				h('div', { class: 'p-timer__text' },
					h('span', { class: 'p-timer__label' }, lb ? t('Long break') : t('Not tracking')),
					lb ? h('span', { class: 'p-timer__clock', 'data-left': d.longBreakUntil }, clock(d.longBreakUntil - now)) : null),
				h('button', { class: 'p-btn', onclick: () => act(() => app.api('POST', 'sessions/start', { commitmentId: null })) }, icon(ICONS.play, 12, true), t('Track unplanned time')))
		}
		const entry = d.commitments.find((e) => e.commitment.id === r.commitmentId)
		const c = entry ? entry.commitment : null
		const color = c ? c.color : '#6b6b6b'
		const block = entry && entry.currentBlock && entry.currentBlock.start <= now && now < entry.currentBlock.end ? entry.currentBlock : null
		const el = h('section', { class: 'p-timer', style: { '--c': color, '--on-c': onColor(color) } },
			h('div', { class: 'p-timer__text' },
				h('span', { class: 'p-timer__label' }, c ? c.name : t('Unplanned')),
				h('span', { class: 'p-timer__clock', 'data-elapsed': r.start }, clock(now - r.start)),
				block ? h('span', { class: 'p-timer__sub' }, t('{time} left in this block', { time: duration(block.end - now) })) : null),
			h('button', { class: 'p-stop', onclick: () => act(() => app.api('POST', 'sessions/stop', {})), 'aria-label': c ? t('Stop {name}', { name: c.name }) : t('Stop') }, icon(ICONS.stop, 12, true), t('Stop')))
		if (r.pomodoro) {
			const p = pomodoroPhase(r.start, d.settings, now)
			const label = p.kind === 'focus' ? t('Focus') : p.kind === 'short' ? t('Short break') : t('Long break')
			const left = clock(p.endsAt - now)
			const until = p.kind === 'focus' ? (p.round < p.of ? t('{time} until the short break', { time: left }) : t('{time} until the long break', { time: left })) : t('{time} until focus', { time: left })
			el.append(h('div', { class: 'p-pomo', 'data-phase': `${p.kind}-${p.round}` },
				h('span', null, `${label} · ${t('Round {round} of {of}', { round: p.round, of: p.of })}`),
				h('span', { 'data-pomo': '' }, until)))
		}
		return el
	}

	/** The commitment to show subtasks for: running one, else the one with a block now, else the next. */
	function focusEntry(d) {
		const now = nowTs()
		if (d.running && d.running.commitmentId !== null) {
			const e = d.commitments.find((x) => x.commitment.id === d.running.commitmentId)
			if (e) return e
		}
		const current = d.commitments.find((e) => e.currentBlock && e.currentBlock.start <= now && now < e.currentBlock.end)
		if (current) return current
		const withNext = d.commitments.filter((e) => e.nextBlock).sort((a, b) => a.nextBlock.start - b.nextBlock.start)
		return withNext[0] || null
	}

	function blockSection(entry, d) {
		const c = entry.commitment
		const now = nowTs()
		const inBlock = entry.currentBlock && entry.currentBlock.start <= now && now < entry.currentBlock.end
		const block = inBlock ? entry.currentBlock : entry.nextBlock
		const planned = entry.queue.filter((x) => entry.plannedTaskIds.includes(x.id))
		const sec = h('section', { class: 'p-block', style: { '--c': c.color } },
			h('div', { class: 'p-block__head' },
				h('span', { class: 'p-dot' }),
				h('strong', null, c.name),
				h('span', { class: 'p-muted' }, inBlock ? t('In this block') : block ? t('Next block') : t('Up next'))),
			block ? h('div', { class: 'p-muted p-block__time' }, blockTime(block), block.title ? ` · ${block.title}` : '') : null)
		if (!planned.length) {
			sec.append(h('p', { class: 'p-muted p-empty' }, t('No open tasks.')))
			return sec
		}
		// Keep the panel short: the first three tasks, the rest in Blockwise
		planned.slice(0, 3).forEach((task) => sec.append(taskItem(task)))
		if (planned.length > 3) {
			sec.append(h('button', { class: 'p-more', onclick: () => app.open('tracker') }, t('{n} more in Blockwise', { n: planned.length - 3 })))
		}
		sec.append(quickAdd(planned))
		return sec
	}

	function taskItem(task) {
		const single = task.subtasks.length === 1 && task.subtasks[0].title === task.title
		const est = (s) => (s.estimate ? h('span', { class: 'p-est' }, duration(s.estimate * 60)) : null)
		const box = (s, cls) => h('label', { class: `p-check ${cls || ''}` },
			h('input', {
				type: 'checkbox',
				checked: s.done,
				onchange: (e) => act(async () => {
					const updated = await app.api('PUT', `subtasks/${s.id}`, { done: e.target.checked })
					if (updated.done && !task.done) flash(t('Done: {title}', { title: task.title }))
				}),
			}),
			h('span', { class: 'p-check__label' }, s.title),
			est(s))
		if (single) return h('div', { class: 'p-task' }, box(task.subtasks[0], 'is-title'))
		const done = task.subtasks.filter((s) => s.done).length
		return h('div', { class: 'p-task' },
			h('div', { class: 'p-task__head' }, h('span', null, task.title), h('span', { class: 'p-muted' }, `${done}/${task.subtasks.length}`)),
			task.subtasks.map((s) => box(s)))
	}

	function quickAdd(planned) {
		if (!planned.some((x) => x.id === addTo)) addTo = planned[0].id
		const input = h('input', {
			type: 'text',
			class: 'p-add__input',
			maxlength: 255,
			placeholder: t('Add a subtask, e.g. "Check figures 20m"'),
			'aria-label': t('Add a subtask, e.g. "Check figures 20m"'),
			onkeydown: (e) => {
				if (e.key !== 'Enter' || !input.value.trim()) return
				e.preventDefault()
				const { title, estimate } = parseEstimate(input.value)
				act(async () => {
					await app.api('POST', `tasks/${addTo}/subtasks`, { title, estimate })
					input.value = ''
					setTimeout(() => document.querySelector('.p-add__input')?.focus(), 50)
				})
			},
		})
		const select = planned.length > 1
			? h('select', { class: 'p-add__select', 'aria-label': t('Add to'), onchange: (e) => { addTo = Number(e.target.value) } },
				planned.map((x) => h('option', { value: x.id, selected: x.id === addTo }, x.title)))
			: null
		return h('div', { class: 'p-add' }, input, select)
	}

	function commitmentRow(entry, d) {
		const c = entry.commitment
		const now = nowTs()
		const running = d.running && d.running.commitmentId === c.id
		const block = entry.currentBlock && entry.currentBlock.end > now ? entry.currentBlock : entry.nextBlock
		const tracked = (d.weekTracked && d.weekTracked[c.id]) || 0
		return h('li', { class: 'p-row', style: { '--c': c.color, '--on-c': onColor(c.color) } },
			h('span', { class: 'p-row__bar' }),
			h('div', { class: 'p-row__text' },
				h('strong', null, c.name),
				h('span', { class: 'p-muted' }, block ? blockTime(block) : t('No block planned')),
				c.weeklyGoal ? h('span', { class: 'p-goal' },
					h('span', { class: 'p-goal__bar' }, h('span', { style: { width: `${Math.min(100, (tracked / 60 / c.weeklyGoal) * 100)}%` } })),
					h('span', { class: 'p-muted' }, t('{done} of {goal} this week', { done: duration(tracked), goal: duration(c.weeklyGoal * 60) }))) : null),
			h('button', {
				class: `p-play ${running ? 'is-running' : ''}`,
				'aria-label': running ? t('Stop {name}', { name: c.name }) : t('Start {name}', { name: c.name }),
				title: running ? t('Stop') : t('Start {name}', { name: c.name }),
				onclick: () => act(() => (running ? app.api('POST', 'sessions/stop', {}) : app.api('POST', 'sessions/start', { commitmentId: c.id }))),
			}, icon(running ? ICONS.stop : ICONS.play, 13, true)))
	}

	function footer() {
		return h('footer', { class: 'p-footer' },
			h('button', { class: 'p-link', onclick: () => app.open('tracker') }, icon(ICONS.tracker, 14), t('Open Blockwise')),
			h('button', { class: 'p-link', onclick: () => app.open('calendar') }, icon(ICONS.calendar, 14), t('Open Calendar')),
			h('button', { class: 'p-icon', 'aria-label': 'Menu', title: state && state.host ? t('Logged in as {user} on {host}', { user: state.loginName, host: state.host }) : '', onclick: () => app.menu() }, icon(ICONS.more, 16)))
	}

	let flashTimer = null
	function flash(msg) {
		const el = document.getElementById('flash')
		if (!el) return
		el.textContent = msg
		el.hidden = false
		clearTimeout(flashTimer)
		flashTimer = setTimeout(() => { el.hidden = true }, 2500)
	}

	// --- render -------------------------------------------------------------------

	function render() {
		const root = document.getElementById('root')
		const d = state && state.dash
		const keepFocus = document.activeElement && document.activeElement.classList.contains('p-add__input') ? document.activeElement.value : null
		const kids = []
		if (!d) {
			kids.push(h('div', { class: 'p-loading' },
				state && state.error ? [h('p', null, state.error), h('button', { class: 'p-btn', onclick: () => app.refresh() }, t('Retry'))] : t('Loading…')))
		} else {
			kids.push(timer(d))
			if (state.error) kids.push(h('p', { class: 'p-error' }, state.error))
			const f = focusEntry(d)
			if (f) kids.push(blockSection(f, d))
			const others = d.commitments.filter((e) => e !== f)
			if (others.length) {
				kids.push(h('section', { class: 'p-list' },
					h('h2', null, t('Commitments')),
					h('ul', null, others.map((e) => commitmentRow(e, d)))))
			}
		}
		kids.push(h('p', { id: 'err', class: 'p-error', hidden: true, role: 'alert' }))
		kids.push(h('p', { id: 'flash', class: 'p-flash', hidden: true, role: 'status' }))
		kids.push(footer())
		root.replaceChildren(...kids)
		if (keepFocus !== null) {
			const i = document.querySelector('.p-add__input')
			if (i) { i.value = keepFocus; i.focus() }
		}
		app.setHeight(document.documentElement.scrollHeight)
	}

	function tick() {
		const now = nowTs()
		document.querySelectorAll('[data-elapsed]').forEach((el) => { el.textContent = clock(now - Number(el.dataset.elapsed)) })
		document.querySelectorAll('[data-left]').forEach((el) => { el.textContent = clock(Number(el.dataset.left) - now) })
		const d = state && state.dash
		if (d && d.running && d.running.pomodoro) {
			const p = pomodoroPhase(d.running.start, d.settings, now)
			const el = document.querySelector('.p-pomo')
			if (el && el.dataset.phase !== `${p.kind}-${p.round}`) render()
			else if (el) {
				const left = clock(p.endsAt - now)
				el.querySelector('[data-pomo]').textContent = p.kind === 'focus' ? (p.round < p.of ? t('{time} until the short break', { time: left }) : t('{time} until the long break', { time: left })) : t('{time} until focus', { time: left })
			}
		}
	}

	function setState(s) {
		s.skew = s.now - Math.floor(Date.now() / 1000)
		const first = !state
		state = s
		if (first) {
			t = window.trackerI18n.make(s.locale)
			fmt = {
				time: new Intl.DateTimeFormat(s.locale, { hour: '2-digit', minute: '2-digit' }),
				day: new Intl.DateTimeFormat(s.locale, { weekday: 'short', day: 'numeric', month: 'short' }),
			}
			document.documentElement.lang = s.locale
		}
		render()
	}

	app.onState(setState)
	app.getState().then(setState).catch((e) => showError(e.message))
	setInterval(tick, 1000)
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close() })
})()
