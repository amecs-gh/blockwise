package app.tracker.android;

import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import app.tracker.core.ApiGuard;
import app.tracker.core.I18n;
import app.tracker.core.ServerUrl;

/**
 * What the app's own page may ask the app to do (window.TrackerAndroid, see
 * assets/android-bridge.js). Answers go back as {"data": ...} or
 * {"error": "...", "status": n}.
 *
 * Blockwise runs in the page (local-first, js/engine.js); the app gives it
 * encrypted storage, the phone's calendars, and the server's sync endpoints.
 * The page never sees the password: server requests are made here, and only
 * to the sync endpoints (ApiGuard).
 */
public final class Bridge {
    /** The page's requests: a page loads several at once, so up to four run in parallel. */
    private static final ExecutorService PAGE_IO = Executors.newFixedThreadPool(4);
    /** Saving the page's data: one at a time, in order. */
    private static final ExecutorService SAVE = Executors.newSingleThreadExecutor();
    private static final int MAX_DB = 50 * 1024 * 1024;

    private final MainActivity activity;

    Bridge(MainActivity activity) {
        this.activity = activity;
    }

    /** Called by the page on WebView's bridge thread. */
    @JavascriptInterface
    public void call(final String id, final String channel, final String argsJson) {
        activity.runOnUiThread(() -> {
            // Only the app's own pages (file:///android_asset/) may use the bridge
            if (!activity.showsOwnPage()) {
                reply(id, error("Not allowed.", 0));
                return;
            }
            JSONArray args;
            try {
                args = new JSONArray(argsJson == null ? "[]" : argsJson);
            } catch (JSONException e) {
                reply(id, error(i18n().t("Invalid request."), 0));
                return;
            }
            dispatch(id, channel == null ? "" : channel, args);
        });
    }

    private static I18n i18n() {
        return I18n.forLocale(Locale.getDefault());
    }

    private void dispatch(String id, String channel, JSONArray args) {
        switch (channel) {
            case "state":
                reply(id, data(activity.publicState()));
                break;
            case "remote":
                remote(id, args);
                break;
            case "dbLoad":
                background(id, () -> {
                    String db = Vault.read(activity, Vault.DB);
                    if (db == null && Vault.unreadable(Vault.DB)) {
                        // Don't start empty (and overwrite unsynced changes): the page tries again
                        throw new IllegalStateException("Keystore not available");
                    }
                    return db;
                });
                break;
            case "dbSave":
                dbSave(id, args.optString(0, ""));
                break;
            case "snapshot":
                snapshot(id, args.optJSONObject(0));
                break;
            case "outbox":
                background(id, () -> Local.pending(activity, "imported"));
                break;
            case "outboxDone": {
                final JSONArray recs = args.optJSONArray(0);
                background(id, () -> {
                    if (recs != null) {
                        Local.mark(activity, recs, "imported");
                    }
                    return null;
                });
                break;
            }
            case "calendars":
                background(id, () -> Calendars.listJson(activity));
                break;
            case "events":
                events(id, args);
                break;
            case "createEvent":
                createEvent(id, args.optJSONObject(0));
                break;
            case "calendarAccess":
                activity.askForCalendar(granted -> reply(id, data(granted)));
                break;
            case "refresh":
                Tracking.refresh(activity, null);
                reply(id, data(null));
                break;
            case "login":
                login(id, args.optString(0, ""));
                break;
            case "useLocal":
                activity.useLocal();
                reply(id, data(null));
                break;
            case "connect":
                activity.showConnect();
                reply(id, data(null));
                break;
            case "backToApp":
                activity.backToApp();
                reply(id, data(null));
                break;
            case "takeResend":
                background(id, () -> Store.takeResend(activity));
                break;
            case "cancelLogin":
                activity.cancelLogin();
                reply(id, data(null));
                break;
            case "openCalendar":
                activity.openCalendar(args.isNull(0) ? null : args.optLong(0));
                reply(id, data(null));
                break;
            case "account":
                activity.showAccount();
                reply(id, data(null));
                break;
            default:
                reply(id, error(i18n().t("Invalid request."), 0));
        }
    }

    interface Work {
        Object run() throws Exception;
    }

    /** Runs `work` off the main thread and replies with its result. */
    private void background(String id, Work work) {
        PAGE_IO.execute(() -> {
            String r;
            try {
                r = data(work.run());
            } catch (Calendars.CalendarException e) {
                r = error(i18n().t(e.getMessage()), 0);
            } catch (Exception e) {
                r = error(i18n().t("Something went wrong."), 0);
            }
            final String result = r;
            activity.runOnUiThread(() -> reply(id, result));
        });
    }

    /** The server's sync endpoints (and read-only calendar fallback), nothing else. */
    private void remote(String id, JSONArray args) {
        final I18n t = i18n();
        final String method = args.optString(0, null);
        final String path = args.optString(1, null);
        final Object body = args.isNull(2) ? null : args.opt(2);
        if (!ApiGuard.allowed(method, path) || (body != null && !(body instanceof JSONObject)) || ("POST".equals(method) && body == null)) {
            reply(id, error(t.t("Invalid request."), 0));
            return;
        }
        final Nextcloud client = Store.client(activity);
        if (client == null) {
            reply(id, error(t.t("Not logged in."), 401));
            return;
        }
        PAGE_IO.execute(() -> {
            String result;
            try {
                String text = client.api(method, path, body == null ? null : body.toString(), t);
                result = "{\"data\":" + validJson(text) + "}";
            } catch (Nextcloud.ApiException e) {
                result = error(e.getMessage(), e.status);
                if (e.status == 401) {
                    // App password revoked in Nextcloud: back to the login screen (data not yet synced stays)
                    Store.clear(activity);
                    activity.runOnUiThread(activity::loggedOut);
                }
            }
            final String r = result;
            activity.runOnUiThread(() -> reply(id, r));
        });
    }

    private void dbSave(String id, String json) {
        if (json.isEmpty() || json.length() > MAX_DB || json.charAt(0) != '{') {
            reply(id, error(i18n().t("Invalid request."), 0));
            return;
        }
        SAVE.execute(() -> {
            Vault.write(activity, Vault.DB, json);
            activity.runOnUiThread(() -> reply(id, data(null)));
        });
    }

    /** What the notification needs; saved, then the notification is updated. */
    private void snapshot(String id, JSONObject snap) {
        if (snap == null) {
            reply(id, error(i18n().t("Invalid request."), 0));
            return;
        }
        SAVE.execute(() -> {
            Local.saveSnapshot(activity, snap);
            Tracking.refresh(activity, null, false);
            activity.runOnUiThread(() -> reply(id, data(null)));
        });
    }

    private static List<String> strings(JSONArray a) {
        List<String> out = new ArrayList<>();
        for (int i = 0; a != null && i < a.length() && i < 500; i++) {
            String s = a.optString(i, "");
            if (!s.isEmpty() && s.length() < 2048) {
                out.add(s);
            }
        }
        return out;
    }

    private void events(String id, JSONArray args) {
        final long from = args.optLong(0, 0);
        final long to = args.optLong(1, 0);
        final List<String> urls = strings(args.optJSONArray(2));
        if (to <= from || to - from > 450L * 86400) {
            reply(id, error(i18n().t("Invalid request."), 0));
            return;
        }
        background(id, () -> Calendars.eventsJson(activity, from, to, urls));
    }

    private void createEvent(String id, JSONObject ev) {
        if (ev == null) {
            reply(id, error(i18n().t("Invalid request."), 0));
            return;
        }
        final String url = ev.optString("url", "");
        final String title = ev.optString("title", "");
        final long start = ev.optLong("start", 0);
        final long end = ev.optLong("end", 0);
        if (url.isEmpty() || title.length() > 255 || end <= start || end - start > 86400) {
            reply(id, error(i18n().t("Invalid request."), 0));
            return;
        }
        activity.askForCalendar(granted -> {
            if (!granted) {
                reply(id, error(i18n().t("Blockwise may not write to your calendar."), 0));
                return;
            }
            background(id, () -> new JSONObject().put("uid", Calendars.create(activity, url, title, start, end)));
        });
    }

    /** The answer is put into the page as data: make sure it is JSON and nothing else. */
    private static String validJson(String text) {
        try {
            Object v = new JSONTokener(text).nextValue();
            if (v instanceof JSONObject || v instanceof JSONArray) {
                return v.toString();
            }
            if (v instanceof String) {
                return JSONObject.quote((String) v);
            }
            if (v instanceof Number || v instanceof Boolean) {
                return String.valueOf(v);
            }
            return "null";
        } catch (JSONException e) {
            return "null";
        }
    }

    private void login(String id, String input) {
        final I18n t = i18n();
        final String server;
        try {
            server = ServerUrl.normalize(input);
        } catch (ServerUrl.InvalidServer e) {
            reply(id, error(t.t(e.getMessage()), 0));
            return;
        }
        activity.startLogin(server, (err) -> reply(id, err == null ? data(null) : error(err, 0)));
    }

    // --- answers -----------------------------------------------------------------------------

    private static String data(Object value) {
        try {
            return new JSONObject().put("data", value == null ? JSONObject.NULL : value).toString();
        } catch (JSONException e) {
            return "{\"data\":null}";
        }
    }

    static String error(String message, int status) {
        try {
            return new JSONObject().put("error", message == null ? "Error" : message).put("status", status).toString();
        } catch (JSONException e) {
            return "{\"error\":\"Error\"}";
        }
    }

    /** Must run on the main thread. */
    private void reply(String id, String envelopeJson) {
        activity.evaluate("window.__trackerAndroid&&window.__trackerAndroid.resolve(" + JSONObject.quote(id) + "," + JSONObject.quote(envelopeJson) + ")");
    }
}
