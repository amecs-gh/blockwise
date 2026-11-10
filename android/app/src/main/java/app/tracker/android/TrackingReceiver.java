package app.tracker.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** The notification's Stop button and the scheduled checks (not exported: only this app can send them). */
public final class TrackingReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        final PendingResult pending = goAsync();
        String action = intent.getAction();
        if (Tracking.ACTION_STOP.equals(action)) {
            Tracking.stop(context, pending::finish);
        } else if (Tracking.ACTION_CHECK.equals(action)) {
            Tracking.refresh(context, pending::finish);
        } else {
            pending.finish();
        }
    }
}
