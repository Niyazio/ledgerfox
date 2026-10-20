# LedgerFox Desktop (Windows, macOS, Linux)

The desktop edition runs LedgerFox entirely on one computer. It is free (MIT licence) and needs no account,
subscription or internet connection. It uses the same accounting engine, database rules and screens as the cloud
edition; the full automated test suite runs against both (`npm test` and `npm run test:desktop`).

## Install

| System | File | First launch |
|---|---|---|
| Windows 10/11 (64-bit) | `LedgerFox-Setup-<version>-x64.exe` | Windows SmartScreen may say "Windows protected your PC" because the installer is not code-signed. Click **More info → Run anyway**. |
| macOS (Apple Silicon) | `LedgerFox-<version>-arm64.dmg` | Drag LedgerFox to Applications. The first time, macOS blocks it (not notarised). Open **System Settings → Privacy & Security** and click **Open Anyway**. |
| macOS (Intel) | `LedgerFox-<version>-x64.dmg` | Same as above. |
| Linux | `LedgerFox-<version>-x86_64.AppImage` | `chmod +x` the file and run it. |

The warnings appear because code-signing certificates cost money (Windows: a few thousand rupees a year or more;
Apple Developer Program: US$99/year). Nothing was purchased. Installers are built by the free GitHub Actions workflow
`.github/workflows/desktop.yml` (Actions tab → *Desktop installers* → *Run workflow*, or push a tag such as `v0.2.0`
to publish a GitHub Release).

## Your data

- On first launch LedgerFox asks where to keep your accounts and creates one data file there, for example
  `C:\LedgerFox\Data\My Business.ledgerfox` or `~/Documents/LedgerFox/My Business.ledgerfox`.
- One data file can hold several companies. Use **File → New data file…** / **Open data file…** to keep separate files
  (e.g. one per client). Double-clicking a `.ledgerfox` file opens it.
- **Automatic backup:** once a day LedgerFox saves a dated copy in a `LedgerFox Backups` folder next to the data file
  and keeps the newest 14. **File → Back up now…** saves a copy anywhere (USB drive, Google Drive folder, etc.).
- Backups are consistent snapshots (SQLite `VACUUM INTO`), safe to take while the app is open. To restore, open the
  backup file with **File → Open data file…**.
- **First sign-in: username `admin`, password `admin`.** LedgerFox immediately asks for a new password (and lets you
  pick your own username). The default password works only on the computer itself — never from phones or the internet
  link — so nobody on the network can use it first.
- Add staff in **Settings → Users → Add a user** with a username and a temporary password; they choose their own
  password at first sign-in. Nobody can register themselves.
- The file is a standard SQLite database. It is **not encrypted** by LedgerFox; protect the computer with a login
  password and disk encryption (BitLocker / FileVault).
- Use one computer per data file. Do **not** open the same file from several computers over a shared network drive —
  that can corrupt it. For several users, use phone/network access below or the cloud edition.

## Use it on phones and other computers

**Same Wi-Fi / office network (free, no internet needed)** — **Access → Phones on the same Wi-Fi**. LedgerFox shows
an address like `http://192.168.1.20:4780` and a QR code. Scan it with the phone camera and sign in. The computer
must stay on with LedgerFox open. When Windows asks about the firewall, allow **private networks only**. Traffic is
plain http inside your network, so only use this on a network you trust.

**Anywhere over the internet (free, temporary)** — **Access → Start internet link…** starts a Cloudflare Quick
Tunnel: no Cloudflare account, card or router changes. The `cloudflared` program (~40 MB) is downloaded once from
Cloudflare's official GitHub releases. You get an `https://<random>.trycloudflare.com` address and QR code.
- Sign-in with the LedgerFox password is always required. The recommended option also asks Cloudflare to email a
  one-time code to the LedgerFox users' addresses before the login page is shown.
- The address is random and **changes every time** the link is started; it stops when LedgerFox closes or the
  computer sleeps or loses internet. Cloudflare describes Quick Tunnels as intended for testing, with no uptime
  guarantee. Treat it as a convenience, not a production service.
- A permanent address per client (e.g. `rao-traders.ledgerfox.niyazio.com`) is **not implemented**. It is possible
  for free with a small relay on the existing Cloudflare Workers account, or with named Cloudflare Tunnels on each
  client's own Cloudflare account; see PROJECT_STATUS.md.

## Android app

`LedgerFox-android.apk` (from the download page) opens LedgerFox Cloud or your office computer. On the computer turn on
**Access → Phones on the same Wi-Fi**, then in the app tap **Scan QR code** (or type the address). Android asks to
allow installing apps from your browser because the app is not on Google Play (publishing there needs a one-time
US$25 Google developer account). Builds are signed with your key when the repository secrets
`ANDROID_KEYSTORE_BASE64` and `ANDROID_KEYSTORE_PASSWORD` exist; otherwise with a temporary key, which means an
update must be installed after uninstalling the old app. To create a key once:

```bash
keytool -genkeypair -keystore ledgerfox.jks -alias ledgerfox -keyalg RSA -keysize 3072 -validity 10000
base64 -w0 ledgerfox.jks   # paste into the ANDROID_KEYSTORE_BASE64 secret; keep the .jks file and password safe
```

iPhone/iPad: open the cloud site in Safari → Share → Add to Home Screen (no App Store build).

## Always-on server without the window

For an office PC or mini-PC that stays on, the same server runs headless:

```bash
npm ci && npm run build:desktop
node --disable-warning=ExperimentalWarning server-build/ledgerfox-server.mjs --data "C:\LedgerFox\Data\My Business.ledgerfox" --lan
```

Without `--lan` only that computer can connect. Requires Node.js 22.13 or later.

## Moving to the cloud edition later

The desktop data file and the cloud database share the same schema and migration history (`d1_migrations`), and
password hashes use settings the cloud accepts. A self-service "move to cloud" import is **not implemented yet**;
until then, per-company JSON export (Settings → Data export) works in both editions.

## Build from source

```bash
npm ci
npm run desktop          # run the app in development
npm run dist:linux       # installer for the current Linux machine
npm run dist:win         # on Windows
npm run dist:mac         # on macOS (Windows/macOS installers must be built on those systems or in CI)
```
