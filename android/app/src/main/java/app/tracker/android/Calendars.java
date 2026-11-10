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
            a.put(new JSONObject().put("uid", ev.uid).put("title", ev.title).put("start", ev.start).put("end", ev.end).put("url", ev.url));
        }
        return a;
    }

    static final class CalendarException extends Exception {
        CalendarException(String message) {
            super(message);
        }
    }

    /** Adds a block; the calendar app (DAVx5) uploads it to Nextcloud. @return its uid */
    static String create(Context c, String url, String title, long start, long end) throws CalendarException {
        if (!canWrite(c)) {
            throw new CalendarException("Blockwise may not write to your calendar.");
        }
        Cal cal = byUrl(list(c), url);
        if (cal == null) {
            throw new CalendarException("This commitment's calendar is not on this phone. Turn it on in DAVx5.");
        }
        if (!cal.writable) {
            throw new CalendarException("This calendar is read-only.");
        }
        String uid = UUID.randomUUID().toString();
        ContentValues v = new ContentValues();
        v.put(CalendarContract.Events.CALENDAR_ID, cal.id);
        v.put(CalendarContract.Events.DTSTART, start * 1000);
        v.put(CalendarContract.Events.DTEND, end * 1000);
        v.put(CalendarContract.Events.TITLE, title);
        v.put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().getID());
        v.put(CalendarContract.Events.UID_2445, uid);
        try {
            Uri made = c.getContentResolver().insert(CalendarContract.Events.CONTENT_URI, v);
            if (made == null) {
                throw new CalendarException("Could not add the block.");
            }
        } catch (SecurityException | IllegalArgumentException e) {
            throw new CalendarException("Could not add the block.");
        }
        return uid + "#" + start;
    }
}
