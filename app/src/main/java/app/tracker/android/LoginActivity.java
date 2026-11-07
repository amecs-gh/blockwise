package app.tracker.android;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.lang.ref.WeakReference;

import app.tracker.core.ServerUrl;

/**
 * Nextcloud's own login page ("Grant access"). It runs without the app's
 * bridge, can't open other windows, and its cookies are deleted afterwards:
 * the app keeps only the app password it receives.
 */
public final class LoginActivity extends Activity {
    static final String EXTRA_URL = "url";
    static final String EXTRA_SERVER = "server";

    private static WeakReference<LoginActivity> current = new WeakReference<>(null);

    private WebView web;
    private String server;
    private boolean closedByApp;

    /** Login finished (or failed): close the page. */
    static void closeAll() {
        LoginActivity a = current.get();
        if (a != null && !a.isFinishing()) {
            a.closedByApp = true;
            a.finish();
        }
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        String url = getIntent().getStringExtra(EXTRA_URL);
        server = getIntent().getStringExtra(EXTRA_SERVER);
        if (url == null || server == null || !ServerUrl.sameOrigin(server, url)) {
            finish();
            return;
        }
        current = new WeakReference<>(this);
        setTitle(Nextcloud.host(server));
        MainActivity.edgeToEdge(this);
        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.page));
        MainActivity.fitBars(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true); // Nextcloud's login page needs it
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setGeolocationEnabled(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " " + Nextcloud.USER_AGENT);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String u = request.getUrl().toString();
                // Your server, or (for single sign-on) another https page; nothing else
                boolean ok = ServerUrl.sameOrigin(server, u) || u.startsWith("https://");
                return !ok;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                request.deny();
            }
        });
        setContentView(web);
        web.loadUrl(url);
    }

    @Override
    protected void onDestroy() {
        if (!closedByApp) {
            // You went back without granting access: stop waiting
            MainActivity.loginWindowClosed();
        }
        if (current.get() == this) {
            current = new WeakReference<>(null);
        }
        // Forget the browser session; only the app password is needed
        CookieManager.getInstance().removeAllCookies(null);
        CookieManager.getInstance().flush();
        if (server != null) {
            WebStorage.getInstance().deleteOrigin(ServerUrl.origin(server));
        }
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
