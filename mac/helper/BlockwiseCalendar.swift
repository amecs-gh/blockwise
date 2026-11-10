// Blockwise's door to Apple Calendar (EventKit). The Mac app runs it with one
// command; it reads JSON on stdin and answers JSON on stdout:
//   {"ok": true, "data": ...}  or  {"ok": false, "error": "denied" | "invalid" | "failed"}
//
// Commands: access, calendars, events {from, to, calendars}, createEvent
// {calendar, title, start, end, repeat?, until?, skip?}, deleteEvent {calendar, uid, start?},
// createCalendar {title, color}. Times are unix
// seconds. It only touches calendars and events, never reminders or contacts.
//
// Build: swiftc -O -target arm64-apple-macos13 -framework EventKit -o build/blockwise-calendar BlockwiseCalendar.swift

import EventKit
import Foundation

let store = EKEventStore()

func reply(_ object: [String: Any]) -> Never {
	let data = (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data("{\"ok\":false,\"error\":\"failed\"}".utf8)
	FileHandle.standardOutput.write(data)
	exit(object["ok"] as? Bool == true ? 0 : 1)
}
func ok(_ data: Any) -> Never { reply(["ok": true, "data": data]) }
func fail(_ error: String) -> Never { reply(["ok": false, "error": error]) }

func hasAccess() -> Bool {
	let status = EKEventStore.authorizationStatus(for: .event)
	if #available(macOS 14.0, *) { return status == .fullAccess }
	return status == .authorized
}

/// Asks macOS once (the system dialog); later answers come from System Settings.
func requestAccess() -> Bool {
	if hasAccess() { return true }
	let wait = DispatchSemaphore(value: 0)
	var granted = false
	if #available(macOS 14.0, *) {
		store.requestFullAccessToEvents { g, _ in granted = g; wait.signal() }
	} else {
		store.requestAccess(to: .event) { g, _ in granted = g; wait.signal() }
	}
	_ = wait.wait(timeout: .now() + 120)
	return granted
}

func hex(_ color: CGColor?) -> String {
	guard let c = color, let rgb = c.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil),
		let comps = rgb.components, comps.count >= 3 else { return "#0082c9" }
	let v = comps.prefix(3).map { max(0, min(255, Int(($0 * 255).rounded()))) }
	return String(format: "#%02x%02x%02x", v[0], v[1], v[2])
}

func color(fromHex s: String) -> CGColor? {
	guard s.count == 7, s.hasPrefix("#"), let v = UInt32(s.dropFirst(), radix: 16) else { return nil }
	return CGColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
}

func number(_ v: Any?) -> Double? {
	if let n = v as? NSNumber { let d = n.doubleValue; return d.isFinite ? d : nil }
	return nil
}
func text(_ v: Any?, max: Int) -> String? {
	guard let s = v as? String, !s.isEmpty else { return nil }
	return String(s.prefix(max))
}

// --- main ---

let args = CommandLine.arguments
guard args.count == 2 else { fail("invalid") }
let inputData = FileHandle.standardInput.readDataToEndOfFile()
guard inputData.count <= 1_000_000 else { fail("invalid") }
let input = (inputData.isEmpty ? [:] : (try? JSONSerialization.jsonObject(with: inputData)) as? [String: Any]) ?? [:]

switch args[1] {
case "access":
	ok(["granted": requestAccess()])

case "calendars":
	guard hasAccess() || requestAccess() else { fail("denied") }
	ok(store.calendars(for: .event).map { c in [
		"id": c.calendarIdentifier,
		"title": c.title,
		"color": hex(c.cgColor),
		"writable": c.allowsContentModifications,
		"source": c.source?.title ?? "",
	] as [String: Any] })

case "events":
	guard hasAccess() else { fail("denied") }
	guard let from = number(input["from"]), let to = number(input["to"]), to > from, to - from <= 450 * 86400,
		let ids = input["calendars"] as? [String], ids.count <= 500 else { fail("invalid") }
	let wanted = Set(ids)
	let cals = store.calendars(for: .event).filter { wanted.contains($0.calendarIdentifier) }
	if cals.isEmpty { ok([]) }
	let predicate = store.predicateForEvents(withStart: Date(timeIntervalSince1970: from), end: Date(timeIntervalSince1970: to), calendars: cals)
	let events = store.events(matching: predicate).prefix(20000).compactMap { e -> [String: Any]? in
		if e.status == .canceled { return nil }
		guard let start = e.startDate, let end = e.endDate else { return nil }
		return [
			// The iCalendar UID: the same block on every device and on the server
			"uid": e.calendarItemExternalIdentifier ?? e.eventIdentifier ?? UUID().uuidString,
			"title": e.title ?? "",
			"start": start.timeIntervalSince1970,
			"end": end.timeIntervalSince1970,
			"allDay": e.isAllDay,
			"calendar": e.calendar.calendarIdentifier,
		]
	}
	ok(Array(events))

case "createEvent":
	guard hasAccess() else { fail("denied") }
	guard let id = input["calendar"] as? String, let cal = store.calendar(withIdentifier: id), cal.allowsContentModifications,
		let start = number(input["start"]), let end = number(input["end"]), end > start, end - start <= 86400 else { fail("invalid") }
	let e = EKEvent(eventStore: store)
	e.calendar = cal
	e.title = text(input["title"], max: 255) ?? cal.title
	e.startDate = Date(timeIntervalSince1970: start)
	e.endDate = Date(timeIntervalSince1970: end)
	// A repeating block (from Blockwise's built-in calendar)
	let repeatKind = (input["repeat"] as? String) ?? ""
	if !repeatKind.isEmpty {
		var freq = EKRecurrenceFrequency.daily
		var interval = 1
		var days: [EKRecurrenceDayOfWeek]? = nil
		switch repeatKind {
		case "daily": freq = .daily
		case "weekdays": freq = .weekly; days = [2, 3, 4, 5, 6].compactMap { EKWeekday(rawValue: $0) }.map { EKRecurrenceDayOfWeek($0) }
		case "weekly": freq = .weekly
		case "biweekly": freq = .weekly; interval = 2
		case "monthly": freq = .monthly
		default: fail("invalid")
		}
		var until: EKRecurrenceEnd? = nil
		if let u = number(input["until"]), u >= start { until = EKRecurrenceEnd(end: Date(timeIntervalSince1970: u)) }
		e.addRecurrenceRule(EKRecurrenceRule(recurrenceWith: freq, interval: interval, daysOfTheWeek: days, daysOfTheMonth: nil, monthsOfTheYear: nil, weeksOfTheYear: nil, daysOfTheYear: nil, setPositions: nil, end: until))
	}
	do { try store.save(e, span: .thisEvent, commit: true) } catch { fail("failed") }
	// Occurrences deleted in Blockwise: removed here too
	if !repeatKind.isEmpty, let skip = input["skip"] as? [NSNumber], skip.count <= 1000 {
		let itemId = e.calendarItemIdentifier
		for s in skip {
			let t = s.doubleValue
			guard t.isFinite else { continue }
			let p = store.predicateForEvents(withStart: Date(timeIntervalSince1970: t - 60), end: Date(timeIntervalSince1970: t + 60), calendars: [cal])
			for occ in store.events(matching: p) where occ.calendarItemIdentifier == itemId && abs(occ.startDate.timeIntervalSince1970 - t) < 1 {
				try? store.remove(occ, span: .thisEvent, commit: false)
			}
		}
		try? store.commit()
	}
	ok(["uid": e.calendarItemExternalIdentifier ?? e.eventIdentifier ?? ""])

case "deleteEvent":
	// A block changed in Blockwise's built-in calendar: its old copy goes. With
	// `start`, only that occurrence; without, the whole series.
	guard hasAccess() else { fail("denied") }
	guard let uid = text(input["uid"], max: 1000), let calId = input["calendar"] as? String else { fail("invalid") }
	// Only in the commitment's own calendar: never in your other calendars
	let items = store.calendarItems(withExternalIdentifier: uid).compactMap { $0 as? EKEvent }.filter { $0.calendar.calendarIdentifier == calId }
	guard let master = items.first, master.calendar.allowsContentModifications else { ok(["deleted": 0]) }
	if let s = number(input["start"]) {
		let p = store.predicateForEvents(withStart: Date(timeIntervalSince1970: s - 60), end: Date(timeIntervalSince1970: s + 60), calendars: [master.calendar])
		var n = 0
		for occ in store.events(matching: p) where occ.calendarItemExternalIdentifier == uid && abs(occ.startDate.timeIntervalSince1970 - s) < 1 {
			if (try? store.remove(occ, span: .thisEvent, commit: false)) != nil { n += 1 }
		}
		try? store.commit()
		ok(["deleted": n])
	}
	do { try store.remove(master, span: .futureEvents, commit: true) } catch { fail("failed") }
	ok(["deleted": 1])

case "createCalendar":
	guard hasAccess() else { fail("denied") }
	guard let title = text(input["title"], max: 255) else { fail("invalid") }
	let cal = EKCalendar(for: .event, eventStore: store)
	cal.title = title
	if let c = color(fromHex: (input["color"] as? String) ?? "") { cal.cgColor = c }
	// Where your new calendars go (iCloud if you use it), else this Mac
	let source = store.defaultCalendarForNewEvents?.source
		?? store.sources.first { $0.sourceType == .calDAV }
		?? store.sources.first { $0.sourceType == .local }
	guard let src = source else { fail("failed") }
	cal.source = src
	do { try store.saveCalendar(cal, commit: true) } catch { fail("failed") }
	ok(["id": cal.calendarIdentifier])

default:
	fail("invalid")
}
