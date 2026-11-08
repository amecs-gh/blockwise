package app.tracker.android;

import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import app.tracker.core.ApiGuard;
import app.tracker.core.I18n;
import app.tracker.core.ServerUrl;

/**
 * What the app's own page may ask the app to do (window.TrackerAndroid, see
 * assets/android-bridge.js). Answers go back as {"data": ...} or
 * {"error": "...", "status": n}. The page never sees the password: API
 * requests are made here, and only to Tracker's own API.
 */
public final class Bridge {
    /** The page's requests: a page loads several at once, so up to four run in parallel. */
    private static final ExecutorService PAGE_IO = Executors.newFixedThreadPool(4);

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
            case "api":
                api(id, args);
                break;
            case "refresh":
                Tracking.refresh(activity, null);
                reply(id, data(null));
                break;
            case "login":
                login(id, args.optString(0, ""));
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

    private void api(String id, JSONArray args) {
        final I18n t = i18n();
        final String method = args.optString(0, null);
        final String path = args.optString(1, null);
        final Object body = args.isNull(2) ? null : args.opt(2);
        if (!ApiGuard.allowed(method, path) || (body != null && !(body instanceof JSONObject))) {
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
                    // App password revoked in Nextcloud: forget it, back to the login screen
                    Store.clear(activity);
                    activity.runOnUiThread(activity::loggedOut);
                }
            }
            final String r = result;
            activity.runOnUiThread(() -> reply(id, r));
            if (!"GET".equals(method)) {
                // Started, stopped or changed something: update the notification
                Tracking.refresh(activity, null);
            }
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
