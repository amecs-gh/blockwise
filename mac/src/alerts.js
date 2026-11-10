'use strict'
/**
 * Which notifications to show, and when to stop tracking for a Pomodoro long
 * break. Pure functions (no Electron), tested in plain Node.
 */

/** Same phases as the web page: n focus periods with short breaks, then the long break. */
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

/** The block of the running commitment that contains `now`, if any. */
function runningBlock(dash, now) {
	if (!dash || !dash.running || dash.running.commitmentId === null) return null
	const entry = dash.commitments.find((e) => e.commitment.id === dash.running.commitmentId)
	const b = entry && entry.currentBlock
	return b && b.start <= now && now < b.end ? b : null
}

/**
 * @param {object} dash last /api/dashboard response (running, settings, longBreakUntil, commitments)
 * @param {number} now unix seconds
 * @param {Set<string>} seen keys of alerts already shown (mutated)
 * @returns {{ notifications: {key, title, body}[], stopAt: number|null, clearLongBreak: boolean }}
 */
function checkAlerts(dash, now, seen, t = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? v[k] : m))) {
	const out = { notifications: [], stopAt: null, clearLongBreak: false }
	if (!dash) return out
	const s = dash.settings
	const once = (key, title, body) => {
		if (seen.has(key)) return
		seen.add(key)
		out.notifications.push({ key, title, body })
	}
	const r = dash.running
	if (r) {
		const name = r.commitmentId === null ? t('Unplanned') : ((dash.commitments.find((e) => e.commitment.id === r.commitmentId) || {}).commitment || {}).name || ''
		const block = runningBlock(dash, now)
		const reminder = (s.reminderMinutes || 0) * 60
		if (block && reminder > 0 && block.end - now <= reminder) {
			once(`end-${block.uid}`, t('{name}: block ends soon', { name }), t('{minutes} min left. Unchecked subtasks move to the next block.', { minutes: Math.ceil((block.end - now) / 60) }))
		}
		if (r.pomodoro) {
			const p = pomodoroPhase(r.start, s, now)
			const key = `pomo-${r.id}-${p.kind}-${p.round}`
			if (p.kind === 'short') once(key, t('Short break'), t('Step away for {minutes} min. The timer keeps running.', { minutes: s.shortBreakMinutes }))
			else if (p.kind === 'focus' && p.round > 1) once(key, t('Back to focus'), t('Round {round} of {of}', { round: p.round, of: p.of }))
			else if (p.kind === 'long' && !seen.has(key)) {
				once(key, t('Time for a long break'), t('Tracking stopped. Back to work in {minutes} min.', { minutes: s.longBreakMinutes }))
				out.stopAt = p.longAt
			}
		}
	} else if (dash.longBreakUntil && now >= dash.longBreakUntil) {
		once(`lb-${dash.longBreakUntil}`, t('Break is over'), t('Press play to start the next focus session.'))
		out.clearLongBreak = true
	}
	return out
}

/** Text next to the menu bar icon. */
function trayTitle(dash, now) {
	if (!dash) return ''
	const r = dash.running
	const clock = (sec, withHours) => {
		sec = Math.max(0, Math.round(sec))
		const h = Math.floor(sec / 3600)
		const m = Math.floor((sec % 3600) / 60)
		const ss = String(sec % 60).padStart(2, '0')
		return h || withHours ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`
	}
	if (r) {
		if (r.pomodoro) {
			const p = pomodoroPhase(r.start, dash.settings, now)
			return `${p.kind === 'focus' ? '' : '☕ '}${clock(p.endsAt - now)}`
		}
		return clock(now - r.start, true)
	}
	if (dash.longBreakUntil && dash.longBreakUntil > now) return `☕ ${clock(dash.longBreakUntil - now)}`
	return ''
}

module.exports = { pomodoroPhase, runningBlock, checkAlerts, trayTitle }
