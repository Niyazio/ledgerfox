// After `cap add android`: app icons, cleartext (office-network http), camera permission, the in-app updater, version from CI.
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const res = "android/app/src/main/res";
for (const [dir, file] of [["mipmap-mdpi", "48"], ["mipmap-hdpi", "72"], ["mipmap-xhdpi", "96"], ["mipmap-xxhdpi", "144"], ["mipmap-xxxhdpi", "192"]]) {
  for (const name of ["ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"]) {
    if (existsSync(join(res, dir))) copyFileSync(`icons/icon-${file}.png`, join(res, dir, name));
  }
}
rmSync(join(res, "mipmap-anydpi-v26"), { recursive: true, force: true });

const manifest = "android/app/src/main/AndroidManifest.xml";
let m = readFileSync(manifest, "utf8");
if (!m.includes("usesCleartextTraffic")) m = m.replace("<application", '<application android:usesCleartextTraffic="true"');
if (!m.includes("android.permission.CAMERA")) m = m.replace("<application", '<uses-permission android:name="android.permission.CAMERA" />\n    <application');
// In-app updates: the app downloads the new APK itself and opens Android's installer (one tap on "Install").
if (!m.includes("REQUEST_INSTALL_PACKAGES")) m = m.replace("<application", '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />\n    <application');
writeFileSync(manifest, m);

// The FileProvider that Capacitor sets up must be able to hand the downloaded APK (in the app's cache) to the installer.
const paths = "android/app/src/main/res/xml/file_paths.xml";
if (existsSync(paths)) {
  let x = readFileSync(paths, "utf8");
  if (!x.includes('name="lf_updates"')) x = x.replace("</paths>", '    <cache-path name="lf_updates" path="updates/" />\n</paths>');
  writeFileSync(paths, x);
} else {
  writeFileSync(paths, '<?xml version="1.0" encoding="utf-8"?>\n<paths xmlns:android="http://schemas.android.com/apk/res/android">\n    <cache-path name="lf_updates" path="updates/" />\n</paths>\n');
}

const javaDir = "android/app/src/main/java/com/niyazio/ledgerfox";
writeFileSync(join(javaDir, "ApkUpdaterPlugin.java"), `package com.niyazio.ledgerfox;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Downloads a new LedgerFox APK from the project's GitHub releases and opens Android's installer for it. */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {
    private static final String ALLOWED = "https://github.com/Niyazio/ledgerfox/releases/download/";

    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject r = new JSObject();
        r.put("allowed", Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(r);
    }

    @PluginMethod
    public void install(PluginCall call) {
        final String url = call.getString("url", "");
        if (!url.startsWith(ALLOWED) || !url.endsWith(".apk")) { call.reject("Only LedgerFox releases can be installed"); return; }
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
            call.reject("Allow LedgerFox to install updates (the setting just opened), then tap Update again.", "PERMISSION");
            return;
        }
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("Could not prepare the download folder");
                File out = new File(dir, "LedgerFox-update.apk");
                String target = url;
                // GitHub answers with redirects to its download servers; follow up to 5 of them (https only).
                for (int i = 0; i < 5; i++) {
                    conn = (HttpURLConnection) new URL(target).openConnection();
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(20000);
                    conn.setReadTimeout(60000);
                    int code = conn.getResponseCode();
                    if (code >= 300 && code < 400) {
                        String next = conn.getHeaderField("Location");
                        conn.disconnect();
                        if (next == null || !next.startsWith("https://")) throw new Exception("Unexpected download address");
                        target = next;
                        continue;
                    }
                    if (code != 200) throw new Exception("Download failed (" + code + ")");
                    break;
                }
                long total = conn.getContentLength();
                long done = 0;
                int last = -1;
                try (InputStream in = conn.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        os.write(buf, 0, n);
                        done += n;
                        int pct = total > 0 ? (int) (done * 100 / total) : -1;
                        if (pct != last) {
                            last = pct;
                            JSObject p = new JSObject();
                            p.put("percent", pct);
                            notifyListeners("progress", p);
                        }
                    }
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", out);
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(uri, "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(install);
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "The update could not be downloaded" : e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }
}
`);
writeFileSync(join(javaDir, "MainActivity.java"), `package com.niyazio.ledgerfox;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ApkUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`);

const gradle = "android/app/build.gradle";
let g = readFileSync(gradle, "utf8");
const code = Number(process.env.VERSION_CODE || 1);
const name = (process.env.VERSION_NAME || JSON.parse(readFileSync("package.json", "utf8")).version).replace(/^v/, "");
g = g.replace(/versionCode \d+/, `versionCode ${code}`).replace(/versionName "[^"]*"/, `versionName "${name}"`);
writeFileSync(gradle, g);
console.log(`Android project prepared (version ${name}, code ${code}).`);
