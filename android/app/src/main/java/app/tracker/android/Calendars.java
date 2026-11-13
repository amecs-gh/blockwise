package app.tracker.android;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;
import java.util.UUID;

import app.tracker.core.CalendarPath;
import app.tracker.core.Repeat;

/**
 * Blocks from the phone's own calendar storage, so they work offline: your
 * Nextcloud calendars arrive there through DAVx5 (or another CalDAV app), and
 * blocks you add here or in any calendar app sync to Nextcloud with them.
 *
 * Only calendars with a Nextcloud calendar address are used (that address is
 * how a commitment finds its calendar on every device).
 */
final class Calendars {
    private Calendars() {
    }

    static boolean canRead(Context c) {
        return c.checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean canWrite(Context c) {
        return c.checkSelfPermission(Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED;
    }

    static final class Cal {
        long id;
        String url; // "/remote.php/dav/calendars/<user>/<calendar>/"
        String name;
        String color;
        boolean writable;
    }

    /** Nextcloud calendars on this phone (empty without the permission). */
    static List<Cal> list(Context c) {
        List<Cal> out = new ArrayList<>();
        if (!canRead(c)) {
            return out;
        }
        String[] cols = {
            CalendarContract.Calendars._ID,
            CalendarContract.Calendars.NAME,
            CalendarContract.Calendars._SYNC_ID,
            CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
            CalendarContract.Calendars.CALENDAR_COLOR,
            CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
        };
        ContentResolver cr = c.getContentResolver();
        try (Cursor cur = cr.query(CalendarContract.Calendars.CONTENT_URI, cols, null, null, null)) {
            if (cur == null) {
                return out;
            }
            String server = Store.server(c);
            String host = server == null ? null : Nextcloud.host(server).toLowerCase(java.util.Locale.ROOT);
            Map<String, Cal> byPath = new java.util.LinkedHashMap<>();
            Map<String, Boolean> onServer = new HashMap<>();
            while (cur.moveToNext()) {
                // DAVx5 keeps the calendar's address in _SYNC_ID or NAME
                String full = cur.getString(2);
                String url = CalendarPath.of(full);
                if (url == null) {
                    full = cur.getString(1);
                    url = CalendarPath.of(full);
                }
                if (url == null) {
                    continue; // a local calendar
                }
                // The same calendar address on two servers (two accounts): prefer the one you are logged in to
                boolean mine = host != null && full != null && full.toLowerCase(java.util.Locale.ROOT).contains("://" + host + "/");
                if (byPath.containsKey(url) && (Boolean.TRUE.equals(onServer.get(url)) || !mine)) {
                    continue;
                }
                onServer.put(url, mine);
                Cal cal = new Cal();
                cal.id = cur.getLong(0);
                cal.url = url;
                cal.name = cur.isNull(3) ? "" : cur.getString(3);
                cal.color = String.format(java.util.Locale.ROOT, "#%06X", 0xFFFFFF & cur.getInt(4));
                cal.writable = cur.getInt(5) >= CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR;
                byPath.put(url, cal);
            }
            out.addAll(byPath.values());
        } catch (SecurityException e) {
            out.clear();
        }
        return out;
    }

    static JSONArray listJson(Context c) throws JSONException {
        JSONArray a = new JSONArray();
        for (Cal cal : list(c)) {
            a.put(new JSONObject().put("url", cal.url).put("name", cal.name).put("color", cal.color).put("writable", cal.writable));
        }
        return a;
    }

    private static Cal byUrl(List<Cal> cals, String url) {
        for (Cal cal : cals) {
            if (CalendarPath.same(cal.url, url)) {
                return cal;
            }
        }
        return null;
    }

    static final class Event {
        String uid; // "<iCalendar UID>#<start>": the same id the server gives the block
        String title;
        long start;
        long end;
        String url;
        long series; // the event's row: which block to change
        long occurrence; // when this one starts (as the calendar has it)
        String repeat = "";
        Long until;
    }

    /** Timed events overlapping [from, to) in the calendars with these addresses (recurring ones expanded). */
    static List<Event> events(Context c, long from, long to, List<String> urls) {
        List<Event> out = new ArrayList<>();
        if (!canRead(c) || to <= from) {
            return out;
        }
        List<Cal> cals = list(c);
        Map<Long, String> wanted = new HashMap<>();
        for (String u : urls) {
            Cal cal = byUrl(cals, u);
            if (cal != null) {
                wanted.put(cal.id, u);
            }
        }
        if (wanted.isEmpty()) {
            return out;
        }
        StringBuilder sel = new StringBuilder(CalendarContract.Instances.ALL_DAY + "=0 AND " + CalendarContract.Instances.CALENDAR_ID + " IN (");
        String[] args = new String[wanted.size()];
        int i = 0;
        for (Long id : wanted.keySet()) {
            sel.append(i == 0 ? "?" : ",?");
            args[i++] = String.valueOf(id);
        }
        sel.append(")");
        Uri.Builder b = CalendarContract.Instances.CONTENT_URI.buildUpon();
        ContentUris.appendId(b, from * 1000);
        ContentUris.appendId(b, to * 1000);
        String[] cols = {
            CalendarContract.Instances.EVENT_ID,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.CALENDAR_ID,
            CalendarContract.Instances.STATUS,
            CalendarContract.Instances.UID_2445,
            CalendarContract.Instances.RRULE,
        };
        try (Cursor cur = c.getContentResolver().query(b.build(), cols, sel.toString(), args, CalendarContract.Instances.BEGIN + " ASC")) {
            if (cur == null) {
                return out;
            }
            while (cur.moveToNext()) {
                if (!cur.isNull(5) && cur.getInt(5) == CalendarContract.Events.STATUS_CANCELED) {
                    continue;
                }
                long s = cur.getLong(1) / 1000;
                long e = cur.getLong(2) / 1000;
                if (e <= s || e <= from || s >= to) {
                    continue;
                }
                String uid = cur.isNull(6) ? "" : cur.getString(6);
                Event ev = new Event();
                ev.uid = (uid.isEmpty() ? "android-" + cur.getLong(0) : uid) + "#" + s;
                ev.title = cur.isNull(3) ? "" : cur.getString(3);
                ev.start = s;
                ev.end = e;
                ev.url = wanted.get(cur.getLong(4));
                ev.series = cur.getLong(0);
                ev.occurrence = s;
                String rule = cur.isNull(7) ? null : cur.getString(7);
                ev.repeat = Repeat.fromRrule(rule);
                ev.until = ev.repeat.isEmpty() ? null : Repeat.until(rule);
                out.add(ev);
            }
        } catch (SecurityException e) {
            out.clear();
        }
        return out;
    }

    static JSONArray eventsJson(Context c, long from, long to, List<String> urls) throws JSONException {
        JSONArray a = new JSONArray();
        for (Event ev : events(c, from, to, urls)) {
            a.put(new JSONObject().put("uid", ev.uid).put("title", ev.title).put("start", ev.start).put("end", ev.end).put("url", ev.url)
                    .put("series", ev.series).put("occurrence", ev.occurrence).put("repeat", ev.repeat).put("until", ev.until == null ? JSONObject.NULL : ev.until));
        }
        return a;
    }

    static final class CalendarException extends Exception {
        CalendarException(String message) {
            super(message);
        }
    }

    /** The time zone a repeating block keeps (so 9:00 stays 9:00 after a clock change) */
    private static String zone(String tz) {
        if (tz != null && !tz.isEmpty() && tz.length() < 64 && TimeZone.getTimeZone(tz).getID().equals(tz)) {
            return tz;
        }
        return TimeZone.getDefault().getID();
    }

    private static Cal writable(List<Cal> cals, String url) throws CalendarException {
        Cal cal = byUrl(cals, url);
        if (cal == null) {
            throw new CalendarException("This commitment's calendar is not on this phone. Turn it on in DAVx5.");
        }
        if (!cal.writable) {
            throw new CalendarException("This calendar is read-only.");
        }
        return cal;
    }

    /** start, end, title, the rule (or none) and time zone, as the provider wants them */
    private static ContentValues times(long start, long end, String title, String rrule, String tz) {
        ContentValues v = new ContentValues();
        v.put(CalendarContract.Events.DTSTART, start * 1000);
        if (rrule == null) {
            v.put(CalendarContract.Events.DTEND, end * 1000);
            v.putNull(CalendarContract.Events.DURATION);
            v.putNull(CalendarContract.Events.RRULE);
        } else {
            // A repeating event has a length, not an end
            v.putNull(CalendarContract.Events.DTEND);
            v.put(CalendarContract.Events.DURATION, "P" + (end - start) + "S");
            v.put(CalendarContract.Events.RRULE, rrule);
        }
        v.put(CalendarContract.Events.TITLE, title);
        v.put(CalendarContract.Events.EVENT_TIMEZONE, zone(tz));
        return v;
    }

    private static long insert(Context c, Cal cal, long start, long end, String title, String rrule, String tz) throws CalendarException {
        ContentValues v = times(start, end, title, rrule, tz);
        v.put(CalendarContract.Events.CALENDAR_ID, cal.id);
        v.put(CalendarContract.Events.UID_2445, UUID.randomUUID().toString());
        try {
            Uri made = c.getContentResolver().insert(CalendarContract.Events.CONTENT_URI, v);
            if (made == null) {
                throw new CalendarException("Could not add the block.");
            }
            return ContentUris.parseId(made);
        } catch (SecurityException | IllegalArgumentException e) {
            throw new CalendarException("Could not add the block.");
        }
    }

    /** Adds a block (repeating, if asked); the calendar app (DAVx5) uploads it to Nextcloud. @return its uid */
    static String create(Context c, String url, String title, long start, long end, String repeat, Long until, String tz) throws CalendarException {
        if (!canWrite(c)) {
            throw new CalendarException("Blockwise may not write to your calendar.");
        }
        Cal cal = writable(list(c), url);
        long id = insert(c, cal, start, end, title, Repeat.toRrule(repeat, until), tz);
        return uidOf(c, id) + "#" + start;
    }

    private static String uidOf(Context c, long id) {
        try (Cursor cur = c.getContentResolver().query(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id),
                new String[] {CalendarContract.Events.UID_2445}, null, null, null)) {
            if (cur != null && cur.moveToFirst() && !cur.isNull(0)) {
                return cur.getString(0);
            }
        } catch (SecurityException | IllegalArgumentException e) {
            // fall through
        }
        return "android-" + id;
    }

    /** One event row, and its calendar (only Nextcloud calendars Blockwise uses) */
    private static final class Row {
        long id;
        Cal cal;
        String rrule;
        long dtstart;
        String title;
        String tz;
        long originalId; // an exception: the series it belongs to
    }

    private static Row row(Context c, List<Cal> cals, long id) throws CalendarException {
        String[] cols = {
            CalendarContract.Events.CALENDAR_ID,
            CalendarContract.Events.RRULE,
            CalendarContract.Events.DTSTART,
            CalendarContract.Events.TITLE,
            CalendarContract.Events.EVENT_TIMEZONE,
            CalendarContract.Events.ORIGINAL_ID,
            CalendarContract.Events.DELETED,
        };
        try (Cursor cur = c.getContentResolver().query(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), cols, null, null, null)) {
            if (cur == null || !cur.moveToFirst() || (!cur.isNull(6) && cur.getInt(6) != 0)) {
                throw new CalendarException("This block is gone. Pull to refresh.");
            }
            Row r = new Row();
            r.id = id;
            long calId = cur.getLong(0);
            for (Cal cal : cals) {
                if (cal.id == calId) {
                    r.cal = cal;
                }
            }
            // Only events in the Nextcloud calendars on this phone, never another account's
            if (r.cal == null) {
                throw new CalendarException("This block is gone. Pull to refresh.");
            }
            if (!r.cal.writable) {
                throw new CalendarException("This calendar is read-only.");
            }
            r.rrule = cur.isNull(1) || cur.getString(1).trim().isEmpty() ? null : cur.getString(1);
            r.dtstart = cur.getLong(2) / 1000;
            r.title = cur.isNull(3) ? "" : cur.getString(3);
            r.tz = cur.isNull(4) ? null : cur.getString(4);
            r.originalId = cur.isNull(5) ? 0 : cur.getLong(5);
            return r;
        } catch (SecurityException | IllegalArgumentException e) {
            throw new CalendarException("Blockwise may not write to your calendar.");
        }
    }

    /** When the occurrence starting at `occ` ends (its own length; exceptions included) */
    private static long endOf(Context c, Row r, long occ) throws CalendarException {
        Uri.Builder b = CalendarContract.Instances.CONTENT_URI.buildUpon();
        ContentUris.appendId(b, occ * 1000);
        ContentUris.appendId(b, occ * 1000 + 1000);
        try (Cursor cur = c.getContentResolver().query(b.build(), new String[] {CalendarContract.Instances.BEGIN, CalendarContract.Instances.END},
                CalendarContract.Instances.EVENT_ID + "=?", new String[] {String.valueOf(r.id)}, null)) {
            while (cur != null && cur.moveToNext()) {
                if (cur.getLong(0) / 1000 == occ) {
                    return cur.getLong(1) / 1000;
                }
            }
        } catch (SecurityException | IllegalArgumentException e) {
            // fall through
        }
        throw new CalendarException("This block is gone. Pull to refresh.");
    }

    private static void change(Context c, long id, ContentValues v) throws CalendarException {
        try {
            if (c.getContentResolver().update(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), v, null, null) < 1) {
                throw new CalendarException("Could not change the block.");
            }
        } catch (SecurityException | IllegalArgumentException e) {
            throw new CalendarException("Could not change the block.");
        }
    }

    private static void remove(Context c, long id) throws CalendarException {
        try {
            c.getContentResolver().delete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), null, null);
        } catch (SecurityException | IllegalArgumentException e) {
            throw new CalendarException("Could not delete the block.");
        }
    }

    /** One occurrence of a series as its own event (moved, or cancelled). @return the new row */
    private static long exception(Context c, Row r, long occ, ContentValues v) throws CalendarException {
        v.put(CalendarContract.Events.ORIGINAL_INSTANCE_TIME, occ * 1000);
        try {
            Uri made = c.getContentResolver().insert(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_EXCEPTION_URI, r.id), v);
            if (made == null) {
                throw new CalendarException("Could not change the block.");
            }
            return ContentUris.parseId(made);
        } catch (SecurityException | IllegalArgumentException e) {
            throw new CalendarException("Could not change the block.");
        }
    }

    /** Exceptions of a series from `occ` on (when the series ends there) */
    private static void dropExceptions(Context c, Row r, long occ) {
        try {
            c.getContentResolver().delete(CalendarContract.Events.CONTENT_URI,
                    CalendarContract.Events.ORIGINAL_ID + "=? AND " + CalendarContract.Events.ORIGINAL_INSTANCE_TIME + ">=?",
                    new String[] {String.valueOf(r.id), String.valueOf(occ * 1000)});
        } catch (SecurityException | IllegalArgumentException e) {
            // they stay as they are
        }
    }

    /**
     * Moves or changes a block, like the built-in calendar does: `scope` "this"
     * (this occurrence), "future" (this and the following ones) or "all".
     * In `ch`: start, end, title, repeat, until, tz, and url for another commitment's calendar.
     * @return {ok, series, occurrence}: where the block is now
     */
    static JSONObject update(Context c, long id, long occ, JSONObject ch) throws CalendarException, JSONException {
        if (!canWrite(c)) {
            throw new CalendarException("Blockwise may not write to your calendar.");
        }
        List<Cal> cals = list(c);
        Row r = row(c, cals, id);
        long oldEnd = endOf(c, r, occ);
        long start = ch.has("start") ? ch.getLong("start") : occ;
        long end = ch.has("end") ? ch.getLong("end") : start + (oldEnd - occ);
        if (end <= start || end - start > 86400 || start < 0) {
            throw new CalendarException("Invalid time");
        }
        String title = ch.has("title") ? ch.optString("title", "").trim() : r.title;
        if (title.length() > 255) {
            title = title.substring(0, 255);
        }
        String tz = ch.has("tz") ? ch.optString("tz", null) : r.tz;
        Cal target = ch.has("url") ? writable(cals, ch.getString("url")) : r.cal;
        boolean moving = target.id != r.cal.id;
        String scope = r.rrule == null ? "all" : ch.optString("scope", "all");
        if ("future".equals(scope) && occ <= r.dtstart) {
            scope = "all";
        }
        long delta = start - occ;
        // The rule from here on: as asked, or the old one (its end moving with the blocks)
        String rule;
        boolean asked = ch.has("repeat") || ch.has("until");
        String repeat = ch.optString("repeat", r.rrule == null ? "" : Repeat.fromRrule(r.rrule));
        Long until = ch.has("until") && !ch.isNull("until") ? ch.getLong("until") : null;
        if (until != null && until < start) {
            until = null;
        }
        if (asked && !"custom".equals(repeat)) {
            rule = Repeat.toRrule(repeat, until);
        } else if (r.rrule == null) {
            rule = null;
        } else {
            Long old = Repeat.until(r.rrule);
            rule = asked && "custom".equals(repeat) ? (until == null ? Repeat.endless(r.rrule) : Repeat.withUntil(r.rrule, until))
                    : old == null ? r.rrule : Repeat.withUntil(r.rrule, old + delta);
        }
        JSONObject out = new JSONObject().put("ok", true).put("occurrence", start);

        if ("this".equals(scope)) {
            // This one only: cancelled in the series, kept as its own block
            if (moving) {
                ContentValues gone = new ContentValues();
                gone.put(CalendarContract.Events.STATUS, CalendarContract.Events.STATUS_CANCELED);
                exception(c, r, occ, gone);
                return out.put("series", insert(c, target, start, end, title, null, tz));
            }
            ContentValues v = new ContentValues();
            v.put(CalendarContract.Events.DTSTART, start * 1000);
            v.put(CalendarContract.Events.DTEND, end * 1000);
            v.put(CalendarContract.Events.TITLE, title);
            v.put(CalendarContract.Events.EVENT_TIMEZONE, zone(tz));
            return out.put("series", exception(c, r, occ, v));
        }
        if ("future".equals(scope)) {
            // The series ends before this one; a new one starts here
            ContentValues v = new ContentValues();
            v.put(CalendarContract.Events.RRULE, Repeat.withUntil(r.rrule, occ - 1));
            change(c, r.id, v);
            dropExceptions(c, r, occ);
            return out.put("series", insert(c, target, start, end, title, rule, tz));
        }
        // All of them: the whole series moves by the same amount
        long sStart = r.rrule == null ? start : r.dtstart + delta;
        if (rule != null && Repeat.until(rule) != null && Repeat.until(rule) < sStart) {
            rule = Repeat.endless(rule);
        }
        if (moving) {
            long made = insert(c, target, sStart, sStart + (end - start), title, rule, tz);
            remove(c, r.id);
            return out.put("series", made);
        }
        change(c, r.id, times(sStart, sStart + (end - start), title, rule, tz));
        return out.put("series", r.id);
    }

    /** Deletes a block: this occurrence, this and the following ones, or all */
    static JSONObject delete(Context c, long id, long occ, String scope) throws CalendarException, JSONException {
        if (!canWrite(c)) {
            throw new CalendarException("Blockwise may not write to your calendar.");
        }
        Row r = row(c, list(c), id);
        if (r.rrule == null || "all".equals(scope) || ("future".equals(scope) && occ <= r.dtstart)) {
            remove(c, r.id);
        } else if ("this".equals(scope)) {
            endOf(c, r, occ); // an occurrence of this series
            ContentValues gone = new ContentValues();
            gone.put(CalendarContract.Events.STATUS, CalendarContract.Events.STATUS_CANCELED);
            exception(c, r, occ, gone);
        } else {
            ContentValues v = new ContentValues();
            v.put(CalendarContract.Events.RRULE, Repeat.withUntil(r.rrule, occ - 1));
            change(c, r.id, v);
            dropExceptions(c, r, occ);
        }
        return new JSONObject().put("ok", true);
    }

    /** All calendars on this phone that are shown, other than these (the commitments'): for grey busy time */
    static JSONArray others(Context c, List<String> exclude) throws JSONException {
        JSONArray a = new JSONArray();
        if (!canRead(c)) {
            return a;
        }
        String[] cols = {
            CalendarContract.Calendars._ID,
            CalendarContract.Calendars.NAME,
            CalendarContract.Calendars._SYNC_ID,
            CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
            CalendarContract.Calendars.CALENDAR_COLOR,
            CalendarContract.Calendars.ACCOUNT_NAME,
        };
        try (Cursor cur = c.getContentResolver().query(CalendarContract.Calendars.CONTENT_URI, cols,
                CalendarContract.Calendars.VISIBLE + "=1", null, CalendarContract.Calendars.ACCOUNT_NAME + " ASC")) {
            while (cur != null && cur.moveToNext()) {
                String url = CalendarPath.of(cur.getString(2));
                if (url == null) {
                    url = CalendarPath.of(cur.getString(1));
                }
                boolean mine = false;
                for (String x : exclude) {
                    mine |= url != null && CalendarPath.same(url, x);
                }
                if (mine) {
                    continue;
                }
                a.put(new JSONObject().put("id", cur.getLong(0)).put("name", cur.isNull(3) ? "" : cur.getString(3))
                        .put("account", cur.isNull(5) ? "" : cur.getString(5))
                        .put("color", String.format(java.util.Locale.ROOT, "#%06X", 0xFFFFFF & cur.getInt(4))));
            }
        } catch (SecurityException e) {
            return new JSONArray();
        }
        return a;
    }

    /** Timed events in these calendars (ids from others()): title and time only */
    static JSONArray busy(Context c, long from, long to, List<Long> ids) throws JSONException {
        JSONArray a = new JSONArray();
        if (!canRead(c) || to <= from || ids.isEmpty()) {
            return a;
        }
        StringBuilder sel = new StringBuilder(CalendarContract.Instances.ALL_DAY + "=0 AND " + CalendarContract.Instances.CALENDAR_ID + " IN (");
        String[] args = new String[ids.size()];
        for (int i = 0; i < ids.size(); i++) {
            sel.append(i == 0 ? "?" : ",?");
            args[i] = String.valueOf(ids.get(i));
        }
        sel.append(")");
        Uri.Builder b = CalendarContract.Instances.CONTENT_URI.buildUpon();
        ContentUris.appendId(b, from * 1000);
        ContentUris.appendId(b, to * 1000);
        String[] cols = {CalendarContract.Instances.BEGIN, CalendarContract.Instances.END, CalendarContract.Instances.TITLE, CalendarContract.Instances.STATUS, CalendarContract.Instances.CALENDAR_ID};
        try (Cursor cur = c.getContentResolver().query(b.build(), cols, sel.toString(), args, CalendarContract.Instances.BEGIN + " ASC")) {
            while (cur != null && cur.moveToNext() && a.length() < 2000) {
                if (!cur.isNull(3) && cur.getInt(3) == CalendarContract.Events.STATUS_CANCELED) {
                    continue;
                }
                long s = cur.getLong(0) / 1000;
                long e = cur.getLong(1) / 1000;
                if (e <= s || e <= from || s >= to) {
                    continue;
                }
                a.put(new JSONObject().put("title", cur.isNull(2) ? "" : cur.getString(2)).put("start", s).put("end", e).put("calendar", cur.getLong(4)));
            }
        } catch (SecurityException e) {
            return new JSONArray();
        }
        return a;
    }
}
