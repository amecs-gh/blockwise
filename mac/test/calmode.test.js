// The real src/main.js on "This Mac only": the built-in calendar, then
// Settings → Calendar → Apple Calendar (blocks copied there, repeats included,
// a calendar per commitment), then back (events copied in, nothing doubled).
// Apple Calendar is a stand-in for the EventKit helper. node test/calmode.test.js
process.env.TZ = 'Europe/Zurich'
const Module = require('node:module')
const path = require('node:path')
const fs = require('node:fs')
const childProcess = require('node:child_process')
const assert = require('node:assert/strict')

Object.defineProperty(process, 'platform', { value: 'darwin' })
const mock = require('./mock-electron')
const origLoad = Module._load
Module._load = function (request, ...rest) { return request === 'electron' ? mock : origLoad.call(this, request, ...rest) }
const T = mock.__test
const ok = (n) => console.log('  ✔', n)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const page = (name) => ({ senderFrame: { url: 'file://' + path.join(__dirname, '..', 'renderer', name) } })
const call = async (channel, from, ...args) => {
	const r = await T.handlers[channel](page(from), ...args)
	if (r.error) throw Object.assign(new Error(r.error), { status: r.status })
	return r.data
}
const at = (d, h, m = 0) => Math.floor(new Date(2026, 10, d, h, m).getTime() / 1000)

// --- a stand-in Apple Calendar (what the EventKit helper answers) ---
const apple = { granted: true, cals: [{ id: 'HOME', title: 'Home', color: '#ff0000', writable: true }], events: [], calls: [] }
let nextId = 1
const step = { daily: 1, weekly: 7, biweekly: 14 }
function expand(e, from, to) {
	const out = []
	const dur = e.end - e.start
	for (let k = 0; k < 800; k++) {
		const d = new Date(e.start * 1000)
		if (!e.repeat) { if (k) break } else if (e.repeat === 'monthly') d.setMonth(d.getMonth() + k)
		else if (e.repeat === 'weekdays') d.setDate(d.getDate() + k)
		else d.setDate(d.getDate() + k * step[e.repeat])
		const st = Math.floor(d / 1000)
		if (st >= to || (e.until && st > e.until)) break
		if (e.repeat === 'weekdays' && (d.getDay() === 0 || d.getDay() === 6)) continue
		if ((e.skip || []).includes(st) || st + dur <= from) continue
		out.push({ uid: e.uid, title: e.title, start: st, end: st + dur, allDay: false, calendar: e.calendar })
	}
	return out
}
function helper(cmd, input) {
	apple.calls.push(cmd)
	if (cmd === 'access') return { ok: true, data: { granted: apple.granted } }
	if (!apple.granted) return { ok: false, error: 'denied' }
	if (cmd === 'calendars') return { ok: true, data: apple.cals.map((c) => ({ ...c, source: 'iCloud' })) }
	if (cmd === 'createCalendar') { const id = 'CAL' + nextId++; apple.cals.push({ id, title: input.title, color: input.color, writable: true }); return { ok: true, data: { id } } }
	if (cmd === 'createEvent') {
		if (!apple.cals.some((c) => c.id === input.calendar)) return { ok: false, error: 'invalid' }
		const uid = 'EV' + nextId++
		apple.events.push({ uid, calendar: input.calendar, title: input.title, start: input.start, end: input.end, repeat: input.repeat || '', until: input.until || null, skip: input.skip || [] })
		return { ok: true, data: { uid } }
	}
	if (cmd === 'deleteEvent') {
		const e = apple.events.find((x) => x.uid === input.uid && x.calendar === input.calendar)
		if (!e) return { ok: true, data: { deleted: 0 } }
		if (input.start) { if (!e.repeat) apple.events.splice(apple.events.indexOf(e), 1); else e.skip = [...(e.skip || []), input.start] } else apple.events.splice(apple.events.indexOf(e), 1)
		return { ok: true, data: { deleted: 1 } }
	}
	if (cmd === 'events') return { ok: true, data: apple.events.filter((e) => input.calendars.includes(e.calendar)).flatMap((e) => expand(e, input.from, input.to)) }
	return { ok: false, error: 'invalid' }
}
const HELPER = path.join(__dirname, '..', 'helper', 'build', 'blockwise-calendar')
const realExists = fs.existsSync
fs.existsSync = (p) => (p === HELPER ? true : realExists(p))
childProcess.execFile = (file, args, opts, cb) => {
	if (file !== HELPER) return cb(new Error('not run in tests'))
	let input = ''
	const child = { stdin: { end: (d) => { input = d; setImmediate(() => cb(null, JSON.stringify(helper(args[0], input ? JSON.parse(input) : {})))) } } }
	return child
}

;(async () => {
	require('../src/main.js')
	T.ready()
	await sleep(300)
	await call('useThisMac', 'setup.html')
	await sleep(200)
	assert.deepEqual(await call('calendarMode', 'app.html'), { mode: 'builtin', available: true })
	let st = await call('api', 'app.html', 'GET', 'state')
	assert.equal(st.features.builtinCalendar, true)
	assert.ok(!apple.calls.includes('access'), 'macOS not asked: the built-in calendar needs no access')
	ok('built-in calendar by default, no calendar access asked')

	const a = await call('api', 'app.html', 'POST', 'commitments', { name: 'Thesis', color: '#3b6fd8' })
	const b = await call('api', 'app.html', 'POST', 'commitments', { name: 'Teaching', color: '#d8643b' })
	assert.ok(!apple.calls.includes('createCalendar'))
	await call('api', 'app.html', 'POST', 'blocks', { commitmentId: a.id, start: at(9, 9), end: at(9, 12), repeat: 'weekdays', until: at(20, 9) })
	await call('api', 'app.html', 'POST', 'blocks', { commitmentId: b.id, title: 'Lecture', start: at(10, 14), end: at(10, 16) })
	const week = (await call('api', 'app.html', 'GET', `blocks?from=${at(9, 0)}&to=${at(16, 0)}`)).blocks
	const wed = week.find((x) => new Date(x.start * 1000).getDate() === 11)
	await call('api', 'app.html', 'DELETE', `blocks/${wed.series}/${wed.occurrence}?scope=this`)
	ok('blocks planned in the built-in calendar (a repeat with one day skipped)')

	// Only the main window may switch, and it asks first
	assert.equal((await T.handlers.setCalendarMode(page('popover.html'), 'apple')).error, 'Not allowed.')
	mock.dialog.response = 1 // Cancel
	assert.deepEqual(await call('setCalendarMode', 'app.html', 'apple'), { changed: false })
	assert.equal((await call('calendarMode', 'app.html')).mode, 'builtin')
	ok('switching: only from the window, and Cancel changes nothing')

	// macOS says no: stays built in
	apple.granted = false
	mock.dialog.response = 0
	assert.deepEqual(await call('setCalendarMode', 'app.html', 'apple'), { changed: false })
	assert.equal((await call('calendarMode', 'app.html')).mode, 'builtin')
	apple.granted = true
	ok('calendar access refused: the built-in calendar stays')

	// To Apple Calendar
	const r = await call('setCalendarMode', 'app.html', 'apple')
	assert.equal(r.changed, true)
	assert.match(r.message, /2 blocks copied/)
	assert.deepEqual(apple.cals.slice(1).map((c) => c.title), ['Thesis', 'Teaching'], 'a calendar for each commitment')
	const series = apple.events.find((e) => e.repeat === 'weekdays')
	assert.ok(series && series.until === at(20, 9) && series.skip.length === 1 && series.title === 'Thesis', 'the repeat, its end and the skipped day')
	assert.ok(apple.events.some((e) => e.title === 'Lecture' && !e.repeat))
	st = await call('api', 'app.html', 'GET', 'state')
	assert.equal(st.features.builtinCalendar, false)
	assert.ok(st.commitments.every((c) => c.calendarId !== null), 'linked to their new calendars')
	const fromApple = (await call('api', 'app.html', 'GET', `blocks?from=${at(9, 0)}&to=${at(16, 0)}`)).blocks
	assert.equal(fromApple.length, 5, 'Mon, Tue, Thu, Fri + the lecture, read from Apple Calendar')
	ok('→ Apple Calendar: calendars made, blocks copied with their repeats')

	// Meanwhile in Apple Calendar: a new event, and the lecture moved
	const teachingCal = apple.cals.find((c) => c.title === 'Teaching').id
	apple.events.push({ uid: 'NEW1', calendar: teachingCal, title: 'Exam', start: at(18, 8), end: at(18, 10), repeat: '' })
	apple.events.find((e) => e.title === 'Lecture').start = at(10, 15)
	apple.events.find((e) => e.title === 'Lecture').end = at(10, 17)
	apple.events.push({ uid: 'OTHER', calendar: 'HOME', title: 'Dentist', start: at(12, 9), end: at(12, 10), repeat: '' })

	// Back to the built-in calendar
	const back = await call('setCalendarMode', 'app.html', 'builtin')
	assert.equal(back.changed, true)
	const list = (await call('api', 'app.html', 'GET', `blocks?from=${at(9, 0)}&to=${at(21, 0)}`)).blocks
	const sum = list.map((x) => `${new Date(x.start * 1000).getDate()}@${new Date(x.start * 1000).getHours()} ${x.title || 'Thesis'}`)
	assert.deepEqual(sum, ['9@9 Thesis', '10@9 Thesis', '10@15 Lecture', '12@9 Thesis', '13@9 Thesis', '16@9 Thesis', '17@9 Thesis', '18@8 Exam', '18@9 Thesis', '19@9 Thesis', '20@9 Thesis'])
	assert.ok(list.find((x) => new Date(x.start * 1000).getDate() === 16).repeat === 'weekdays', 'the unchanged series is still one repeating block')
	assert.ok(!sum.some((x) => x.includes('Dentist')), 'other calendars are not copied')
	assert.match(back.message, /2 events copied/)
	ok('← built in: new and moved events copied in, the unchanged series kept, nothing doubled')

	// And to Apple Calendar again: only what is new there
	const before = apple.events.length
	const again = await call('setCalendarMode', 'app.html', 'apple')
	assert.match(again.message, /0 blocks copied/)
	assert.equal(apple.events.length, before, 'nothing copied twice')
	ok('→ Apple Calendar again: nothing doubled')

	// Changed in the built-in calendar, then to Apple Calendar: the old copies are replaced
	await call('setCalendarMode', 'app.html', 'builtin')
	let bl = (await call('api', 'app.html', 'GET', `blocks?from=${at(16, 0)}&to=${at(21, 0)}`)).blocks
	const mon = bl.find((x) => x.repeat === 'weekdays')
	await call('api', 'app.html', 'PUT', `blocks/${mon.series}/${mon.occurrence}`, { start: mon.start + 3600, end: mon.end + 3600, scope: 'all' })
	const exam = bl.find((x) => x.title === 'Exam')
	await call('api', 'app.html', 'PUT', `blocks/${exam.series}/${exam.occurrence}`, { start: at(18, 13), end: at(18, 15) })
	await call('setCalendarMode', 'app.html', 'apple')
	const ev = (await call('api', 'app.html', 'GET', `blocks?from=${at(9, 0)}&to=${at(21, 0)}`)).blocks
	const days = ev.filter((x) => x.title === 'Thesis').map((x) => `${new Date(x.start * 1000).getDate()}@${new Date(x.start * 1000).getHours()}`)
	assert.deepEqual(days, ['9@10', '10@10', '12@10', '13@10', '16@10', '17@10', '18@10', '19@10', '20@10'], 'the series moved, once')
	assert.deepEqual(ev.filter((x) => x.title === 'Exam').map((x) => new Date(x.start * 1000).getHours()), [13], 'the exam moved, once')
	assert.equal(apple.events.filter((e) => e.repeat === 'weekdays').length, 1)
	ok('changed in the built-in calendar → replaced in Apple Calendar, not doubled')

	console.log('\nall calendar switch tests passed')
	process.exit(0)
})().catch((e) => { console.error('✘', e); console.error(T.log.slice(-10).join('\n')); process.exit(1) })
