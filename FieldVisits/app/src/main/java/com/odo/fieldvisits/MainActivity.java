package com.odo.fieldvisits;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.PermissionRequest;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

/**
 * Field Visits — Android shell.
 * Loads the manager's Apps Script web app in a WebView and adds a
 * native GPS bridge that reports the phone's real location AND whether
 * a mock-location (fake GPS) app produced it — something a web page
 * cannot see on its own.
 */
public class MainActivity extends AppCompatActivity {

    private WebView web;
    private LocationManager lm;
    private static final int REQ_LOC = 101;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setGeolocationEnabled(true);
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);

        web.setWebViewClient(new WebViewClient() {
            // Keep the app's own pages inside; open maps, phone numbers and
            // other sites in their own apps so the dashboard isn't replaced.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openOutside(url);
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest req) {
                return openOutside(req.getUrl().toString());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            // auto-grant the web layer's geolocation prompt (we gate real GPS natively)
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                    android.webkit.GeolocationPermissions.Callback cb) {
                cb.invoke(origin, true, false);
            }
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                request.grant(request.getResources());
            }
        });

        web.addJavascriptInterface(new GpsBridge(), "AndroidGPS");

        lm = (LocationManager) getSystemService(LOCATION_SERVICE);

        // Ask for location permission up front.
        if (!hasLoc()) {
            ActivityCompat.requestPermissions(this,
                new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                             Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOC);
        }

        web.addJavascriptInterface(new SetupBridge(), "AndroidSetup");
        openApp();
    }

    /** Built-in link (config.xml) wins; otherwise a link pasted on the setup screen. */
    private String appUrl() {
        String baked = getString(R.string.web_app_url);
        if (validUrl(baked)) return baked.trim();
        String saved = getSharedPreferences("fv", MODE_PRIVATE).getString("url", "");
        return validUrl(saved) ? saved.trim() : null;
    }

    private static boolean validUrl(String u) {
        return u != null && u.trim().startsWith("https://") && !u.contains("PASTE_YOUR");
    }

    private void openApp() {
        String url = appUrl();
        if (url != null) { web.loadUrl(url); return; }
        // loadDataWithBaseURL (not loadData): loadData cuts the page at the first '#'.
        String html =
            "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
          + "<body style='font-family:sans-serif;padding:24px;background:#0f1720;color:#eaf0f6'>"
          + "<h2>Field Visits</h2>"
          + "<p>Paste the web app link (it ends in <b>/exec</b>), then tap Save.</p>"
          + "<p dir='rtl'>الصق رابط التطبيق (ينتهي بـ <b>/exec</b>) ثم اضغط حفظ.</p>"
          + "<input id='u' style='width:100%;padding:14px;font-size:16px;border-radius:10px;border:1px solid #26323f;background:#0c131c;color:#eaf0f6' placeholder='https://script.google.com/macros/s/.../exec'>"
          + "<button style='margin-top:14px;width:100%;padding:16px;font-size:18px;font-weight:bold;border:0;border-radius:12px;background:#2f6df6;color:#fff' "
          + "onclick=\"var v=document.getElementById('u').value.trim();"
          + "if(v.indexOf('https://')!==0||v.indexOf('/exec')<0){document.getElementById('m').textContent='This link should start with https:// and end with /exec';return;}"
          + "AndroidSetup.saveUrl(v);\">Save / حفظ</button>"
          + "<p id='m' style='color:#ff9a9a'></p></body></html>";
        web.loadDataWithBaseURL("https://localhost/", html, "text/html", "utf-8", null);
    }

    /** Lets the setup screen store the link; exposed as window.AndroidSetup */
    private class SetupBridge {
        @JavascriptInterface
        public void saveUrl(String u) {
            if (!validUrl(u)) return;
            getSharedPreferences("fv", MODE_PRIVATE).edit().putString("url", u.trim()).apply();
            runOnUiThread(new Runnable() { public void run() { openApp(); } });
        }
    }

    private boolean openOutside(String url) {
        if (url == null) return false;
        String u = url.toLowerCase();
        boolean ours = u.startsWith("https://script.google.com/")
            || u.contains(".googleusercontent.com/")
            || u.startsWith("https://accounts.google.com/")
            || u.startsWith("https://localhost/")
            || u.startsWith("about:") || u.startsWith("data:") || u.startsWith("blob:");
        if (ours) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            Toast.makeText(this, "No app found to open this link", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private boolean hasLoc() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int req, @NonNull String[] p, @NonNull int[] r) {
        super.onRequestPermissionsResult(req, p, r);
        // nothing to do; next requestLocation() will use whatever was granted
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    private boolean isMock(Location loc) {
        if (loc == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {   // API 31+
            return loc.isMock();
        }
        return loc.isFromMockProvider();                         // API 18–30
    }

    private boolean hasFine() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    /** Is the phone's Location switch on? */
    private boolean locationOn() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return lm.isLocationEnabled();
            return lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception e) { return true; }
    }

    /**
     * The object exposed to JavaScript as window.AndroidGPS.
     * Page→native only (works inside the Apps Script iframe): the page calls
     * requestLocation() then polls pollResult(), which returns "" while the
     * fix is pending and a JSON string once it is ready.
     *
     * Asks every available source at once (GPS, network, fused) and takes the
     * first fix that is accurate enough, so it also works indoors. Falls back
     * to the best fix seen, then to a recent last-known position. On failure
     * it says why: "denied" (no permission), "off" (phone location switched
     * off) or "nofix" (no signal yet).
     */
    private class GpsBridge {

        private volatile String lastResult = "";   // "" = pending
        private static final long WAIT_MS = 25000;  // total wait for a fix
        private static final float GOOD_M = 100f;   // accept at once when this accurate
        private static final long RECENT_MS = 10 * 60 * 1000L; // last-known still useful

        @JavascriptInterface
        public String pollResult() { return lastResult; }

        @JavascriptInterface
        public String status() {
            return !hasLoc() ? "denied" : (!locationOn() ? "off" : "ok");
        }

        @JavascriptInterface
        public void openSettings(final String which) {
            runOnUiThread(new Runnable() { public void run() {
                try {
                    Intent i;
                    if ("app".equals(which)) {
                        i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                Uri.fromParts("package", getPackageName(), null));
                    } else {
                        i = new Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS);
                    }
                    startActivity(i);
                } catch (Exception ignore) {}
            }});
        }

        @JavascriptInterface
        public void requestLocation() {
            lastResult = "";   // reset for a fresh fix
            runOnUiThread(new Runnable() { public void run() { start(); } });
        }

        private void start() {
            if (!hasLoc()) {
                fail("denied");
                ActivityCompat.requestPermissions(MainActivity.this,
                    new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                                 Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOC);
                return;
            }
            if (!locationOn()) { fail("off"); return; }

            final java.util.List<String> sources = new java.util.ArrayList<>();
            java.util.List<String> enabled;
            try { enabled = lm.getProviders(true); } catch (Exception e) { enabled = new java.util.ArrayList<>(); }
            for (String pv : new String[]{"fused", LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
                if (!enabled.contains(pv)) continue;
                if (LocationManager.GPS_PROVIDER.equals(pv) && !hasFine()) continue;  // "approximate" only
                sources.add(pv);
            }
            if (sources.isEmpty()) { useLastKnownOr("off"); return; }

            final boolean[] done = {false};
            final Location[] best = {null};
            final java.util.List<LocationListener> listeners = new java.util.ArrayList<>();
            final Handler h = new Handler(Looper.getMainLooper());

            final Runnable stop = new Runnable() { public void run() {
                for (LocationListener l : listeners) { try { lm.removeUpdates(l); } catch (Exception ignore) {} }
            }};

            for (String pv : sources) {
                LocationListener l = new LocationListener() {
                    @Override public void onLocationChanged(@NonNull Location loc) {
                        if (done[0]) return;
                        if (best[0] == null || (loc.hasAccuracy() && (!best[0].hasAccuracy()
                                || loc.getAccuracy() < best[0].getAccuracy()))) best[0] = loc;
                        if (loc.hasAccuracy() && loc.getAccuracy() <= GOOD_M) {
                            done[0] = true; stop.run(); emit(loc);
                        }
                    }
                    @Override public void onProviderDisabled(@NonNull String p) {}
                    @Override public void onProviderEnabled(@NonNull String p) {}
                    @Override public void onStatusChanged(String p, int st, Bundle e) {}
                };
                try {
                    lm.requestLocationUpdates(pv, 0L, 0f, l, Looper.getMainLooper());
                    listeners.add(l);
                } catch (Exception ignore) {}
            }
            if (listeners.isEmpty()) { useLastKnownOr("nofix"); return; }

            // After 8 s take a usable fix even if not very accurate.
            h.postDelayed(new Runnable() { public void run() {
                if (done[0] || best[0] == null) return;
                if (best[0].hasAccuracy() && best[0].getAccuracy() <= 500f) {
                    done[0] = true; stop.run(); emit(best[0]);
                }
            }}, 8000);
            // Final timeout: best seen, then recent last-known, else "nofix".
            h.postDelayed(new Runnable() { public void run() {
                if (done[0]) return;
                done[0] = true; stop.run();
                if (best[0] != null) emit(best[0]); else useLastKnownOr("nofix");
            }}, WAIT_MS);
        }

        private void useLastKnownOr(String err) {
            Location bestLast = null;
            try {
                for (String pv : lm.getProviders(true)) {
                    if (LocationManager.GPS_PROVIDER.equals(pv) && !hasFine()) continue;
                    Location l = lm.getLastKnownLocation(pv);
                    if (l == null) continue;
                    long age = System.currentTimeMillis() - l.getTime();
                    if (age > RECENT_MS) continue;
                    if (bestLast == null || l.getTime() > bestLast.getTime()) bestLast = l;
                }
            } catch (Exception ignore) {}
            if (bestLast != null) emit(bestLast); else fail(err);
        }

        private void fail(String err) {
            JSONObject o = new JSONObject();
            try { o.put("ok", false); o.put("err", err); o.put("lat", JSONObject.NULL); o.put("lon", JSONObject.NULL); }
            catch (Exception ignore) {}
            lastResult = o.toString();
        }

        private void emit(Location loc) {
            JSONObject o = new JSONObject();
            try {
                o.put("lat", loc.getLatitude());
                o.put("lon", loc.getLongitude());
                o.put("accuracy", loc.hasAccuracy() ? loc.getAccuracy() : JSONObject.NULL);
                o.put("altitude", loc.hasAltitude() ? loc.getAltitude() : JSONObject.NULL);
                o.put("hasAltitudeField", true);
                o.put("mock", isMock(loc));
                o.put("provider", loc.getProvider());
                o.put("source", "android");
                o.put("ok", true);
            } catch (Exception ignore) {}
            lastResult = o.toString();   // picked up by the page's next pollResult()
        }
    }
}
