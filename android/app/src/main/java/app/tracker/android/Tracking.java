package app.tracker.android;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import app.tracker.core.Alerts;
import app.tracker.core.CalendarPath;
import app.tracker.core.Dash;
import app.tracker.core.I18n;

/**
 * Everything that happens without the page: the ongoing notification with the
 * running timer and a Stop button, reminders (block ending, Pomodoro), stopping
 * at the long break, and waking up only when something is due.
 */
final class Tracking {
    static final String CH_TIMER = "timer";
    static final String CH_ALERTS = "alerts";
    static final int ID_TIMER = 1;
    static final String ACTION_STOP = "app.tracker.android.STOP";
    static final String ACTION_CHECK = "app.tracker.android.CHECK";
    /** The timer's notification was swiped away while tracking: it comes back */
    static final String ACTION_DISMISSED = "app.tracker.android.DISMISSED";

    /** One background thread for all background work, so changes stay in order. */
    static final ExecutorService IO = Executors.newSingleThreadExecutor();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** Told after each refresh (MainActivity, to reload the page when something changed elsewhere). */
    interface Listener {
        void onDash(Dash dash, boolean loggedOut, boolean changedElsewhere);
    }

    static volatile Listener listener;
    private static volatile Dash last;
    /** Blocks of calendars the phone doesn't have, as the server gave them last time */
    private static volatile List<Calendars.Event> serverEvents = new ArrayList<>();

    private Tracking() {
    }

    static I18n i18n() {
        return I18n.forLocale(Locale.getDefault());
    }

    static void ensureChannels(Context c) {
        I18n t = i18n();
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel timer = new NotificationChannel(CH_TIMER, t.t("Timer"), NotificationManager.IMPORTANCE_LOW);
        timer.setDescription(t.t("Shows the running timer while you track time."));
        timer.setShowBadge(false);
        NotificationChannel alerts = new NotificationChannel(CH_ALERTS, t.t("Reminders"), NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription(t.t("Block ending, Pomodoro breaks."));
        nm.createNotificationChannel(timer);
        nm.createNotificationChannel(alerts);
    }

    // --- refresh -------------------------------------------------------------------------

    /**
     * Updates the notification, shows due reminders, stops at the long break,
     * and schedules the next check, from what the phone knows (local-first):
     * the page engine's snapshot and the phone's calendars. When online and
     * nothing waits to be synced, the server's state is used, so a timer
     * started on the Mac or in the browser shows here too.
     * `done` (may be null) runs on the main thread afterwards.
     */
    static void refresh(Context context, Runnable done) {
        refresh(context, done, true);
    }

    /** @param askServer false after a change on the phone (its data is the newest then) */
    static void refresh(Context context, Runnable done, boolean askServer) {
        final Context c = context.getApplicationContext();
        IO.execute(() -> {
            boolean loggedOut = false;
            boolean elsewhere = false;
            Dash d = null;
            Nextcloud client = Store.client(c);
            // No Nextcloud (on this phone only, or a drive): the page's snapshot, its built-in blocks included
            boolean local = client == null && Store.noServer(c);
            if (client != null || local) {
                I18n t = i18n();
                try {
                    if (askServer && client != null) {
                        pushOutbox(c, client, t);
                    }
                    JSONObject snap = Local.snapshot(c);
                    boolean localChanges = (snap != null && snap.optInt("pending", 0) > 0) || !Local.outboxEmpty(c);
                    JSONObject server = null;
                    if (client != null && (askServer || snap == null)) {
                        try {
                            server = new JSONObject(client.api("GET", "state", null, t));
                        } catch (Nextcloud.ApiException e) {
                            if (e.status == 401) {
                                throw e;
                            }
                            // offline: the phone's own data
                        }
                    }
                    JSONObject view = snap;
                    if (server != null && (snap == null || !localChanges)) {
                        view = server;
                        if (snap != null) {
                            view.put("hlc", snap.optString("hlc", ""));
                            elsewhere = !sameState(snap, server);
                        }
                    }
                    d = build(c, view, server, client, t);
                    long now = System.currentTimeMillis() / 1000;
                    Set<String> seen = Store.seen(c);
                    Alerts.Result a = Alerts.check(d, now, seen, t);
                    Store.saveSeen(c, seen);
                    if (Store.notifications(c)) {
                        for (Alerts.Notice n : a.notifications) {
                            notifyAlert(c, n);
                        }
                    }
                    if (a.stopAt != null) {
                        // Pomodoro long break: stop exactly at its start
                        if (Local.stop(c, view, a.stopAt, true) != null) {
                            if (client != null) {
                                pushOutbox(c, client, t);
                            }
                            elsewhere = true;
                        }
                        d = build(c, Local.snapshot(c) != null && view == snap ? Local.snapshot(c) : stopped(view, a.stopAt), server, client, t);
                    } else if (a.clearLongBreak) {
                        d.longBreakUntil = null;
                    }
                } catch (Nextcloud.ApiException e) {
                    // App password revoked in Nextcloud: back to the login screen (data not yet synced stays)
                    Store.clear(c);
                    loggedOut = true;
                    if (Store.notifications(c)) {
                        notifyText(c, "relogin", t.t("Log in again"), t.t("Nextcloud rejected the app password. Log in again."));
                    }
                } catch (JSONException e) {
                    d = last;
                }
            }
            last = d;
            boolean active = (client != null || local) && !loggedOut;
            showTimer(c, active ? d : null);
            schedule(c, active ? d : null);
            final Dash result = d;
            final boolean out = loggedOut;
            final boolean changed = elsewhere;
            MAIN.post(() -> {
                Listener l = listener;
                if (l != null) {
                    l.onDash(result, out, changed);
                }
                if (done != null) {
                    done.run();
                }
            });
        });
    }

    /** Did the timer or the long break change somewhere else (Mac, browser)? */
    private static boolean sameState(JSONObject snap, JSONObject server) {
        JSONObject a = snap.optJSONObject("running");
        JSONObject b = server.optJSONObject("running");
        String ua = a == null ? "" : a.optString("uuid", "") + "/" + a.optLong("start");
        String ub = b == null ? "" : b.optString("uuid", "") + "/" + b.optLong("start");
        return ua.equals(ub) && snap.optLong("longBreakUntil", 0) == server.optLong("longBreakUntil", 0);
    }

    private static JSONObject stopped(JSONObject view, long at) throws JSONException {
        JSONObject v = new JSONObject(view.toString());
        v.put("running", JSONObject.NULL);
        JSONObject s = v.optJSONObject("settings");
        v.put("longBreakUntil", at + 60L * (s == null ? 15 : s.optInt("longBreakMinutes", 15)));
        return v;
    }

    /** Sends changes made from the notification (when online; kept for the page either way). */
    private static void pushOutbox(Context c, Nextcloud client, I18n t) throws Nextcloud.ApiException {
        JSONArray recs = Local.pending(c, "pushed");
        if (recs.length() == 0) {
            return;
        }
        try {
            client.api("POST", "sync", new JSONObject().put("records", recs).toString(), t);
            // Accepted, or refused for good (e.g. a timer the server doesn't know yet: the page sends it whole)
            Local.mark(c, recs, "pushed");
        } catch (Nextcloud.ApiException e) {
            if (e.status == 401) {
                throw e;
            }
            // offline: tried again at the next check
        } catch (JSONException ignored) {
            // cannot happen with records we made
        }
    }

    /** Stop tracking from the notification (works offline; syncs when it can). */
    static void stop(Context context, Runnable done) {
        final Context c = context.getApplicationContext();
        IO.execute(() -> {
            Nextcloud client = Store.client(c);
            if (client != null || Store.noServer(c)) {
                try {
                    Dash shown = last;
                    JSONObject snap = Local.snapshot(c);
                    JSONObject view = snap;
                    // The notification may show a timer started elsewhere: stop that one
                    if (shown != null && shown.running != null && shown.running.uuid != null
                            && (snap == null || snap.optJSONObject("running") == null || !shown.running.uuid.equals(snap.optJSONObject("running").optString("uuid")))) {
                        view = new JSONObject().put("running", new JSONObject().put("uuid", shown.running.uuid).put("start", shown.running.start))
                                .put("hlc", snap == null ? "" : snap.optString("hlc", ""));
                    }
                    Local.stop(c, view, System.currentTimeMillis() / 1000, false);
                    if (client != null) {
                        pushOutbox(c, client, i18n());
                    }
                } catch (JSONException | Nextcloud.ApiException ignored) {
                    // the refresh shows the real state
                }
            }
            refresh(c, () -> {
                Listener l = listener;
                if (l != null) {
                    l.onDash(last, false, true);
                }
                if (done != null) {
                    done.run();
                }
            });
        });
    }

    static void clearAll(Context context) {
        Context c = context.getApplicationContext();
        last = null;
        serverEvents = new ArrayList<>();
        c.getSystemService(NotificationManager.class).cancelAll();
        schedule(c, null);
    }

    // --- what the notification shows -----------------------------------------------------------

    /**
     * @param view the snapshot or the server's state: running, settings, longBreakUntil, commitments
     * @param server the server's state if online (its calendar list, for blocks the phone doesn't have)
     */
    static Dash build(Context c, JSONObject view, JSONObject server, Nextcloud client, I18n t) throws JSONException {
        if (view == null) {
            return null;
        }
        Dash d = parse(view);
        long now = System.currentTimeMillis() / 1000;
        long from = now - 86400;
        long to = now + 14 * 86400;
        JSONArray list = view.optJSONArray("commitments");
        List<String> urls = new ArrayList<>();
        Map<Long, String> urlOf = new HashMap<>();
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject o = list.getJSONObject(i);
            String u = o.optString("calendarUrl", "");
            if (!u.isEmpty() && !"null".equals(u)) {
                urls.add(u);
                urlOf.put(o.getLong("id"), u);
            }
        }
        // The built-in calendar (on this phone only): its blocks come with the snapshot
        JSONArray own = view.optJSONArray("blocks");
        if (own != null) {
            List<Calendars.Event> events = new ArrayList<>();
            for (int i = 0; i < own.length() && i < 2000; i++) {
                JSONObject b = own.optJSONObject(i);
                if (b == null || b.optLong("end") <= b.optLong("start")) {
                    continue;
                }
                Calendars.Event ev = new Calendars.Event();
                ev.uid = b.optString("uid", "");
                ev.title = b.optString("title", "");
                ev.start = b.optLong("start");
                ev.end = b.optLong("end");
                ev.url = BUILTIN + b.optLong("commitmentId");
                events.add(ev);
            }
            urlOf.clear();
            for (Dash.Entry e : d.commitments) {
                urlOf.put(e.commitmentId, BUILTIN + e.commitmentId);
            }
            return withBlocks(d, events, urlOf, now);
        }
        List<Calendars.Event> events = Calendars.events(c, from, to, urls);
        // Calendars not on the phone (no DAVx5): the server's blocks, when online
        List<String> missing = new ArrayList<>();
        List<Calendars.Cal> phone = Calendars.list(c);
        for (String u : urls) {
            boolean found = false;
            for (Calendars.Cal cal : phone) {
                found |= CalendarPath.same(cal.url, u);
            }
            if (!found) {
                missing.add(u);
            }
        }
        if (!missing.isEmpty() && (server == null || client == null)) {
            // offline, or right after a change here: the server's blocks fetched last time
            for (Calendars.Event ev : serverEvents) {
                for (String m : missing) {
                    if (CalendarPath.same(ev.url, m)) {
                        events.add(ev);
                    }
                }
            }
        }
        if (!missing.isEmpty() && server != null && client != null) {
            Map<Long, String> calUrl = new HashMap<>();
            JSONArray cals = server.optJSONArray("calendars");
            for (int i = 0; cals != null && i < cals.length(); i++) {
                JSONObject cal = cals.getJSONObject(i);
                calUrl.put(cal.getLong("id"), cal.optString("url", ""));
            }
            try {
                JSONArray blocks = new JSONObject(client.api("GET", "blocks?from=" + from + "&to=" + to, null, t)).optJSONArray("blocks");
                List<Calendars.Event> fetched = new ArrayList<>();
                for (int i = 0; blocks != null && i < blocks.length(); i++) {
                    JSONObject b = blocks.getJSONObject(i);
                    String u = calUrl.get(b.optLong("calendarId"));
                    for (String m : missing) {
                        if (u != null && CalendarPath.same(u, m)) {
                            Calendars.Event ev = new Calendars.Event();
                            ev.uid = b.optString("uid", "");
                            ev.title = b.optString("title", "");
                            ev.start = b.getLong("start");
                            ev.end = b.getLong("end");
                            ev.url = m;
                            events.add(ev);
                            fetched.add(ev);
                        }
                    }
                }
                serverEvents = fetched;
            } catch (Nextcloud.ApiException ignored) {
                // offline: blocks from the phone only
            }
        }
        return withBlocks(d, events, urlOf, now);
    }

    /** "blockwise:<commitment id>": the built-in calendar's blocks in the snapshot */
    private static final String BUILTIN = "blockwise:";

    /** Each commitment's current and next block. */
    private static Dash withBlocks(Dash d, List<Calendars.Event> events, Map<Long, String> urlOf, long now) {
        Collections.sort(events, (a, b) -> Long.compare(a.start, b.start));
        for (Dash.Entry e : d.commitments) {
            String u = urlOf.get(e.commitmentId);
            if (u == null) {
                continue;
            }
            for (Calendars.Event ev : events) {
                if (!(u.startsWith(BUILTIN) ? u.equals(ev.url) : CalendarPath.same(ev.url, u)) || ev.end <= now) {
                    continue;
                }
                if (ev.start <= now) {
                    e.currentBlock = block(ev);
                } else if (e.nextBlock == null) {
                    e.nextBlock = block(ev);
                    break;
                }
            }
        }
        return d;
    }

    private static Dash.Block block(Calendars.Event ev) {
        Dash.Block b = new Dash.Block();
        b.uid = ev.uid;
        b.title = ev.title;
        b.start = ev.start;
        b.end = ev.end;
        return b;
    }

    // --- JSON -> core model -------------------------------------------------------------------

    static Dash parse(JSONObject j) throws JSONException {
        Dash d = new Dash();
        JSONObject s = j.optJSONObject("settings");
        if (s != null) {
            d.settings.focusMinutes = s.optInt("focusMinutes", 25);
            d.settings.shortBreakMinutes = s.optInt("shortBreakMinutes", 5);
            d.settings.longBreakMinutes = s.optInt("longBreakMinutes", 15);
            d.settings.sessionsBeforeLongBreak = s.optInt("sessionsBeforeLongBreak", 4);
            d.settings.reminderMinutes = s.optInt("reminderMinutes", 15);
        }
        JSONObject r = j.optJSONObject("running");
        if (r != null) {
            d.running = new Dash.Running();
            d.running.id = r.optLong("id", 0);
            d.running.uuid = r.optString("uuid", "").isEmpty() ? null : r.optString("uuid");
            d.running.commitmentId = r.isNull("commitmentId") ? null : r.getLong("commitmentId");
            d.running.start = r.getLong("start");
            d.running.pomodoro = r.optInt("pomodoro", 0) == 1 || r.optBoolean("pomodoro", false);
        }
        d.longBreakUntil = j.isNull("longBreakUntil") || !j.has("longBreakUntil") ? null : j.getLong("longBreakUntil");
        JSONArray list = j.optJSONArray("commitments");
        if (list != null) {
            for (int i = 0; i < list.length(); i++) {
                JSONObject o = list.getJSONObject(i);
                JSONObject c = o.has("commitment") ? o.getJSONObject("commitment") : o;
                Dash.Entry e = new Dash.Entry();
                e.commitmentId = c.getLong("id");
                e.name = c.optString("name", "");
                e.color = c.optString("color", "#0082c9");
                d.commitments.add(e);
            }
        }
        return d;
    }

    // --- notifications ---------------------------------------------------------------------------

    private static PendingIntent openApp(Context c) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static PendingIntent broadcast(Context c, String action, int code) {
        Intent i = new Intent(c, TrackingReceiver.class).setAction(action);
        return PendingIntent.getBroadcast(c, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** The ongoing notification: what you track and a running clock, with Stop. */
    static void showTimer(Context c, Dash d) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        long now = System.currentTimeMillis() / 1000;
        I18n t = i18n();
        Alerts.Status st = Alerts.status(d, now, t);
        if (st == null || !canNotify(c)) {
            nm.cancel(ID_TIMER);
            return;
        }
        ensureChannels(c);
        int color = Color.parseColor("#0B67C9");
        if (d.running != null) {
            Dash.Entry e = d.entry(d.running.commitmentId);
            if (e != null) {
                try {
                    color = Color.parseColor(e.color);
                } catch (IllegalArgumentException ignored) {
                    // keep the default
                }
            }
        }
        Notification.Builder b = new Notification.Builder(c, CH_TIMER)
                .setSmallIcon(R.drawable.ic_stat_tracker)
                .setContentTitle(st.title)
                .setContentText(st.text)
                .setColor(color)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(true)
                .setUsesChronometer(true)
                .setChronometerCountDown(st.countDown)
                .setWhen(st.when * 1000)
                // The lock screen shows only "Tracking", not what you work on
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(new Notification.Builder(c, CH_TIMER)
                        .setSmallIcon(R.drawable.ic_stat_tracker)
                        .setContentTitle(t.t("Tracking"))
                        .setUsesChronometer(true)
                        .setChronometerCountDown(st.countDown)
                        .setWhen(st.when * 1000)
                        .build())
                .setContentIntent(openApp(c));
        if (Build.VERSION.SDK_INT >= 31) {
            b.setCategory(Notification.CATEGORY_STOPWATCH);
        }
        if (d.running != null) {
            b.addAction(new Notification.Action.Builder(Icon.createWithResource(c, R.drawable.ic_stop), t.t("Stop"), broadcast(c, ACTION_STOP, 1)).build());
            // Stays while you track: swiped away (Android 14+ allows it), it comes back
            b.setDeleteIntent(broadcast(c, ACTION_DISMISSED, 3));
            promote(b);
        }
        nm.notify(ID_TIMER, b.build());
    }

    /**
     * Android 16: a "live update", the running timer as a chip in the status bar,
     * on every screen. Asked for by name, so older Android versions (and builds
     * without these methods) simply keep the ordinary notification.
     */
    private static void promote(Notification.Builder b) {
        if (Build.VERSION.SDK_INT < 36) {
            return;
        }
        try {
            Notification.Builder.class.getMethod("setRequestPromotedOngoing", boolean.class).invoke(b, true);
        } catch (ReflectiveOperationException e) {
            try {
                int flag = Notification.class.getField("FLAG_PROMOTED_ONGOING").getInt(null);
                Notification.Builder.class.getMethod("setFlag", int.class, boolean.class).invoke(b, flag, true);
            } catch (ReflectiveOperationException ignored) {
                // no live updates on this phone: the ordinary notification
            }
        }
    }

    private static void notifyAlert(Context c, Alerts.Notice n) {
        notifyText(c, n.key, n.title, n.body);
    }

    private static void notifyText(Context c, String key, String title, String body) {
        if (!canNotify(c)) {
            return;
        }
        ensureChannels(c);
        Notification n = new Notification.Builder(c, CH_ALERTS)
                .setSmallIcon(R.drawable.ic_stat_tracker)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_REMINDER)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(new Notification.Builder(c, CH_ALERTS)
                        .setSmallIcon(R.drawable.ic_stat_tracker)
                        .setContentTitle(i18n().t("Blockwise"))
                        .setContentText(i18n().t("Reminders"))
                        .build())
                .setContentIntent(openApp(c))
                .build();
        c.getSystemService(NotificationManager.class).notify(("alert-" + key).hashCode(), n);
    }

    static boolean canNotify(Context c) {
        if (Build.VERSION.SDK_INT >= 33
                && c.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        return c.getSystemService(NotificationManager.class).areNotificationsEnabled();
    }

    // --- waking up when something is due ---------------------------------------------------------

    static boolean canExactAlarms(Context c) {
        return Build.VERSION.SDK_INT < 31 || c.getSystemService(AlarmManager.class).canScheduleExactAlarms();
    }

    static void schedule(Context c, Dash d) {
        AlarmManager am = c.getSystemService(AlarmManager.class);
        PendingIntent pi = broadcast(c, ACTION_CHECK, 2);
        Long at = Alerts.nextCheckAt(d, System.currentTimeMillis() / 1000);
        if (at == null) {
            am.cancel(pi);
            return;
        }
        long when = at * 1000 + 1000;
        try {
            if (canExactAlarms(c)) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
            } else {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
            }
        } catch (SecurityException e) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
        }
    }
}
