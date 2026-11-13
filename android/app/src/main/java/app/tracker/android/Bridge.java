package app.tracker.android;

import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.util.ArrayList;
import java.util.Base64;
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

    /** Where the bridge's page runs: the app's window, or the background sync (BackgroundSync) */
    interface Host {
        void runOnUiThread(Runnable r);

        boolean showsOwnPage();

        void evaluate(String js);

        JSONObject publicState();

        /** The app password stopped working (Nextcloud) */
        void loggedOut();
    }

    /** null in the background: no windows, logins or permission requests there */
    private final MainActivity activity;
    private final Host host;
    private final android.content.Context ctx;

    Bridge(MainActivity activity) {
        this(activity, activity, activity);
    }

    Bridge(MainActivity activity, Host host, android.content.Context ctx) {
        this.activity = activity;
        this.host = host;
        this.ctx = ctx.getApplicationContext();
    }

    /** Called by the page on WebView's bridge thread. */
    @JavascriptInterface
    public void call(final String id, final String channel, final String argsJson) {
        host.runOnUiThread(() -> {
            // Only the app's own pages (file:///android_asset/) may use the bridge
            if (!host.showsOwnPage()) {
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

    /** What only the app's window can do (dialogs, logins, permissions, other apps) */
    private static final java.util.Set<String> WINDOW_ONLY = new java.util.HashSet<>(java.util.Arrays.asList(
            "calendarAccess", "createEvent", "login", "cancelLogin", "openCalendar", "calendarApp", "chooseCalendarApp", "account", "useLocal", "connect",
            "backToApp", "connectDrive", "cancelDrive", "saveDrive", "saveFile", "openFile"));
    private static final int MAX_FILE = 64 * 1024 * 1024;

    private void dispatch(String id, String channel, JSONArray args) {
        if (activity == null && WINDOW_ONLY.contains(channel)) {
            reply(id, error(i18n().t("Not allowed."), 0));
            return;
        }
        switch (channel) {
            case "state":
                reply(id, data(host.publicState()));
                break;
            case "remote":
                remote(id, args);
                break;
            case "bgDone":
                if (host instanceof BackgroundSync) {
                    ((BackgroundSync) host).done(args.optBoolean(0, false));
                }
                reply(id, data(null));
                break;
            case "dbLoad":
                background(id, () -> {
                    // A background sync is writing the data: the window reads it afterwards
                    for (int i = 0; activity != null && BackgroundSync.running && i < 1000; i++) {
                        Thread.sleep(100);
                    }
                    String db = Vault.read(ctx, Vault.DB);
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
                background(id, () -> Local.pending(ctx, "imported"));
                break;
            case "outboxDone": {
                final JSONArray recs = args.optJSONArray(0);
                background(id, () -> {
                    if (recs != null) {
                        Local.mark(ctx, recs, "imported");
                    }
                    return null;
                });
                break;
            }
            case "calendars":
                background(id, () -> Calendars.listJson(ctx));
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
                Tracking.refresh(ctx, null);
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
            case "connectDrive": {
                final String provider = args.optString(0, "");
                if (!Drives.DROPBOX.equals(provider) && !Drives.GOOGLE.equals(provider)) {
                    reply(id, error(i18n().t("Invalid request."), 0));
                    break;
                }
                activity.connectDrive(provider, (err, exists) -> reply(id, err == null ? data(exists) : error(i18n().t(err), 0)));
                break;
            }
            case "cancelDrive":
                activity.cancelDrive();
                reply(id, data(null));
                break;
            case "saveDrive": {
                final String key = args.optString(0, "");
                // A 256-bit key, base64
                if (!key.matches("^[A-Za-z0-9+/]{43}=$")) {
                    reply(id, error(i18n().t("Invalid request."), 0));
                    break;
                }
                activity.saveDrive(key, (err) -> reply(id, err == null ? data(null) : error(err, 0)));
                break;
            }
            case "drive":
                drive(id, args);
                break;
            case "driveWatch":
                driveWatch(id, args);
                break;
            case "driveKey":
                background(id, () -> Store.drive(ctx) == null ? null : Store.syncKey(ctx));
                break;
            case "driveStateLoad":
                background(id, () -> Store.drive(ctx) == null ? null : Vault.read(ctx, Vault.DRIVESTATE));
                break;
            case "driveStateSave": {
                final String st = args.optString(0, "");
                if (st.isEmpty() || st.length() > 1024 * 1024 || st.charAt(0) != '{') {
                    reply(id, error(i18n().t("Invalid request."), 0));
                    break;
                }
                SAVE.execute(() -> {
                    if (Store.drive(ctx) != null) {
                        Vault.write(ctx, Vault.DRIVESTATE, st);
                    }
                    host.runOnUiThread(() -> reply(id, data(null)));
                });
                break;
            }
            case "takeResend":
                background(id, () -> Store.takeResend(ctx));
                break;
            case "cancelLogin":
                activity.cancelLogin();
                reply(id, data(null));
                break;
            case "openCalendar":
                activity.openCalendar(args.isNull(0) ? null : args.optLong(0));
                reply(id, data(null));
                break;
            case "calendarApp":
                reply(id, data(activity.calendarAppName()));
                break;
            case "chooseCalendarApp":
                activity.chooseCalendarApp(null, () -> reply(id, data(activity.calendarAppName())));
                break;
            case "account":
                activity.showAccount();
                reply(id, data(null));
                break;
            case "saveFile": {
                final String name = args.optString(0, "");
                final String text = args.optString(1, "");
                if (text.length() > MAX_FILE) {
                    reply(id, error(i18n().t("Invalid request."), 0));
                    break;
                }
                activity.pickDocument(true, name, uri -> {
                    if (uri == null) {
                        reply(id, data(false));
                        return;
                    }
                    background(id, () -> {
                        try (java.io.OutputStream out = ctx.getContentResolver().openOutputStream(uri, "wt")) {
                            if (out == null) {
                                throw new java.io.IOException("No file");
                            }
                            out.write(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                        }
                        return true;
                    });
                });
                break;
            }
            case "openFile":
                activity.pickDocument(false, null, uri -> {
                    if (uri == null) {
                        reply(id, data(null));
                        return;
                    }
                    background(id, () -> {
                        try (java.io.InputStream in = ctx.getContentResolver().openInputStream(uri)) {
                            if (in == null) {
                                throw new java.io.IOException("No file");
                            }
                            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
                            byte[] chunk = new byte[65536];
                            for (int n; (n = in.read(chunk)) > 0; ) {
                                buf.write(chunk, 0, n);
                                if (buf.size() > MAX_FILE) {
                                    throw new java.io.IOException("Too large");
                                }
                            }
                            JSONObject file = new JSONObject();
                            file.put("name", displayName(uri));
                            file.put("text", buf.toString("UTF-8"));
                            return file;
                        }
                    });
                });
                break;
            default:
                reply(id, error(i18n().t("Invalid request."), 0));
        }
    }

    /** A picked document's file name, for the page to show */
    private String displayName(android.net.Uri uri) {
        try (android.database.Cursor c = ctx.getContentResolver().query(uri, new String[] {android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) {
                return c.getString(0);
            }
        } catch (RuntimeException ignored) {
            // no name
        }
        return "";
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
            host.runOnUiThread(() -> reply(id, result));
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
        final Nextcloud client = Store.client(ctx);
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
                    Store.clear(ctx);
                    host.runOnUiThread(host::loggedOut);
                }
            }
            final String r = result;
            host.runOnUiThread(() -> reply(id, r));
        });
    }

    /**
     * The drive's sync folder for the page's file sync (web/filesync.js): list,
     * read, write, remove. The bytes are already end-to-end encrypted by the page.
     * Errors: status 409 = the file exists (write with create), 0 = offline.
     */
    private void drive(String id, JSONArray args) {
        final String op = args.optString(0, "");
        final String name = args.optString(1, "");
        final String b64 = args.optString(2, "");
        final boolean create = args.optBoolean(3, false);
        final Drives.Folder f = MainActivity.driveFolder(ctx);
        if (f == null) {
            reply(id, error(i18n().t("Connect a drive first."), 0));
            return;
        }
        PAGE_IO.execute(() -> {
            String r;
            try {
                switch (op) {
                    case "list":
                        r = data(new JSONArray(f.list()));
                        break;
                    case "read": {
                        byte[] bytes = f.read(name);
                        r = data(bytes == null ? null : Base64.getEncoder().encodeToString(bytes));
                        break;
                    }
                    case "write":
                        f.write(name, Base64.getDecoder().decode(b64), create);
                        r = data(null);
                        break;
                    case "remove":
                        f.remove(name);
                        r = data(null);
                        break;
                    default:
                        r = error(i18n().t("Invalid request."), 0);
                }
            } catch (Drives.DriveException e) {
                r = error(e.exists ? "exists" : i18n().t(e.getMessage()), e.exists ? 409 : e.offline ? 0 : e.status);
            } catch (IllegalArgumentException e) {
                r = error(i18n().t("Invalid request."), 0);
            }
            final String result = r;
            host.runOnUiThread(() -> reply(id, result));
        });
    }

    /** Long waits for the drive's changes: their own threads, so the page's requests never queue behind them. */
    private static final ExecutorService WATCH = Executors.newFixedThreadPool(2);

    /** ["cursor"] -> the folder's change cursor; ["changes", cursor, seconds] -> {changed, cursor, retryAfter} */
    private void driveWatch(String id, JSONArray args) {
        final String op = args.optString(0, "");
        final String cursor = args.optString(1, "");
        final int seconds = args.optInt(2, 90);
        final Drives.Folder f = MainActivity.driveFolder(ctx);
        if (f == null || (!"cursor".equals(op) && !"changes".equals(op))) {
            reply(id, error(i18n().t("Invalid request."), 0));
            return;
        }
        WATCH.execute(() -> {
            String r;
            try {
                r = "cursor".equals(op) ? data(f.changeCursor()) : data(f.changes(cursor, seconds));
            } catch (Drives.DriveException e) {
                r = error(i18n().t(e.getMessage()), e.offline ? 0 : e.status);
            }
            final String result = r;
            host.runOnUiThread(() -> reply(id, result));
        });
    }

    private void dbSave(String id, String json) {
        if (json.isEmpty() || json.length() > MAX_DB || json.charAt(0) != '{') {
            reply(id, error(i18n().t("Invalid request."), 0));
            return;
        }
        SAVE.execute(() -> {
            // Never at the same time as a background sync (the app's page reloads after one)
            for (int i = 0; activity != null && BackgroundSync.running && i < 1000; i++) {
                try {
                    Thread.sleep(100);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            Vault.write(ctx, Vault.DB, json);
            host.runOnUiThread(() -> reply(id, data(null)));
        });
    }

    /** What the notification needs; saved, then the notification is updated. */
    private void snapshot(String id, JSONObject snap) {
        if (snap == null) {
            reply(id, error(i18n().t("Invalid request."), 0));
            return;
        }
        SAVE.execute(() -> {
            Local.saveSnapshot(ctx, snap);
            Tracking.refresh(ctx, null, false);
            host.runOnUiThread(() -> reply(id, data(null)));
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
        background(id, () -> Calendars.eventsJson(ctx, from, to, urls));
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
            background(id, () -> new JSONObject().put("uid", Calendars.create(ctx, url, title, start, end)));
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
        host.evaluate("window.__trackerAndroid&&window.__trackerAndroid.resolve(" + JSONObject.quote(id) + "," + JSONObject.quote(envelopeJson) + ")");
    }
}
