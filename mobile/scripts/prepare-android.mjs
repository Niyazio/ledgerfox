// After `cap add android`: app icons, cleartext (office-network http) and camera permission, version from CI.
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
writeFileSync(manifest, m);

const gradle = "android/app/build.gradle";
let g = readFileSync(gradle, "utf8");
const code = Number(process.env.VERSION_CODE || 1);
const name = (process.env.VERSION_NAME || JSON.parse(readFileSync("package.json", "utf8")).version).replace(/^v/, "");
g = g.replace(/versionCode \d+/, `versionCode ${code}`).replace(/versionName "[^"]*"/, `versionName "${name}"`);
writeFileSync(gradle, g);
console.log(`Android project prepared (version ${name}, code ${code}).`);
