package com.odo.fieldvisits;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.pm.PackageManager;
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

        web.setWebViewClient(new WebViewClient());
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

        String url = getString(R.string.web_app_url);
        if (url == null || url.length() < 10 || url.contains("PASTE_YOUR")) {
            web.loadData(
                "<html><body style='font-family:sans-serif;padding:24px;background:#0f1720;color:#eaf0f6'>"
                + "<h3>Setup needed</h3><p>The web app address has not been set. "
                + "Edit <b>app/src/main/res/values/config.xml</b> and rebuild.</p></body></html>",
                "text/html", "utf-8");
        } else {
            web.loadUrl(url);
        }
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

    /**
     * The object exposed to JavaScript as window.AndroidGPS.
     * Page→native only (works inside the Apps Script iframe, where a
     * native→page callback would not reach): the page calls
     * requestLocation() then polls pollResult(), which returns "" while
     * the fix is pending and a JSON string once it is ready.
     */
    private class GpsBridge {

        private volatile String lastResult = "";   // "" = pending

        @JavascriptInterface
        public String pollResult() { return lastResult; }

        @JavascriptInterface
        public void requestLocation() {
            lastResult = "";   // reset for a fresh fix
            if (!hasLoc()) {
                emit(null);
                runOnUiThread(new Runnable() { public void run() {
                    Toast.makeText(MainActivity.this,
                        "Please allow location for Field Visits", Toast.LENGTH_LONG).show();
                    if (!hasLoc()) ActivityCompat.requestPermissions(MainActivity.this,
                        new String[]{Manifest.permission.ACCESS_FINE_LOCATION}, REQ_LOC);
                }});
                return;
            }
            // Try a fresh single fix; fall back to last known.
            try {
                final boolean[] done = {false};
                final LocationListener once = new LocationListener() {
                    @Override public void onLocationChanged(@NonNull Location location) {
                        if (done[0]) return;
                        done[0] = true;
                        try { lm.removeUpdates(this); } catch (Exception ignore) {}
                        emit(location);
                    }
                    @Override public void onProviderDisabled(@NonNull String p) {}
                    @Override public void onProviderEnabled(@NonNull String p) {}
                    @Override public void onStatusChanged(String p, int st, Bundle e) {}
                };
                boolean gps = lm.isProviderEnabled(LocationManager.GPS_PROVIDER);
                final String provider = gps ? LocationManager.GPS_PROVIDER
                                            : LocationManager.NETWORK_PROVIDER;
                try {
                    lm.requestLocationUpdates(provider, 0L, 0f, once, Looper.getMainLooper());
                } catch (SecurityException se) { emit(null); return; }

                // Timeout after 10s -> use last known
                new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                    public void run() {
                        if (done[0]) return;
                        done[0] = true;
                        try { lm.removeUpdates(once); } catch (Exception ignore) {}
                        Location last = null;
                        try {
                            last = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER);
                            if (last == null) last = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
                        } catch (SecurityException ignore) {}
                        emit(last);
                    }
                }, 10000);
            } catch (Exception e) {
                emit(null);
            }
        }

        private void emit(Location loc) {
            JSONObject o = new JSONObject();
            try {
                if (loc == null) {
                    o.put("lat", JSONObject.NULL);
                    o.put("lon", JSONObject.NULL);
                    o.put("ok", false);
                } else {
                    o.put("lat", loc.getLatitude());
                    o.put("lon", loc.getLongitude());
                    o.put("accuracy", loc.hasAccuracy() ? loc.getAccuracy() : JSONObject.NULL);
                    o.put("altitude", loc.hasAltitude() ? loc.getAltitude() : JSONObject.NULL);
                    o.put("hasAltitudeField", true);
                    o.put("mock", isMock(loc));
                    o.put("source", "android");
                    o.put("ok", true);
                }
            } catch (Exception ignore) {}
            lastResult = o.toString();   // picked up by the page's next pollResult()
        }
    }
}
