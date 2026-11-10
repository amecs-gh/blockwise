const assert = require('node:assert/strict')
const { pomodoroPhase, checkAlerts, trayTitle } = require('../src/alerts')

const settings = { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, sessionsBeforeLongBreak: 4, reminderMinutes: 15 }
const T0 = 1_800_000_000
const dash = (over = {}) => ({
	settings,
	longBreakUntil: null,
	commitments: [{ commitment: { id: 1, name: 'Thesis' }, currentBlock: { uid: 'b1', start: T0 - 3600, end: T0 + 3600 } }],
	running: { id: 7, commitmentId: 1, start: T0, pomodoro: false },
	...over,
})

// Pomodoro phases: 25 focus, 5 break, ... 4 rounds, long break at 4*25+3*5 = 115 min
assert.equal(pomodoroPhase(T0, settings, T0 + 60).kind, 'focus')
assert.equal(pomodoroPhase(T0, settings, T0 + 26 * 60).kind, 'short')
assert.deepEqual([pomodoroPhase(T0, settings, T0 + 31 * 60).kind, pomodoroPhase(T0, settings, T0 + 31 * 60).round], ['focus', 2])
assert.equal(pomodoroPhase(T0, settings, T0 + 115 * 60).kind, 'long')
assert.equal(pomodoroPhase(T0, settings, T0).longAt, T0 + 115 * 60)

// Block-end reminder: not at 20 min left, once at 15 min left, not again
let seen = new Set()
assert.equal(checkAlerts(dash(), T0 + 3600 - 20 * 60, seen).notifications.length, 0)
let a = checkAlerts(dash(), T0 + 3600 - 15 * 60, seen)
assert.equal(a.notifications.length, 1)
assert.match(a.notifications[0].title, /Thesis: block ends soon/)
assert.equal(checkAlerts(dash(), T0 + 3600 - 10 * 60, seen).notifications.length, 0)
// No reminder when the setting is 0, or for unplanned time
assert.equal(checkAlerts(dash({ settings: { ...settings, reminderMinutes: 0 } }), T0 + 3500, new Set()).notifications.length, 0)
assert.equal(checkAlerts(dash({ running: { id: 8, commitmentId: null, start: T0, pomodoro: false } }), T0 + 3500, new Set()).notifications.length, 0)

// Pomodoro: short break once, back to focus once, long break stops tracking at longAt
const pd = dash({ running: { id: 9, commitmentId: 1, start: T0, pomodoro: true }, commitments: [{ commitment: { id: 1, name: 'Thesis' }, currentBlock: null }] })
seen = new Set()
assert.equal(checkAlerts(pd, T0 + 26 * 60, seen).notifications[0].title, 'Short break')
assert.equal(checkAlerts(pd, T0 + 27 * 60, seen).notifications.length, 0)
assert.equal(checkAlerts(pd, T0 + 31 * 60, seen).notifications[0].title, 'Back to focus')
a = checkAlerts(pd, T0 + 116 * 60, seen)
assert.equal(a.stopAt, T0 + 115 * 60)
assert.equal(a.notifications[0].title, 'Time for a long break')
assert.equal(checkAlerts(pd, T0 + 117 * 60, seen).stopAt, null)

// Long break over
a = checkAlerts(dash({ running: null, longBreakUntil: T0 }), T0 + 5, new Set())
assert.equal(a.notifications[0].title, 'Break is over')
assert.equal(a.clearLongBreak, true)

// Menu bar text
assert.equal(trayTitle(dash(), T0 + 3725), '1:02:05')
assert.equal(trayTitle(pd, T0 + 60), '24:00')
assert.equal(trayTitle(pd, T0 + 26 * 60), '☕ 04:00')
assert.equal(trayTitle(dash({ running: null }), T0), '')
assert.equal(trayTitle(dash({ running: null, longBreakUntil: T0 + 600 }), T0), '☕ 10:00')
console.log('alerts: all tests passed')
