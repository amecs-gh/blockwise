package app.tracker.android;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.security.SecureRandom;
import java.util.Locale;

import app.tracker.core.Hlc;

/**
 * What the app knows without the page: the engine's snapshot (running timer,
 * settings, commitments) and the outbox of changes made from the notification
 * while the page was closed (Stop, the automatic stop at a long break).
 *
 * Outbox entries are sent to the server directly when possible, and handed to
 * the page's engine the next time it runs; an entry is dropped once both
 * have happened. Both stores are encrypted (Vault).
 */
final class Local {
    private static final String PREFS = "tracker-local";
    private static final int MAX_OUTBOX = 500;

    private Local() {
    }

    // --- snapshot ---

    /** null before the page has run once (after logging in) */
    static JSONObject snapshot(Context c) {
        String s = Vault.read(c, Vault.SNAPSHOT);
        if (s == null) {
            return null;
        }
        try {
            return new JSONObject(s);
        } catch (JSONException e) {
            return null;
        }
    }

    static void saveSnapshot(Context c, JSONObject s) {
        Vault.write(c, Vault.SNAPSHOT, s == null ? null : s.toString());
    }

    // --- outbox ---

    private static JSONArray entries(Context c) {
        String s = Vault.read(c, Vault.OUTBOX);
        try {
            return s == null ? new JSONArray() : new JSONArray(s);
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private static void save(Context c, JSONArray all) {
        JSONArray keep = new JSONArray();
        int skip = Math.max(0, all.length() - MAX_OUTBOX);
        for (int i = 0; i < all.length(); i++) {
            JSONObject e = all.optJSONObject(i);
            if (e == null || (e.optBoolean("pushed") && e.optBoolean("imported")) || skip-- > 0) {
                continue;
            }
            keep.put(e);
        }
        Vault.write(c, Vault.OUTBOX, keep.length() == 0 ? null : keep.toString());
    }

    static String key(JSONObject rec) {
        JSONObject clock = rec.optJSONObject("clock");
        String first = "";
        if (clock != null && clock.keys().hasNext()) {
            first = clock.optString(clock.keys().next(), "");
        }
        return rec.optString("type") + ":" + rec.optString("id") + ":" + first;
    }

    static synchronized boolean outboxEmpty(Context c) {
        return entries(c).length() == 0;
    }

    static synchronized void add(Context c, JSONArray records) throws JSONException {
        JSONArray all = entries(c);
        for (int i = 0; i < records.length(); i++) {
            all.put(new JSONObject().put("rec", records.getJSONObject(i)).put("pushed", false).put("imported", false));
        }
        save(c, all);
    }

    /** Records not yet sent to the server, or not yet given to the page. */
    static synchronized JSONArray pending(Context c, String flag) {
        JSONArray out = new JSONArray();
        JSONArray all = entries(c);
        for (int i = 0; i < all.length(); i++) {
            JSONObject e = all.optJSONObject(i);
            if (e != null && !e.optBoolean(flag) && e.optJSONObject("rec") != null) {
                out.put(e.optJSONObject("rec"));
            }
        }
        return out;
    }

    /** Marks these records (by key) as sent ("pushed") or given to the page ("imported"). */
    static synchronized void mark(Context c, JSONArray records, String flag) throws JSONException {
        java.util.Set<String> keys = new java.util.HashSet<>();
        for (int i = 0; i < records.length(); i++) {
            Object o = records.opt(i);
            keys.add(o instanceof JSONObject ? key((JSONObject) o) : String.valueOf(o));
        }
        JSONArray all = entries(c);
        for (int i = 0; i < all.length(); i++) {
            JSONObject e = all.optJSONObject(i);
            if (e != null && e.optJSONObject("rec") != null && keys.contains(key(e.optJSONObject("rec")))) {
                e.put(flag, true);
            }
        }
        save(c, all);
    }

    // --- changes made here ---

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** This app's own clock node (distinct from the page engine's, so clocks never collide). */
    private static synchronized String nextClock(Context c, String seen) {
        SharedPreferences p = prefs(c);
        String node = p.getString("node", null);
        if (node == null) {
            byte[] b = new byte[5];
            new SecureRandom().nextBytes(b);
            StringBuilder sb = new StringBuilder("n");
            for (byte x : b) {
                sb.append(String.format(Locale.ROOT, "%02x", x));
            }
            node = sb.toString();
        }
        String clock = Hlc.next(Hlc.max(p.getString("clock", null), seen), System.currentTimeMillis(), node);
        p.edit().putString("node", node).putString("clock", clock).apply();
        return clock;
    }

    /**
     * Stop the running timer at `at` (with the long break, from the Pomodoro).
     * @param view what the notification shows: the snapshot or the server's state
     * @return the records to send, or null if nothing runs
     */
    static JSONArray stop(Context c, JSONObject view, long at, boolean longBreak) throws JSONException {
        JSONObject run = view == null ? null : view.optJSONObject("running");
        if (run == null || run.optString("uuid", "").isEmpty()) {
            return null;
        }
        long now = System.currentTimeMillis() / 1000;
        long start = run.optLong("start", now);
        long end = Math.max(start, Math.min(at, now));
        String seen = view.optString("hlc", null);
        JSONArray recs = new JSONArray();
        String clock = nextClock(c, seen);
        recs.put(new JSONObject().put("type", "session").put("id", run.getString("uuid"))
                .put("fields", new JSONObject().put("end", end)).put("clock", new JSONObject().put("end", clock)));
        Long until = null;
        if (longBreak) {
            JSONObject s = view.optJSONObject("settings");
            until = end + 60L * (s == null ? 15 : s.optInt("longBreakMinutes", 15));
            String clock2 = nextClock(c, clock);
            recs.put(new JSONObject().put("type", "settings").put("id", "settings")
                    .put("fields", new JSONObject().put("longBreakUntil", until)).put("clock", new JSONObject().put("longBreakUntil", clock2)));
        }
        add(c, recs);
        // The notification shows the stop at once, online or not
        JSONObject snap = snapshot(c);
        if (snap != null) {
            JSONObject sr = snap.optJSONObject("running");
            if (sr != null && run.getString("uuid").equals(sr.optString("uuid"))) {
                snap.put("running", JSONObject.NULL);
            }
            if (until != null) {
                snap.put("longBreakUntil", until);
            }
            saveSnapshot(c, snap);
        }
        return recs;
    }
}
