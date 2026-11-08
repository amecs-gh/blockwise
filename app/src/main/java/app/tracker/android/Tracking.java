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

import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import app.tracker.core.Alerts;
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

    /** One background thread for all network work, so requests stay in order. */
    static final ExecutorService IO = Executors.newSingleThreadExecutor();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** Told after each refresh (MainActivity, to reload the page when something changed elsewhere). */
    interface Listener {
        void onDash(Dash dash, boolean loggedOut);
    }

    static volatile Listener listener;
    private static volatile Dash last;

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
     * Fetches /api/dashboard in the background, updates the notification, shows
     * due reminders, stops at the long break, and schedules the next check.
     * `done` (may be null) runs on the main thread afterwards.
     */
    static void refresh(Context context, Runnable done) {
        final Context c = context.getApplicationContext();
        IO.execute(() -> {
            boolean loggedOut = false;
            Dash d = null;
            Nextcloud client = Store.client(c);
            if (client != null) {
                I18n t = i18n();
                try {
                    d = parse(new JSONObject(client.api("GET", "dashboard", null, t)));
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
                        try {
                            client.api("POST", "sessions/stop", new JSONObject().put("at", a.stopAt).put("longBreak", true).toString(), t);
                        } catch (Nextcloud.ApiException ignored) {
                            // tried again at the next check
                        }
                        d = parse(new JSONObject(client.api("GET", "dashboard", null, t)));
                    } else if (a.clearLongBreak) {
                        d = parse(new JSONObject(client.api("GET", "dashboard", null, t)));
                    }
                } catch (Nextcloud.ApiException e) {
                    if (e.status == 401) {
                        // App password revoked in Nextcloud: back to the login screen
                        Store.clear(c);
                        loggedOut = true;
                        if (Store.notifications(c)) {
                            notifyText(c, "relogin", t.t("Log in again"), t.t("Nextcloud rejected the app password. Log in again."));
                        }
                    }
                    d = last; // offline: keep showing what we know
                } catch (JSONException e) {
                    d = last;
                }
            }
            last = d;
            showTimer(c, client == null || loggedOut ? null : d);
            schedule(c, client == null || loggedOut ? null : d);
            final Dash result = d;
            final boolean out = loggedOut;
            MAIN.post(() -> {
                Listener l = listener;
                if (l != null) {
                    l.onDash(result, out);
                }
                if (done != null) {
                    done.run();
                }
            });
        });
    }

    /** Stop tracking from the notification. */
    static void stop(Context context, Runnable done) {
        final Context c = context.getApplicationContext();
        IO.execute(() -> {
            Nextcloud client = Store.client(c);
            if (client != null) {
                try {
                    client.api("POST", "sessions/stop", "{}", i18n());
                } catch (Nextcloud.ApiException ignored) {
                    // the refresh shows the real state
                }
            }
            refresh(c, done);
        });
    }

    static void clearAll(Context context) {
        Context c = context.getApplicationContext();
        last = null;
        c.getSystemService(NotificationManager.class).cancelAll();
        schedule(c, null);
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
            d.running.id = r.getLong("id");
            d.running.commitmentId = r.isNull("commitmentId") ? null : r.getLong("commitmentId");
            d.running.start = r.getLong("start");
            d.running.pomodoro = r.optInt("pomodoro", 0) == 1 || r.optBoolean("pomodoro", false);
        }
        d.longBreakUntil = j.isNull("longBreakUntil") || !j.has("longBreakUntil") ? null : j.getLong("longBreakUntil");
        JSONArray list = j.optJSONArray("commitments");
        if (list != null) {
            for (int i = 0; i < list.length(); i++) {
                JSONObject o = list.getJSONObject(i);
                JSONObject c = o.getJSONObject("commitment");
                Dash.Entry e = new Dash.Entry();
                e.commitmentId = c.getLong("id");
                e.name = c.optString("name", "");
                e.color = c.optString("color", "#0082c9");
                e.currentBlock = block(o.optJSONObject("currentBlock"));
                e.nextBlock = block(o.optJSONObject("nextBlock"));
                d.commitments.add(e);
            }
        }
        return d;
    }

    private static Dash.Block block(JSONObject o) throws JSONException {
        if (o == null) {
            return null;
        }
        Dash.Block b = new Dash.Block();
        b.uid = o.optString("uid", "");
        b.title = o.optString("title", "");
        b.start = o.getLong("start");
        b.end = o.getLong("end");
        return b;
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
        }
        nm.notify(ID_TIMER, b.build());
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
