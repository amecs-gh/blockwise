"""
Stand-ins for the Android SDK classes the app uses, with the real signatures
(checked against developer.android.com), so the app's Java can be type-checked
without the SDK: python3 tools/android_stubs.py <outdir>
They only declare; nothing runs.
"""
import os, sys, textwrap
out = sys.argv[1]
S = {}
def c(path, body): S[path] = textwrap.dedent(body)

c('android/annotation/SuppressLint.java', '''package android.annotation;
public @interface SuppressLint { String[] value(); }''')
c('android/Manifest.java', '''package android;
public final class Manifest { public static final class permission { public static final String POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS"; } }''')
c('android/content/Context.java', '''package android.content;
public abstract class Context {
  public static final int MODE_PRIVATE = 0;
  public abstract Context getApplicationContext();
  public abstract SharedPreferences getSharedPreferences(String name, int mode);
  public final <T> T getSystemService(Class<T> c) { return null; }
  public abstract int checkSelfPermission(String permission);
  public abstract String getPackageName();
  public abstract android.content.res.Resources getResources();
  public final int getColor(int id) { return 0; }
  public abstract void startActivity(Intent intent);
}''')
c('android/content/ContextWrapper.java', '''package android.content;
public class ContextWrapper extends Context {
  public Context getApplicationContext() { return null; }
  public SharedPreferences getSharedPreferences(String name, int mode) { return null; }
  public int checkSelfPermission(String permission) { return 0; }
  public String getPackageName() { return null; }
  public android.content.res.Resources getResources() { return null; }
  public void startActivity(Intent intent) {}
}''')
c('android/content/res/Resources.java', '''package android.content.res;
public class Resources { public Configuration getConfiguration() { return null; } }''')
c('android/content/res/Configuration.java', '''package android.content.res;
public class Configuration { public android.os.LocaleList getLocales() { return null; } }''')
c('android/os/LocaleList.java', '''package android.os;
public final class LocaleList { public java.util.Locale get(int i) { return null; } }''')
c('android/content/SharedPreferences.java', '''package android.content;
public interface SharedPreferences {
  String getString(String key, String def);
  java.util.Set<String> getStringSet(String key, java.util.Set<String> def);
  boolean getBoolean(String key, boolean def);
  Editor edit();
  interface Editor {
    Editor putString(String key, String value);
    Editor putStringSet(String key, java.util.Set<String> values);
    Editor putBoolean(String key, boolean value);
    Editor remove(String key);
    Editor clear();
    boolean commit();
    void apply();
  }
}''')
c('android/content/Intent.java', '''package android.content;
public class Intent {
  public static final String ACTION_VIEW = "android.intent.action.VIEW";
  public static final String ACTION_BOOT_COMPLETED = "android.intent.action.BOOT_COMPLETED";
  public static final String ACTION_MY_PACKAGE_REPLACED = "android.intent.action.MY_PACKAGE_REPLACED";
  public static final String CATEGORY_BROWSABLE = "android.intent.category.BROWSABLE";
  public static final int FLAG_ACTIVITY_NEW_TASK = 0x10000000;
  public static final int FLAG_ACTIVITY_SINGLE_TOP = 0x20000000;
  public Intent(String action, android.net.Uri uri) {}
  public Intent(Context packageContext, Class<?> cls) {}
  public Intent setAction(String action) { return this; }
  public String getAction() { return null; }
  public Intent addFlags(int flags) { return this; }
  public Intent addCategory(String category) { return this; }
  public Intent putExtra(String name, String value) { return this; }
  public String getStringExtra(String name) { return null; }
}''')
c('android/content/ActivityNotFoundException.java', '''package android.content;
public class ActivityNotFoundException extends RuntimeException {}''')
c('android/content/BroadcastReceiver.java', '''package android.content;
public abstract class BroadcastReceiver {
  public abstract void onReceive(Context context, Intent intent);
  public final PendingResult goAsync() { return null; }
  public static class PendingResult { public final void finish() {} }
}''')
c('android/content/DialogInterface.java', '''package android.content;
public interface DialogInterface {
  interface OnClickListener { void onClick(DialogInterface dialog, int which); }
  interface OnMultiChoiceClickListener { void onClick(DialogInterface dialog, int which, boolean isChecked); }
}''')
c('android/content/pm/PackageManager.java', '''package android.content.pm;
public abstract class PackageManager { public static final int PERMISSION_GRANTED = 0; }''')
c('android/app/Activity.java', '''package android.app;
public class Activity extends android.content.ContextWrapper {
  protected void onCreate(android.os.Bundle savedInstanceState) {}
  protected void onResume() {}
  protected void onPause() {}
  protected void onDestroy() {}
  @Deprecated public void onBackPressed() {}
  public final void runOnUiThread(Runnable action) {}
  public android.view.Window getWindow() { return null; }
  public void setContentView(android.view.View view) {}
  public void recreate() {}
  public boolean moveTaskToBack(boolean nonRoot) { return false; }
  public android.content.Intent getIntent() { return null; }
  public void setTitle(CharSequence title) {}
  public void finish() {}
  public boolean isFinishing() { return false; }
  public final void requestPermissions(String[] permissions, int requestCode) {}
  public android.window.OnBackInvokedDispatcher getOnBackInvokedDispatcher() { return null; }
}''')
c('android/view/Window.java', '''package android.view;
public abstract class Window { public void setDecorFitsSystemWindows(boolean decorFitsSystemWindows) {} }''')
c('android/app/AlertDialog.java', '''package android.app;
import android.content.DialogInterface;
public class AlertDialog implements DialogInterface {
  public static class Builder {
    public Builder(android.content.Context context) {}
    public Builder setTitle(CharSequence title) { return this; }
    public Builder setMessage(CharSequence message) { return this; }
    public Builder setMultiChoiceItems(CharSequence[] items, boolean[] checkedItems, DialogInterface.OnMultiChoiceClickListener listener) { return this; }
    public Builder setPositiveButton(CharSequence text, DialogInterface.OnClickListener listener) { return this; }
    public Builder setNegativeButton(CharSequence text, DialogInterface.OnClickListener listener) { return this; }
    public Builder setNeutralButton(CharSequence text, DialogInterface.OnClickListener listener) { return this; }
    public AlertDialog show() { return null; }
  }
}''')
c('android/app/AlarmManager.java', '''package android.app;
public class AlarmManager {
  public static final int RTC_WAKEUP = 0;
  public void cancel(PendingIntent operation) {}
  public void setExactAndAllowWhileIdle(int type, long triggerAtMillis, PendingIntent operation) {}
  public void setAndAllowWhileIdle(int type, long triggerAtMillis, PendingIntent operation) {}
  public boolean canScheduleExactAlarms() { return false; }
}''')
c('android/app/PendingIntent.java', '''package android.app;
public final class PendingIntent {
  public static final int FLAG_IMMUTABLE = 1 << 26;
  public static final int FLAG_UPDATE_CURRENT = 1 << 27;
  public static PendingIntent getActivity(android.content.Context context, int requestCode, android.content.Intent intent, int flags) { return null; }
  public static PendingIntent getBroadcast(android.content.Context context, int requestCode, android.content.Intent intent, int flags) { return null; }
}''')
c('android/app/NotificationChannel.java', '''package android.app;
public final class NotificationChannel {
  public NotificationChannel(String id, CharSequence name, int importance) {}
  public void setDescription(String description) {}
  public void setShowBadge(boolean showBadge) {}
}''')
c('android/app/NotificationManager.java', '''package android.app;
public class NotificationManager {
  public static final int IMPORTANCE_LOW = 2;
  public static final int IMPORTANCE_HIGH = 4;
  public void createNotificationChannel(NotificationChannel channel) {}
  public void notify(int id, Notification notification) {}
  public void cancel(int id) {}
  public void cancelAll() {}
  public boolean areNotificationsEnabled() { return false; }
}''')
c('android/app/Notification.java', '''package android.app;
public class Notification {
  public static final String CATEGORY_STOPWATCH = "stopwatch";
  public static final String CATEGORY_REMINDER = "reminder";
  public static final int VISIBILITY_PRIVATE = 0;
  public static class Builder {
    public Builder(android.content.Context context, String channelId) {}
    public Builder setSmallIcon(int icon) { return this; }
    public Builder setContentTitle(CharSequence title) { return this; }
    public Builder setContentText(CharSequence text) { return this; }
    public Builder setColor(int argb) { return this; }
    public Builder setOngoing(boolean ongoing) { return this; }
    public Builder setOnlyAlertOnce(boolean onlyAlertOnce) { return this; }
    public Builder setShowWhen(boolean show) { return this; }
    public Builder setUsesChronometer(boolean b) { return this; }
    public Builder setChronometerCountDown(boolean countsDown) { return this; }
    public Builder setWhen(long when) { return this; }
    public Builder setCategory(String category) { return this; }
    public Builder setVisibility(int visibility) { return this; }
    public Builder setPublicVersion(Notification n) { return this; }
    public Builder setContentIntent(PendingIntent intent) { return this; }
    public Builder addAction(Action action) { return this; }
    public Builder setStyle(Style style) { return this; }
    public Builder setAutoCancel(boolean autoCancel) { return this; }
    public Notification build() { return null; }
  }
  public abstract static class Style {}
  public static class BigTextStyle extends Style { public BigTextStyle() {} public BigTextStyle bigText(CharSequence cs) { return this; } }
  public static class Action {
    public static final class Builder {
      public Builder(android.graphics.drawable.Icon icon, CharSequence title, PendingIntent intent) {}
      public Action build() { return null; }
    }
  }
}''')
c('android/graphics/Color.java', '''package android.graphics;
public class Color { public static int parseColor(String colorString) { return 0; } }''')
c('android/graphics/Insets.java', '''package android.graphics;
public final class Insets { public final int left = 0, top = 0, right = 0, bottom = 0; }''')
c('android/graphics/drawable/Icon.java', '''package android.graphics.drawable;
public final class Icon { public static Icon createWithResource(android.content.Context context, int resId) { return null; } }''')
c('android/net/Uri.java', '''package android.net;
public abstract class Uri { public static Uri parse(String uriString) { return null; } public abstract String getScheme(); public abstract String toString(); }''')
c('android/os/Build.java', '''package android.os;
public class Build { public static class VERSION { public static final int SDK_INT = 0; } }''')
c('android/os/Bundle.java', '''package android.os;
public final class Bundle {}''')
c('android/os/Looper.java', '''package android.os;
public final class Looper { public static Looper getMainLooper() { return null; } }''')
c('android/os/Handler.java', '''package android.os;
public class Handler { public Handler(Looper looper) {} public final boolean post(Runnable r) { return true; } }''')
c('android/provider/Settings.java', '''package android.provider;
public final class Settings { public static final String ACTION_REQUEST_SCHEDULE_EXACT_ALARM = "android.settings.REQUEST_SCHEDULE_EXACT_ALARM"; }''')
c('android/security/keystore/KeyProperties.java', '''package android.security.keystore;
public abstract class KeyProperties {
  public static final String KEY_ALGORITHM_AES = "AES";
  public static final int PURPOSE_ENCRYPT = 1;
  public static final int PURPOSE_DECRYPT = 2;
  public static final String BLOCK_MODE_GCM = "GCM";
  public static final String ENCRYPTION_PADDING_NONE = "NoPadding";
}''')
c('android/security/keystore/KeyGenParameterSpec.java', '''package android.security.keystore;
public final class KeyGenParameterSpec implements java.security.spec.AlgorithmParameterSpec {
  public static final class Builder {
    public Builder(String keystoreAlias, int purposes) {}
    public Builder setBlockModes(String... blockModes) { return this; }
    public Builder setEncryptionPaddings(String... paddings) { return this; }
    public Builder setKeySize(int keySize) { return this; }
    public KeyGenParameterSpec build() { return null; }
  }
}''')
c('android/view/View.java', '''package android.view;
public class View {
  public void setPadding(int left, int top, int right, int bottom) {}
  public void setBackgroundColor(int color) {}
  public void setOnApplyWindowInsetsListener(OnApplyWindowInsetsListener listener) {}
  public interface OnApplyWindowInsetsListener { WindowInsets onApplyWindowInsets(View v, WindowInsets insets); }
}''')
c('android/view/ViewGroup.java', '''package android.view;
public abstract class ViewGroup extends View {}''')
c('android/widget/AbsoluteLayout.java', '''package android.widget;
@Deprecated public class AbsoluteLayout extends android.view.ViewGroup {}''')
c('android/view/WindowInsets.java', '''package android.view;
public final class WindowInsets {
  public android.graphics.Insets getInsets(int typeMask) { return null; }
  public static final class Type {
    public static int systemBars() { return 0; }
    public static int displayCutout() { return 0; }
    public static int ime() { return 0; }
  }
}''')
c('android/webkit/JavascriptInterface.java', '''package android.webkit;
@java.lang.annotation.Retention(java.lang.annotation.RetentionPolicy.RUNTIME)
@java.lang.annotation.Target(java.lang.annotation.ElementType.METHOD)
public @interface JavascriptInterface {}''')
c('android/webkit/ValueCallback.java', '''package android.webkit;
public interface ValueCallback<T> { void onReceiveValue(T value); }''')
c('android/webkit/WebView.java', '''package android.webkit;
public class WebView extends android.widget.AbsoluteLayout {
  public WebView(android.content.Context context) {}
  public WebSettings getSettings() { return null; }
  public void setWebViewClient(WebViewClient client) {}
  public void setWebChromeClient(WebChromeClient client) {}
  public void addJavascriptInterface(Object object, String name) {}
  public void removeJavascriptInterface(String name) {}
  public void loadUrl(String url) {}
  public String getUrl() { return null; }
  public void evaluateJavascript(String script, ValueCallback<String> resultCallback) {}
  public boolean canGoBack() { return false; }
  public void goBack() {}
  public void clearHistory() {}
  public void destroy() {}
}''')
c('android/webkit/WebSettings.java', '''package android.webkit;
public abstract class WebSettings {
  public static final int MIXED_CONTENT_NEVER_ALLOW = 1;
  public abstract void setJavaScriptEnabled(boolean flag);
  public abstract void setDomStorageEnabled(boolean flag);
  public abstract void setAllowFileAccess(boolean allow);
  public abstract void setAllowContentAccess(boolean allow);
  public abstract void setSupportMultipleWindows(boolean support);
  public abstract void setJavaScriptCanOpenWindowsAutomatically(boolean flag);
  public abstract void setGeolocationEnabled(boolean flag);
  public abstract void setMixedContentMode(int mode);
  public abstract void setUserAgentString(String ua);
  public abstract String getUserAgentString();
}''')
c('android/webkit/WebResourceRequest.java', '''package android.webkit;
public interface WebResourceRequest { android.net.Uri getUrl(); }''')
c('android/webkit/RenderProcessGoneDetail.java', '''package android.webkit;
public abstract class RenderProcessGoneDetail {}''')
c('android/webkit/WebViewClient.java', '''package android.webkit;
public class WebViewClient {
  public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return false; }
  public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) { return false; }
}''')
c('android/webkit/PermissionRequest.java', '''package android.webkit;
public abstract class PermissionRequest { public abstract void deny(); }''')
c('android/webkit/WebChromeClient.java', '''package android.webkit;
public class WebChromeClient { public void onPermissionRequest(PermissionRequest request) {} }''')
c('android/webkit/CookieManager.java', '''package android.webkit;
public abstract class CookieManager {
  public static CookieManager getInstance() { return null; }
  public abstract void removeAllCookies(ValueCallback<Boolean> callback);
  public abstract void flush();
}''')
c('android/webkit/WebStorage.java', '''package android.webkit;
public class WebStorage { public static WebStorage getInstance() { return null; } public void deleteOrigin(String origin) {} public void deleteAllData() {} }''')
c('android/widget/Toast.java', '''package android.widget;
public class Toast {
  public static final int LENGTH_SHORT = 0;
  public static Toast makeText(android.content.Context context, CharSequence text, int duration) { return null; }
  public void show() {}
}''')
c('android/window/OnBackInvokedCallback.java', '''package android.window;
public interface OnBackInvokedCallback { void onBackInvoked(); }''')
c('android/window/OnBackInvokedDispatcher.java', '''package android.window;
public interface OnBackInvokedDispatcher {
  int PRIORITY_DEFAULT = 0;
  void registerOnBackInvokedCallback(int priority, OnBackInvokedCallback callback);
  void unregisterOnBackInvokedCallback(OnBackInvokedCallback callback);
}''')
# org.json as on Android (JSONException is checked)
c('org/json/JSONException.java', '''package org.json;
public class JSONException extends Exception { public JSONException(String s) {} }''')
c('org/json/JSONObject.java', '''package org.json;
public class JSONObject {
  public static final Object NULL = new Object();
  public JSONObject() {}
  public JSONObject(String json) throws JSONException {}
  public JSONObject put(String name, Object value) throws JSONException { return this; }
  public JSONObject put(String name, long value) throws JSONException { return this; }
  public JSONObject put(String name, boolean value) throws JSONException { return this; }
  public JSONObject put(String name, int value) throws JSONException { return this; }
  public boolean has(String name) { return false; }
  public boolean isNull(String name) { return false; }
  public String getString(String name) throws JSONException { return null; }
  public long getLong(String name) throws JSONException { return 0; }
  public JSONObject getJSONObject(String name) throws JSONException { return null; }
  public JSONObject optJSONObject(String name) { return null; }
  public JSONArray optJSONArray(String name) { return null; }
  public String optString(String name, String fallback) { return null; }
  public int optInt(String name, int fallback) { return 0; }
  public boolean optBoolean(String name, boolean fallback) { return false; }
  public static String quote(String data) { return null; }
  public static Object wrap(Object o) { return null; }
}''')
c('org/json/JSONArray.java', '''package org.json;
public class JSONArray {
  public JSONArray(String json) throws JSONException {}
  public int length() { return 0; }
  public JSONObject getJSONObject(int index) throws JSONException { return null; }
  public boolean isNull(int index) { return false; }
  public Object opt(int index) { return null; }
  public String optString(int index, String fallback) { return null; }
  public long optLong(int index) { return 0; }
}''')
c('org/json/JSONTokener.java', '''package org.json;
public class JSONTokener { public JSONTokener(String in) {} public Object nextValue() throws JSONException { return null; } }''')
c('app/tracker/android/R.java', '''package app.tracker.android;
public final class R {
  public static final class drawable { public static final int ic_stat_tracker = 1, ic_stop = 2, ic_launcher_foreground = 3; }
  public static final class color { public static final int page = 4, accent = 5, icon_bg = 6; }
}''')
for p, body in S.items():
    f = os.path.join(out, p); os.makedirs(os.path.dirname(f), exist_ok=True); open(f, 'w').write(body)
print(len(S), 'stubs')
