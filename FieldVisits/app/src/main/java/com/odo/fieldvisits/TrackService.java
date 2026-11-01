package com.odo.fieldvisits;

import android.Manifest;
import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Records the rep's location automatically during working hours
 * (default 08:00–22:00, every 5 minutes) — no buttons for the rep.
 * Runs as a foreground service (Android shows a small permanent
 * notification), restarts after reboot, keeps points in a file when
 * there is no internet and uploads them later to the Apps Script
 * web app (doPost).
 */
public class TrackService extends Service {

    static final String PREFS = "fv";
    static final String CHANNEL = "track";
    static final int NOTIF_ID = 7;
    static final String ACTION_WAKE = "com.odo.fieldvisits.WAKE";
    static final TimeZone TZ = TimeZone.getTimeZone("Asia/Riyadh");

    static volatile boolean running = false;
    static volatile long lastFixAt = 0;

    private LocationManager lm;
    private Handler handler;
    private final List<LocationListener> listeners = new ArrayList<>();
    private boolean listening = false;
    private Location best = null;
    private long lastSavedAt = 0;
    private long lastUploadAt = 0;
    private String lastNotifText = "";
    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private static final Object QLOCK = new Object();

    // ------------------------------------------------------------ helpers
    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, MODE_PRIVATE); }

    static boolean hasSession(Context c) { return prefs(c).getString("token", "").length() > 0; }

    static String appUrl(Context c) {
        String baked = c.getString(R.string.web_app_url);
        if (baked != null && baked.trim().startsWith("https://") && !baked.contains("PASTE_YOUR")) return baked.trim();
        return prefs(c).getString("url", "");
    }

    static String deviceId(Context c) {
        SharedPreferences p = prefs(c);
        String d = p.getString("dev", "");
        if (d.length() == 0) { d = "A" + UUID.randomUUID().toString().replace("-", "").substring(0, 12); p.edit().putString("dev", d).apply(); }
        return d;
    }

    static boolean hasLocationPermission(Context c) {
        return ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean hasFine(Context c) {
        return ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean hasBackground(Context c) {
        if (Build.VERSION.SDK_INT < 29) return hasLocationPermission(c);
        return ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    /** "HH:mm" → minutes after midnight. */
    static int mins(String hm, int def) {
        try { String[] p = hm.trim().split(":"); return Integer.parseInt(p[0]) * 60 + Integer.parseInt(p[1]); }
        catch (Exception e) { return def; }
    }

    static int nowMins() {
        Calendar c = Calendar.getInstance(TZ);
        return c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE);
    }

    static int fromMins(Context c) { return mins(prefs(c).getString("from", "08:00"), 480); }
    static int toMins(Context c) { return mins(prefs(c).getString("to", "22:00"), 1320); }
    static long everyMs(Context c) { return Math.max(1, prefs(c).getInt("every", 5)) * 60000L; }

    static boolean inHours(Context c) { int n = nowMins(); return n >= fromMins(c) && n < toMins(c); }

    public static void start(Context c) {
        if (!hasSession(c) || !hasLocationPermission(c)) return;
        try { ContextCompat.startForegroundService(c, new Intent(c, TrackService.class)); } catch (Exception ignore) {}
    }

    public static void stop(Context c) {
        try { c.stopService(new Intent(c, TrackService.class)); } catch (Exception ignore) {}
    }

    // ------------------------------------------------------------ lifecycle
    @Override
    public void onCreate() {
        super.onCreate();
        lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        handler = new Handler(Looper.getMainLooper());
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Working hours location", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!goForeground(text())) { stopSelf(); return START_NOT_STICKY; }
        if (!hasSession(this)) { stopSelf(); return START_NOT_STICKY; }
        running = true;
        handler.removeCallbacks(tick);
        handler.post(tick);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacks(tick);
        stopListening();
        net.shutdown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private String text() {
        String from = prefs(this).getString("from", "08:00"), to = prefs(this).getString("to", "22:00");
        if (!hasLocationPermission(this)) return "Location permission needed — open Field Visits · مطلوب إذن الموقع";
        return inHours(this)
            ? "Working hours location " + from + "–" + to + " · تسجيل الموقع أثناء العمل"
            : "Paused · starts at " + from + " · متوقف حتى " + from;
    }

    private Notification notification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
            PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
        return new NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("Field Visits")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pi)
            .build();
    }

    private boolean goForeground(String text) {
        try {
            Notification n = notification(text);
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(NOTIF_ID, n);
            lastNotifText = text;
            return true;
        } catch (Exception e) {
            return false;   // e.g. location permission withdrawn
        }
    }

    private void updateNotification() {
        String t = text();
        if (t.equals(lastNotifText)) return;
        lastNotifText = t;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) try { nm.notify(NOTIF_ID, notification(t)); } catch (Exception ignore) {}
    }

    /** Runs every minute: start/stop GPS by the clock, save + upload. */
    private final Runnable tick = new Runnable() {
        public void run() {
            if (!hasSession(TrackService.this)) { stopSelf(); return; }
            if (inHours(TrackService.this) && hasLocationPermission(TrackService.this)) {
                startListening();
                long now = System.currentTimeMillis();
                if (best != null && now - lastSavedAt >= everyMs(TrackService.this) - 20000) saveBest();
            } else {
                stopListening();
                scheduleWake();
            }
            updateNotification();
            maybeUpload(false);
            handler.postDelayed(this, 60000);
        }
    };

    /** Wake up at the start time even if the phone slept all night. */
    private void scheduleWake() {
        try {
            AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
            if (am == null) return;
            Calendar c = Calendar.getInstance(TZ);
            int f = fromMins(this);
            c.set(Calendar.HOUR_OF_DAY, f / 60); c.set(Calendar.MINUTE, f % 60); c.set(Calendar.SECOND, 0); c.set(Calendar.MILLISECOND, 0);
            if (c.getTimeInMillis() <= System.currentTimeMillis()) c.add(Calendar.DAY_OF_MONTH, 1);
            Intent i = new Intent(this, BootReceiver.class).setAction(ACTION_WAKE);
            PendingIntent pi = PendingIntent.getBroadcast(this, 1, i,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
            if (Build.VERSION.SDK_INT >= 23) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, c.getTimeInMillis(), pi);
            else am.set(AlarmManager.RTC_WAKEUP, c.getTimeInMillis(), pi);
        } catch (Exception ignore) {}
    }

    // ------------------------------------------------------------ location
    private void startListening() {
        if (listening) return;
        List<String> enabled;
        try { enabled = lm.getProviders(true); } catch (Exception e) { return; }
        long every = everyMs(this);
        for (String pv : new String[]{"fused", LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
            if (!enabled.contains(pv)) continue;
            if (LocationManager.GPS_PROVIDER.equals(pv) && !hasFine(this)) continue;
            LocationListener l = new LocationListener() {
                @Override public void onLocationChanged(@NonNull Location loc) { consider(loc); }
                @Override public void onProviderDisabled(@NonNull String p) {}
                @Override public void onProviderEnabled(@NonNull String p) {}
                @Override public void onStatusChanged(String p, int st, Bundle e) {}
            };
            try {
                // ask a little more often than we save, keep the most accurate fix of each period
                lm.requestLocationUpdates(pv, Math.max(30000L, every / 2), 0f, l, Looper.getMainLooper());
                listeners.add(l);
            } catch (Exception ignore) {}
        }
        listening = !listeners.isEmpty();
    }

    private void stopListening() {
        for (LocationListener l : listeners) { try { lm.removeUpdates(l); } catch (Exception ignore) {} }
        listeners.clear();
        listening = false;
        best = null;
    }

    private void consider(Location loc) {
        if (loc == null) return;
        lastFixAt = System.currentTimeMillis();
        if (best == null || isMock(loc) || (loc.hasAccuracy() && (!best.hasAccuracy() || loc.getAccuracy() < best.getAccuracy()))
            || loc.getTime() - best.getTime() > 3 * 60000) {
            if (best == null || !isMock(best)) best = loc;   // never hide a fake-GPS fix behind a better one
        }
        if (System.currentTimeMillis() - lastSavedAt >= everyMs(this) - 20000) saveBest();
    }

    private static boolean isMock(Location loc) {
        if (loc == null) return false;
        if (Build.VERSION.SDK_INT >= 31) return loc.isMock();
        return loc.isFromMockProvider();
    }

    private int battery() {
        try {
            BatteryManager bm = (BatteryManager) getSystemService(BATTERY_SERVICE);
            return bm == null ? -1 : bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
        } catch (Exception e) { return -1; }
    }

    private void saveBest() {
        Location loc = best;
        if (loc == null || !inHours(this)) return;
        best = null;
        lastSavedAt = System.currentTimeMillis();
        try {
            JSONObject o = new JSONObject();
            o.put("t", System.currentTimeMillis());
            o.put("lat", loc.getLatitude());
            o.put("lon", loc.getLongitude());
            if (loc.hasAccuracy()) o.put("acc", Math.round(loc.getAccuracy()));
            o.put("mock", isMock(loc));
            o.put("prov", loc.getProvider());
            int b = battery(); if (b >= 0) o.put("bat", b);
            o.put("src", "app");
            appendQueue(this, o.toString());
        } catch (Exception ignore) {}
        maybeUpload(false);
    }

    // ------------------------------------------------------------ queue + upload
    static File queueFile(Context c) { return new File(c.getFilesDir(), "track_queue.jsonl"); }

    static void appendQueue(Context c, String line) {
        synchronized (QLOCK) {
            try (FileOutputStream f = new FileOutputStream(queueFile(c), true)) {
                f.write((line + "\n").getBytes("UTF-8"));
            } catch (Exception ignore) {}
        }
    }

    static List<String> readQueue(Context c) {
        List<String> out = new ArrayList<>();
        synchronized (QLOCK) {
            File f = queueFile(c);
            if (!f.exists()) return out;
            try (BufferedReader r = new BufferedReader(new FileReader(f))) {
                String s;
                while ((s = r.readLine()) != null) if (s.trim().length() > 0) out.add(s);
            } catch (Exception ignore) {}
        }
        return out;
    }

    /** Remove the first n lines (they were uploaded). */
    static void dropQueue(Context c, int n) {
        synchronized (QLOCK) {
            List<String> all = new ArrayList<>();
            File f = queueFile(c);
            try (BufferedReader r = new BufferedReader(new FileReader(f))) {
                String s;
                while ((s = r.readLine()) != null) if (s.trim().length() > 0) all.add(s);
            } catch (Exception ignore) {}
            StringBuilder sb = new StringBuilder();
            for (int i = n; i < all.size(); i++) sb.append(all.get(i)).append("\n");
            try (FileOutputStream o = new FileOutputStream(f, false)) { o.write(sb.toString().getBytes("UTF-8")); }
            catch (Exception ignore) {}
        }
    }

    private void maybeUpload(boolean force) {
        long now = System.currentTimeMillis();
        if (!force && now - lastUploadAt < 10 * 60000L && readQueue(this).size() < 3) return;
        lastUploadAt = now;
        final Context ctx = getApplicationContext();
        try {
            net.execute(new Runnable() { public void run() { upload(ctx); } });
        } catch (Exception ignore) {}
    }

    /** Sends queued points; returns true when the queue was emptied. */
    static boolean upload(Context c) {
        String token = prefs(c).getString("token", ""), url = appUrl(c);
        if (token.length() == 0 || url.length() == 0) return false;
        List<String> q = readQueue(c);
        if (q.isEmpty()) return true;
        int n = Math.min(q.size(), 300);
        try {
            JSONArray pts = new JSONArray();
            for (int i = 0; i < n; i++) pts.put(new JSONObject(q.get(i)));
            JSONObject body = new JSONObject();
            body.put("token", token);
            body.put("device", deviceId(c));
            body.put("batch", deviceId(c) + "-" + new JSONObject(q.get(0)).optLong("t") + "-" + n);
            body.put("points", pts);
            String res = post(url, body.toString());
            JSONObject r = new JSONObject(res);
            if (r.optBoolean("ok")) {
                dropQueue(c, n);
                JSONObject d = r.optJSONObject("data");
                JSONObject tr = d == null ? null : d.optJSONObject("track");
                if (tr != null) {   // hours may have been changed by the manager
                    prefs(c).edit().putString("from", tr.optString("from", "08:00"))
                        .putString("to", tr.optString("to", "22:00"))
                        .putInt("every", tr.optInt("every", 5)).apply();
                }
                return n == q.size();
            }
            if ("AUTH".equals(r.optString("err"))) {   // signed out / password reset → stop until next sign-in
                prefs(c).edit().remove("token").apply();
                stop(c);
            }
        } catch (Exception ignore) {}
        return false;
    }

    /** POST to Apps Script; it answers with a redirect to the result, which we fetch with GET. */
    static String post(String url, String body) throws Exception {
        String target = url, method = "POST";
        byte[] data = body.getBytes("UTF-8");
        for (int i = 0; i < 5; i++) {
            HttpURLConnection c = (HttpURLConnection) new URL(target).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(20000);
            c.setReadTimeout(40000);
            c.setRequestMethod(method);
            if ("POST".equals(method)) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "text/plain;charset=utf-8");
                try (OutputStream o = c.getOutputStream()) { o.write(data); }
            }
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null) throw new Exception("redirect without location");
                target = loc; method = "GET";
                continue;
            }
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            StringBuilder sb = new StringBuilder();
            if (in != null) {
                byte[] buf = new byte[4096]; int k;
                while ((k = in.read(buf)) > 0) sb.append(new String(buf, 0, k, "UTF-8"));
                in.close();
            }
            c.disconnect();
            if (code >= 400) throw new Exception("HTTP " + code);
            return sb.toString();
        }
        throw new Exception("too many redirects");
    }
}
