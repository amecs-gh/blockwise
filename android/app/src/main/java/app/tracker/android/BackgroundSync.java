package app.tracker.android;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * With Dropbox / Google Drive, while the app is closed: about every 15 minutes
 * (Android decides, less often when the phone rests) a small check whether
 * another device wrote to the drive. Only then Blockwise syncs, in an invisible
 * page of its own (the same code as the app: web/engine.js and web/filesync.js),
 * and the timer notification and reminders follow what changed elsewhere.
 *
 * Never at the same time as the app's window: the job doesn't start while you
 * use the app, and the app waits for a sync that is running before it reads
 * its data (see Bridge "dbLoad"), then starts from the newer data.
 */
public final class BackgroundSync extends JobService implements Bridge.Host {
    private static final int JOB_ID = 7301;
    private static final long PERIOD_MS = 15 * 60 * 1000L;
    private static final long LIMIT_MS = 90 * 1000L;
    private static final String PREFS = "tracker-background";
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    /** A background sync is reading or writing the data right now */
    static volatile boolean running;
    /** Counts background syncs that changed the data: the app reloads its page after one */
    static volatile int generation;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private JobParameters job;
    private Runnable timeout;

    /** On with a drive, off otherwise (Nextcloud has its own ways; on this phone only nothing to sync). */
    static void schedule(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js == null) {
            return;
        }
        if (Store.drive(c) == null) {
            js.cancel(JOB_ID);
            return;
        }
        for (JobInfo j : js.getAllPendingJobs()) {
            if (j.getId() == JOB_ID) {
                return; // scheduled already
            }
        }
        js.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(c, BackgroundSync.class))
                .setPeriodic(PERIOD_MS)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build());
    }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Forget where the check was (another drive, or none) */
    static void reset(Context c) {
        prefs(c).edit().clear().apply();
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        if (Store.drive(this) == null || MainActivity.inFront || running) {
            return false;
        }
        job = params;
        running = true;
        IO.execute(() -> {
            boolean changed;
            try {
                changed = changedSinceLastTime();
            } catch (Drives.DriveException e) {
                changed = false; // offline or refused: next time (the app shows a refused drive)
            }
            final boolean sync = changed && !MainActivity.inFront;
            main.post(() -> {
                if (sync) {
                    startPage();
                } else {
                    finish(false);
                }
            });
        });
        return true;
    }

    /** The cheap part: did the drive's folder change since the last check? */
    private boolean changedSinceLastTime() throws Drives.DriveException {
        Drives.Folder f = MainActivity.driveFolder(this);
        if (f == null) {
            return false;
        }
        String key = "cursor:" + f.provider;
        String cursor = prefs(this).getString(key, null);
        if (cursor == null) {
            prefs(this).edit().putString(key, f.changeCursor()).apply();
            return true; // first time: sync once from here
        }
        JSONObject r;
        try {
            // Dropbox: waits up to 30 s for a change; Google Drive: one look
            r = f.changes(cursor, 30);
        } catch (Drives.DriveException e) {
            if (e.status == 409) {
                prefs(this).edit().putString(key, f.changeCursor()).apply();
                return true;
            }
            throw e;
        }
        prefs(this).edit().putString(key, r.optString("cursor", cursor)).apply();
        return r.optBoolean("changed", false);
    }

    /** The invisible page: syncs, saves, updates the notification, then says "bgDone". */
    private void startPage() {
        try {
            web = new WebView(this);
        } catch (RuntimeException e) {
            finish(false); // no WebView right now (being updated): next time
            return;
        }
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setGeolocationEnabled(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setBlockNetworkLoads(true); // the page itself loads nothing from the network
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true; // stays on its page
            }
        });
        web.addJavascriptInterface(new Bridge(null, this, this), "TrackerAndroid");
        timeout = () -> finish(false);
        main.postDelayed(timeout, LIMIT_MS);
        web.loadUrl(MainActivity.ASSETS + "sync.html");
    }

    /** From the page (Bridge "bgDone"): the data is saved */
    void done(boolean changedData) {
        main.post(() -> finish(changedData));
    }

    private void finish(boolean changedData) {
        if (job == null) {
            return;
        }
        if (changedData) {
            generation++;
        }
        if (timeout != null) {
            main.removeCallbacks(timeout);
            timeout = null;
        }
        if (web != null) {
            web.removeJavascriptInterface("TrackerAndroid");
            web.destroy();
            web = null;
        }
        running = false;
        JobParameters p = job;
        job = null;
        jobFinished(p, false);
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        // Android needs the phone for something else: stop; the data saved so far is consistent
        if (job != null) {
            finish(false);
        }
        return false;
    }

    // --- Bridge.Host --------------------------------------------------------------------------------

    @Override
    public void runOnUiThread(Runnable r) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            r.run();
        } else {
            main.post(r);
        }
    }

    @Override
    public boolean showsOwnPage() {
        String url = web == null ? null : web.getUrl();
        return url != null && url.equals(MainActivity.ASSETS + "sync.html");
    }

    @Override
    public void evaluate(String js) {
        if (web != null) {
            web.evaluateJavascript(js, null);
        }
    }

    @Override
    public JSONObject publicState() {
        JSONObject o = new JSONObject();
        try {
            o.put("platform", "android").put("mode", Store.mode(this) == null ? JSONObject.NULL : Store.mode(this)).put("background", true);
        } catch (org.json.JSONException ignored) {
            // can't happen with these values
        }
        return o;
    }

    @Override
    public void loggedOut() {
        // only with Nextcloud: never here
    }
}
