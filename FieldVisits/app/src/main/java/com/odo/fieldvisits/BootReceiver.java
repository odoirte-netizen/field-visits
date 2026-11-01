package com.odo.fieldvisits;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restarts working-hours tracking after a reboot, an app update, or at the daily start time. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String a = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)
                || "android.intent.action.QUICKBOOT_POWERON".equals(a)
                || TrackService.ACTION_WAKE.equals(a)) {
            TrackService.start(context);
        }
    }
}
