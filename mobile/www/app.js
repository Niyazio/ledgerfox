/* LedgerFox launcher: opens LedgerFox Cloud or a LedgerFox desktop on the local network. */
const CLOUD = "https://ledgerfox.niyazio.com/app";
const KEY = "ledgerfox-recent";
const $ = (id) => document.getElementById(id);

function recent() {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]").filter((u) => typeof u === "string").slice(0, 5); } catch { return []; }
}
function remember(url) {
  try { localStorage.setItem(KEY, JSON.stringify([url, ...recent().filter((u) => u !== url)].slice(0, 5))); } catch { /* storage unavailable */ }
}
function showError(msg) { const e = $("error"); e.textContent = msg; e.hidden = !msg; }

/** Accept only http(s) addresses of a LedgerFox server; never javascript:, file: or other schemes. */
function normalise(input) {
  let s = String(input || "").trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  return `${u.protocol}//${u.host}`;
}

async function open(url) {
  showError("");
  // Check it is really a LedgerFox server before leaving the launcher.
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(`${url}/api/health`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (!j || j.brand === undefined) throw new Error("not LedgerFox");
  } catch {
    showError(`Could not reach LedgerFox at ${url}. Check that the computer is on, LedgerFox is open with phone access turned on, and this phone is on the same Wi-Fi.`);
    return;
  }
  remember(url);
  location.href = `${url}/login`;
}

function renderRecent() {
  const ul = $("recent");
  ul.innerHTML = "";
  for (const u of recent()) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = `↻ ${u}`;
    b.addEventListener("click", () => open(u));
    li.appendChild(b);
    ul.appendChild(li);
  }
}

let stream = null;
async function scan() {
  showError("");
  if (!("BarcodeDetector" in window) || !navigator.mediaDevices?.getUserMedia) {
    showError("QR scanning is not supported on this phone. Type the address shown on the computer instead.");
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch {
    showError("Camera permission was denied. Allow camera access for LedgerFox in Android settings, or type the address.");
    return;
  }
  const video = $("video");
  video.srcObject = stream;
  $("scanner").hidden = false;
  await video.play();
  const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
  const tick = async () => {
    if (!stream) return;
    try {
      const codes = await detector.detect(video);
      const url = codes.length ? normalise(codes[0].rawValue) : null;
      if (url) { stopScan(); open(url); return; }
      if (codes.length) showError("That QR code is not a LedgerFox address.");
    } catch { /* frame not ready */ }
    requestAnimationFrame(tick);
  };
  tick();
}
function stopScan() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $("scanner").hidden = true;
}

$("cloud").addEventListener("click", () => { location.href = CLOUD; });
$("scan").addEventListener("click", scan);
$("stop").addEventListener("click", stopScan);
$("manual").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = normalise($("address").value);
  if (!url) { showError("Enter an address like http://192.168.1.20:4780"); return; }
  open(url);
});
renderRecent();
