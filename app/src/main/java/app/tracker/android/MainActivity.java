package app.tracker.android;

import android.Manifest;
import android.app.Activity;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
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
        fitBars(web);
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
    public void onDash(Dash dash, boolean loggedOut) {
        if (loggedOut) {
            loggedOut();
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

    // --- what the bridge asks for ------------------------------------------------------------

    String publicState() {
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
        return o.toString();
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
                .setMessage(t.t("Log out of {host}? The app password is removed from Nextcloud.", Vars.of("host", host)))
                .setPositiveButton(t.t("Log out"), (d, w) -> {
                    final Nextcloud client = Store.client(this);
                    Tracking.IO.execute(() -> {
                        if (client != null) {
                            client.revoke();
                        }
                        Store.clear(this);
                        runOnUiThread(this::loggedOut);
                    });
                })
                .setNegativeButton(t.t("Cancel"), null)
                .show();
    }
}
