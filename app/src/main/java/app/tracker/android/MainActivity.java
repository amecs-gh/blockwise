package app.tracker.android;

import android.Manifest;
import android.app.Activity;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONException;
import org.json.JSONObject;

import app.tracker.core.Dash;
import app.tracker.core.I18n;
import app.tracker.core.Vars;

/**
 * The app: Tracker's interface (the same code as in Nextcloud and the Mac app)
 * in a WebView, loaded from the app itself. It talks to Nextcloud only through
 * the bridge, never directly, and can't navigate anywhere else.
 */
public final class MainActivity extends Activity implements Tracking.Listener {
    static final String ASSETS = "file:///android_asset/";
    private static final String APP_PAGE = ASSETS + "app.html";
    private static final String SETUP_PAGE = ASSETS + "setup.html";

    private WebView web;
    private boolean appPage;
    private OnBackInvokedCallback backCallback;

    // Login in progress (only one at a time)
    private static volatile Nextcloud.LoginFlow flow;

    interface Done {
        /** @param error null on success */
        void done(String error);
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Tracking.ensureChannels(this);
        edgeToEdge(this);
        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.page));
        watchInsets(web);
        configure(web);
        web.addJavascriptInterface(new Bridge(this), "TrackerAndroid");
        setContentView(web);
        if (Build.VERSION.SDK_INT >= 33) {
            backCallback = this::goBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }
        loadPage();
    }

    @Override
    protected void onResume() {
        super.onResume();
        Tracking.listener = this;
        if (Store.loggedIn(this)) {
            if (!appPage) {
                loadPage();
            } else {
                // Changes made in the browser or on the Mac while you were away
                emit("changed", null);
            }
            Tracking.refresh(this, null);
        } else if (appPage) {
            loadPage();
        }
    }

    @Override
    protected void onPause() {
        if (Tracking.listener == this) {
            Tracking.listener = null;
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        }
        if (web != null) {
            web.removeJavascriptInterface("TrackerAndroid");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /**
     * Android 12 and older. From Android 13 on, back (button and predictive
     * gesture) goes to the OnBackInvokedCallback registered in onCreate
     * (enableOnBackInvokedCallback is on in the manifest).
     */
    @Override
    @SuppressWarnings("deprecation")
    @SuppressLint("GestureBackNavigation")
    public void onBackPressed() {
        goBack();
    }

    private void goBack() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            moveTaskToBack(true);
        }
    }

    @Override
    public void onDash(Dash dash, boolean loggedOut, boolean changedElsewhere) {
        if (loggedOut) {
            loggedOut();
        } else if (changedElsewhere && appPage) {
            // Timer stopped from the notification, or changed on another device: the page syncs
            emit("changed", null);
        }
    }

    // --- calendar permission ---------------------------------------------------------------

    interface Granted {
        void done(boolean granted);
    }

    private static final int REQ_CALENDAR = 2;
    private final java.util.List<Granted> calendarWaiting = new java.util.ArrayList<>();

    /** Asks for calendar access once (blocks come from the phone's calendars, offline too). */
    void askForCalendar(Granted cb) {
        if (Calendars.canRead(this) && Calendars.canWrite(this)) {
            cb.done(true);
            return;
        }
        calendarWaiting.add(cb);
        if (calendarWaiting.size() == 1) {
            requestPermissions(new String[] {Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR}, REQ_CALENDAR);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQ_CALENDAR) {
            return;
        }
        boolean granted = Calendars.canRead(this) && Calendars.canWrite(this);
        java.util.List<Granted> waiting = new java.util.ArrayList<>(calendarWaiting);
        calendarWaiting.clear();
        for (Granted g : waiting) {
            g.done(granted);
        }
        if (granted) {
            emit("changed", null);
            Tracking.refresh(this, null);
        }
    }

    // --- the WebView -------------------------------------------------------------------------

    private void loadPage() {
        appPage = Store.loggedIn(this);
        web.clearHistory();
        web.loadUrl(appPage ? APP_PAGE + "#now" : SETUP_PAGE);
    }

    /** Is the WebView showing one of the app's own pages? (Main thread only.) */
    boolean showsOwnPage() {
        String url = web == null ? null : web.getUrl();
        return url != null && url.startsWith(ASSETS);
    }

    void evaluate(String js) {
        if (web != null) {
            web.evaluateJavascript(js, null);
        }
    }

    /** Sends an event to the page (window.__trackerAndroid.emit). */
    void emit(String channel, String payloadJson) {
        evaluate("window.__trackerAndroid&&window.__trackerAndroid.emit(" + JSONObject.quote(channel) + ","
                + (payloadJson == null ? "null" : JSONObject.quote(payloadJson)) + ")");
    }

    @SuppressLint("SetJavaScriptEnabled") // the interface is JavaScript; it only ever loads the app's own files
    private void configure(WebView w) {
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // Only the app's own assets: no files, no content providers, no popups
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setGeolocationEnabled(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith(ASSETS)) {
                    return false;
                }
                openLink(url);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (url != null && url.startsWith(ASSETS)) {
                    applyTheme();
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The page's process crashed or was reclaimed: start fresh
                recreate();
                return true;
            }
        });
        w.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                request.deny(); // no camera, microphone, ...
            }
        });
    }

    /** Only web links leave the app, and only to the browser. */
    void openLink(String url) {
        Uri u = Uri.parse(url);
        if (!"https".equals(u.getScheme()) && !"http".equals(u.getScheme())) {
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException ignored) {
            // no browser
        }
    }

    // --- edge to edge ------------------------------------------------------------------------

    /** Android 11+: the page goes under the status and navigation bars, padded by fitBars. */
    static void edgeToEdge(Activity a) {
        if (Build.VERSION.SDK_INT >= 30) {
            a.getWindow().setDecorFitsSystemWindows(false);
            // The page paints the bars' background itself (top app bar, navigation bar)
            a.getWindow().setStatusBarColor(Color.TRANSPARENT);
            a.getWindow().setNavigationBarColor(Color.TRANSPARENT);
            a.getWindow().setNavigationBarContrastEnforced(false);
        }
    }

    /** Keeps the content clear of the bars, notches and the keyboard. */
    static void fitBars(View v) {
        v.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            }
            return insets;
        });
    }

    // --- Material 3: colors and bars for the page -----------------------------------------

    /** Space taken by the status bar, notch and gesture bar, in CSS pixels. */
    private final float[] insetsCss = new float[4]; // top, right, bottom, left

    /**
     * Android 11+: the page draws under the bars (edge to edge) and gets their
     * sizes as CSS variables; only the keyboard pushes the page up.
     */
    private void watchInsets(View v) {
        v.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                float d = getResources().getDisplayMetrics().density;
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                boolean keyboard = ime.bottom > bars.bottom;
                view.setPadding(0, 0, 0, keyboard ? ime.bottom : 0);
                insetsCss[0] = bars.top / d;
                insetsCss[1] = bars.right / d;
                insetsCss[2] = keyboard ? 0 : bars.bottom / d;
                insetsCss[3] = bars.left / d;
                applyTheme();
            }
            return insets;
        });
    }

    private boolean dark() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    private String hex(int colorRes) {
        return String.format("#%06x", getColor(colorRes) & 0xffffff);
    }

    /**
     * Material You (Android 12+): the color roles from your wallpaper's palette,
     * following Material 3's mapping of tones to roles. Null before Android 12.
     */
    private JSONObject dynamicColors(boolean dark) throws JSONException {
        if (Build.VERSION.SDK_INT < 31) {
            return null;
        }
        JSONObject c = new JSONObject();
        if (dark) {
            c.put("primary", hex(android.R.color.system_accent1_200))
                    .put("onPrimary", hex(android.R.color.system_accent1_800))
                    .put("primaryContainer", hex(android.R.color.system_accent1_700))
                    .put("onPrimaryContainer", hex(android.R.color.system_accent1_100))
                    .put("secondaryContainer", hex(android.R.color.system_accent2_700))
                    .put("onSecondaryContainer", hex(android.R.color.system_accent2_100))
                    .put("tertiaryContainer", hex(android.R.color.system_accent3_700))
                    .put("onTertiaryContainer", hex(android.R.color.system_accent3_100))
                    .put("surface", hex(android.R.color.system_neutral1_900))
                    .put("surfaceContainerLow", hex(android.R.color.system_neutral1_900))
                    .put("surfaceContainer", hex(android.R.color.system_neutral1_800))
                    .put("surfaceContainerHigh", hex(android.R.color.system_neutral1_800))
                    .put("surfaceContainerHighest", hex(android.R.color.system_neutral1_700))
                    .put("onSurface", hex(android.R.color.system_neutral1_100))
                    .put("onSurfaceVariant", hex(android.R.color.system_neutral2_200))
                    .put("outline", hex(android.R.color.system_neutral2_400))
                    .put("outlineVariant", hex(android.R.color.system_neutral2_700))
                    .put("inverseSurface", hex(android.R.color.system_neutral1_100))
                    .put("inverseOnSurface", hex(android.R.color.system_neutral1_800));
        } else {
            c.put("primary", hex(android.R.color.system_accent1_600))
                    .put("onPrimary", hex(android.R.color.system_accent1_0))
                    .put("primaryContainer", hex(android.R.color.system_accent1_100))
                    .put("onPrimaryContainer", hex(android.R.color.system_accent1_900))
                    .put("secondaryContainer", hex(android.R.color.system_accent2_100))
                    .put("onSecondaryContainer", hex(android.R.color.system_accent2_900))
                    .put("tertiaryContainer", hex(android.R.color.system_accent3_100))
                    .put("onTertiaryContainer", hex(android.R.color.system_accent3_900))
                    .put("surface", hex(android.R.color.system_neutral1_10))
                    .put("surfaceContainerLow", hex(android.R.color.system_neutral1_10))
                    .put("surfaceContainer", hex(android.R.color.system_neutral1_50))
                    .put("surfaceContainerHigh", hex(android.R.color.system_neutral1_100))
                    .put("surfaceContainerHighest", hex(android.R.color.system_neutral1_100))
                    .put("onSurface", hex(android.R.color.system_neutral1_900))
                    .put("onSurfaceVariant", hex(android.R.color.system_neutral2_700))
                    .put("outline", hex(android.R.color.system_neutral2_500))
                    .put("outlineVariant", hex(android.R.color.system_neutral2_200))
                    .put("inverseSurface", hex(android.R.color.system_neutral1_800))
                    .put("inverseOnSurface", hex(android.R.color.system_neutral1_50));
        }
        return c;
    }

    /** Tells the page: light/dark, wallpaper colors, bar sizes (android-bridge.js). */
    void applyTheme() {
        if (web == null || !showsOwnPage()) {
            return;
        }
        try {
            boolean dark = dark();
            JSONObject colors = dynamicColors(dark);
            JSONObject theme = new JSONObject()
                    .put("dark", dark)
                    .put("colors", colors == null ? JSONObject.NULL : colors)
                    .put("insets", new JSONObject()
                            .put("top", (double) insetsCss[0])
                            .put("right", (double) insetsCss[1])
                            .put("bottom", (double) insetsCss[2])
                            .put("left", (double) insetsCss[3]));
            evaluate("window.__trackerAndroidTheme&&window.__trackerAndroidTheme(" + theme + ")");
        } catch (JSONException ignored) {
            // can't happen with these values
        }
    }

    // --- what the bridge asks for ------------------------------------------------------------

    JSONObject publicState() {
        JSONObject o = new JSONObject();
        try {
            String server = Store.server(this);
            o.put("platform", "android")
                    .put("locale", getResources().getConfiguration().getLocales().get(0).toLanguageTag())
                    .put("server", server == null ? JSONObject.NULL : server)
                    .put("host", server == null ? JSONObject.NULL : Nextcloud.host(server))
                    .put("loginName", Store.loginName(this) == null ? JSONObject.NULL : Store.loginName(this))
                    .put("notifications", Store.notifications(this));
        } catch (JSONException ignored) {
            // can't happen with these values
        }
        return o;
    }

    void openCalendar(Long ts) {
        long ms = ts == null ? System.currentTimeMillis() : ts * 1000;
        Uri uri = Uri.parse("content://com.android.calendar/time/" + ms);
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, Tracking.i18n().t("No calendar app found."), Toast.LENGTH_SHORT).show();
        }
    }

    void startLogin(String server, Done done) {
        final I18n t = Tracking.i18n();
        cancelLogin();
        new Thread(() -> {
            Nextcloud.LoginFlow f;
            try {
                f = Nextcloud.startLoginFlow(server, t);
            } catch (Nextcloud.ApiException e) {
                final String msg = e.getMessage();
                runOnUiThread(() -> done.done(msg));
                return;
            }
            flow = f;
            runOnUiThread(() -> startActivity(new Intent(this, LoginActivity.class)
                    .putExtra(LoginActivity.EXTRA_URL, f.loginUrl)
                    .putExtra(LoginActivity.EXTRA_SERVER, f.server)));
            try {
                String[] cred = Nextcloud.poll(f, t);
                boolean sealed = Store.saveLogin(this, f.server, cred[0], cred[1]);
                runOnUiThread(() -> {
                    flow = null;
                    LoginActivity.closeAll();
                    if (!sealed) {
                        new AlertDialog.Builder(this)
                                .setTitle(t.t("Tracker could not use the Android Keystore"))
                                .setMessage(t.t("You stay logged in until you close Tracker; the password is not saved."))
                                .setPositiveButton(t.t("Close"), null)
                                .show();
                    }
                    done.done(null);
                    loadPage();
                    askForNotifications();
                    Tracking.refresh(this, null);
                });
            } catch (Nextcloud.ApiException e) {
                final String msg = e.getMessage();
                runOnUiThread(() -> {
                    if (flow == f) {
                        flow = null;
                    }
                    LoginActivity.closeAll();
                    done.done(msg);
                });
            }
        }, "tracker-login").start();
    }

    void cancelLogin() {
        Nextcloud.LoginFlow f = flow;
        if (f != null) {
            f.cancelled = true;
        }
        flow = null;
    }

    /** Called by LoginActivity when you leave the Nextcloud page without granting access. */
    static void loginWindowClosed() {
        Nextcloud.LoginFlow f = flow;
        if (f != null) {
            f.cancelled = true;
        }
    }

    private void askForNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    /** The app password stopped working, or you logged out. */
    void loggedOut() {
        Tracking.clearAll(this);
        if (appPage) {
            loadPage();
        }
    }

    private boolean pendingChanges() {
        JSONObject snap = Local.snapshot(this);
        return (snap != null && snap.optInt("pending", 0) > 0) || !Local.outboxEmpty(this);
    }

    /** Account sheet: who you are, notifications, exact reminders, log out. */
    void showAccount() {
        final I18n t = Tracking.i18n();
        String server = Store.server(this);
        if (server == null) {
            return;
        }
        String host = Nextcloud.host(server);
        boolean[] on = {Store.notifications(this)};
        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle(t.t("Logged in as {user} on {host}", Vars.of("user", String.valueOf(Store.loginName(this)), "host", host)))
                .setMultiChoiceItems(new String[] {t.t("Notifications")}, on, (d, which, checked) -> {
                    Store.setNotifications(this, checked);
                    Tracking.refresh(this, null);
                })
                .setPositiveButton(t.t("Close"), null)
                .setNegativeButton(t.t("Log out"), (d, w) -> confirmLogout(host));
        if (!Tracking.canExactAlarms(this)) { // only false on Android 12+
            b.setNeutralButton(t.t("Allow exact reminders"), (d, w) -> {
                try {
                    startActivity(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + getPackageName())));
                } catch (ActivityNotFoundException ignored) {
                    // settings screen not available
                }
            });
        }
        b.show();
    }

    private void confirmLogout(String host) {
        final I18n t = Tracking.i18n();
        new AlertDialog.Builder(this)
                .setMessage(t.t("Log out of {host}? The app password is removed from Nextcloud.", Vars.of("host", host))
                        + (pendingChanges() ? "\n\n" + t.t("Some changes on this phone are not synced yet and will be lost.") : ""))
                .setPositiveButton(t.t("Log out"), (d, w) -> {
                    final Nextcloud client = Store.client(this);
                    Tracking.IO.execute(() -> {
                        if (client != null) {
                            client.revoke();
                        }
                        Store.clear(this);
                        // Logging out removes Tracker's data from this phone (it is on the server)
                        Vault.wipe(this);
                        Local.saveSnapshot(this, null);
                        runOnUiThread(this::loggedOut);
                    });
                })
                .setNegativeButton(t.t("Cancel"), null)
                .show();
    }
}
