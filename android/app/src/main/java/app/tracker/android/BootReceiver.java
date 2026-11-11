package app.tracker.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After a restart or an update: show the timer again and plan the next reminder. */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }
        if (!Store.ready(context)) {
            return;
        }
        final PendingResult pending = goAsync();
        Tracking.refresh(context, pending::finish);
    }
}
