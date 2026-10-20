import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Cloud, Monitor, QrCode, Smartphone, Trash2, Download as DownloadIcon } from "lucide-react";
import { setTransport } from "../lib/api";
import { useSession } from "../lib/session";
import { Wordmark, ProductCredit } from "../components/Layout";
import { Alert, Button, Card, Input } from "../components/ui";
import { deleteCopy, loadCopy, saveCopy, type OfflineCopy } from "../local/store";

const CLOUD = "https://ledgerfox.niyazio.com";
const REPO = "Niyazio/ledgerfox";
const RECENT = "ledgerfox-recent";

function normalise(input: string): URL | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return null;
    return u;
  } catch { return null; }
}

function recent(): string[] {
  try { return (JSON.parse(localStorage.getItem(RECENT) ?? "[]") as string[]).slice(0, 5); } catch { return []; }
}
function remember(origin: string) {
  try { localStorage.setItem(RECENT, JSON.stringify([origin, ...recent().filter((r) => r !== origin)].slice(0, 5))); } catch { /* unavailable */ }
}

function openExternal(url: string) {
  const browser = (globalThis as { Capacitor?: { Plugins?: { Browser?: { open: (o: { url: string }) => Promise<void> } } } }).Capacitor?.Plugins?.Browser;
  if (browser) void browser.open({ url });
  else window.open(url, "_blank");
}

const newer = (a: string, b: string) => {
  const x = a.replace(/^v/, "").split(".").map(Number), y = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/** Home screen of the Android app: cloud, live office computer, or the view-only copy saved on the phone. */
export default function MobileHome() {
  const nav = useNavigate();
  const { refresh } = useSession();
  const [copy, setCopy] = useState<OfflineCopy | null>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [update, setUpdate] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);

  useEffect(() => { loadCopy().then(setCopy).catch(() => undefined); }, []);
  useEffect(() => {
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`).then((r) => r.json() as Promise<{ tag_name?: string }>).then((r) => {
      if (r.tag_name && newer(r.tag_name, __APP_VERSION__)) setUpdate(r.tag_name);
    }).catch(() => undefined);
  }, []);

  const openCopy = async (c: OfflineCopy) => {
    setBusy("Opening offline copy");
    try {
      const { startEngine, offlineFetch } = await import("../local/engine");
      await startEngine(c.bytes);
      setTransport(offlineFetch);
      await refresh();
      nav("/login");
    } catch (e) {
      setError(`Could not open the offline copy: ${(e as Error).message}`);
    } finally { setBusy(null); }
  };

  const fromQr = async (raw: string) => {
    setError(null);
    const u = normalise(raw);
    if (!u) return setError("That is not a LedgerFox address.");
    if (/^\/api\/pair\/[A-Za-z0-9_-]+$/.test(u.pathname)) {
      // One-time code from the computer: download a view-only copy of the data file.
      setBusy("Copying data from the computer");
      try {
        const res = await fetch(u.toString());
        if (!res.ok) throw new Error(res.status === 404 ? "This code was already used or has expired. Show a new one on the computer." : `The computer answered ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (new TextDecoder().decode(bytes.slice(0, 15)) !== "SQLite format 3") throw new Error("The download was not a LedgerFox data file");
        const c: OfflineCopy = { bytes, savedAt: new Date().toISOString(), source: u.host, companies: (res.headers.get("x-ledgerfox-companies") ?? "").split("|").filter(Boolean).map((n) => { try { return decodeURIComponent(n); } catch { return n; } }) };
        await saveCopy(c);
        setCopy(c);
        await openCopy(c);
      } catch (e) {
        setError((e as Error).message.includes("Failed to fetch") ? "Could not reach the computer. Check that this phone is on the same Wi-Fi and phone access is on." : (e as Error).message);
      } finally { setBusy(null); }
      return;
    }
    setBusy("Connecting");
    try {
      const h = await fetch(`${u.origin}/api/health`).then((r) => r.json() as Promise<{ brand?: string }>);
      if (!h?.brand) throw new Error();
      remember(u.origin);
      location.href = `${u.origin}/login`;
    } catch {
      setError(`Could not reach LedgerFox at ${u.origin}. Check that the computer is on with phone access turned on and that this phone is on the same Wi-Fi.`);
      setBusy(null);
    }
  };

  const stopScan = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; setScanning(false); };
  const scan = async () => {
    setError(null);
    const Detector = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    if (!Detector || !navigator.mediaDevices?.getUserMedia) return setError("QR scanning is not available on this phone. Type the address shown on the computer instead.");
    try { stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }); }
    catch { return setError("Camera permission was denied. Allow camera access for LedgerFox in Android settings, or type the address."); }
    setScanning(true);
    requestAnimationFrame(async () => {
      if (!video.current || !stream.current) return;
      video.current.srcObject = stream.current;
      await video.current.play();
      const det = new Detector({ formats: ["qr_code"] });
      const tick = async () => {
        if (!stream.current || !video.current) return;
        try { const codes = await det.detect(video.current); if (codes[0]?.rawValue) { stopScan(); void fromQr(codes[0].rawValue); return; } } catch { /* frame not ready */ }
        requestAnimationFrame(tick);
      };
      void tick();
    });
  };

  return (
    <div className="mx-auto max-w-md px-4 py-8">
      <div className="mb-6 flex justify-center text-xl"><Wordmark iconClass="h-10 w-10" /></div>
      {update && <Alert kind="info" className="mb-4">LedgerFox {update} is available. <button className="font-semibold underline" onClick={() => openExternal(`https://github.com/${REPO}/releases/latest/download/LedgerFox-android.apk`)}>Download update</button></Alert>}
      {error && <Alert className="mb-4">{error}</Alert>}
      {busy && <Alert kind="info" className="mb-4">{busy}…</Alert>}
      <div className="space-y-4">
        <Card title={<span className="flex items-center gap-2"><Cloud className="h-4 w-4" />LedgerFox Cloud</span>}>
          <p className="mb-3 text-sm muted">Your company on ledgerfox.niyazio.com — live, from anywhere.</p>
          <Button className="w-full" onClick={() => { location.href = `${CLOUD}/app`; }}>Open LedgerFox Cloud</Button>
        </Card>
        <Card title={<span className="flex items-center gap-2"><Monitor className="h-4 w-4" />My office computer</span>}>
          <p className="mb-3 text-sm muted">On the computer open <b>Access → Phones on the same Wi-Fi</b> to work live, or <b>Access → Copy data to phone</b> to save a view-only copy here. Then scan the QR code.</p>
          <Button className="w-full" variant="secondary" onClick={scan}><QrCode className="h-4 w-4" />Scan QR code</Button>
          {scanning && <div className="mt-3"><video ref={video} playsInline muted className="w-full rounded-lg bg-black" /><Button className="mt-2 w-full" variant="secondary" onClick={stopScan}>Cancel</Button></div>}
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void fromQr(address); }}>
            <Input aria-label="Computer address" inputMode="url" autoCapitalize="none" placeholder="http://192.168.1.20:4780" value={address} onChange={(e) => setAddress(e.target.value)} />
            <Button type="submit" variant="secondary">Connect</Button>
          </form>
          {recent().map((r) => <button key={r} className="mt-2 block w-full rounded-lg border border-[var(--border)] px-3 py-2 text-left text-sm" onClick={() => void fromQr(r)}>↻ {r}</button>)}
        </Card>
        <Card title={<span className="flex items-center gap-2"><Smartphone className="h-4 w-4" />Offline copy on this phone</span>}>
          {copy ? (
            <>
              <p className="text-sm">Saved {new Date(copy.savedAt).toLocaleString()} from {copy.source}{copy.companies.length ? ` · ${copy.companies.join(", ")}` : ""}.</p>
              <p className="mb-3 mt-1 text-xs muted">View-only and works without internet. Sign in with your usual LedgerFox username and password. Scan a new code on the computer to refresh it.</p>
              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => void openCopy(copy)}><DownloadIcon className="h-4 w-4" />Open offline copy</Button>
                <Button variant="secondary" aria-label="Delete offline copy" onClick={async () => { if (confirm("Delete the offline copy from this phone?")) { await deleteCopy(); setCopy(null); } }}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </>
          ) : <p className="text-sm muted">No copy saved yet. Use <b>Access → Copy data to phone</b> on the computer and scan its QR code.</p>}
        </Card>
      </div>
      <ProductCredit className="mt-6 text-center" />
      <p className="mt-1 text-center text-xs muted">App version {__APP_VERSION__}</p>
    </div>
  );
}
