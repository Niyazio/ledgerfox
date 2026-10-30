import { useEffect, useRef, useState } from "react";
import { Camera, ScanLine } from "lucide-react";
import { useCompany } from "../lib/company";
import { api, errorMessage } from "../lib/api";
import { Button, Field, Input, Modal } from "./ui";

/* Minimal typing for the browser's built-in barcode detector (Chrome/Edge/Android WebView; not every browser). */
interface Detected { rawValue: string }
interface Detector { detect(source: CanvasImageSource): Promise<Detected[]> }
declare global { interface Window { BarcodeDetector?: new (opts: { formats: string[] }) => Detector } }

/** Live video needs a secure page (https or this computer); otherwise the phone's camera app takes a photo. */
const liveCameraPossible = () => typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
/** Scanning is always offered: live where possible, from a photo everywhere else. */
export const cameraScanSupported = () => typeof window !== "undefined";

/** A short beep and buzz when a code is read (where the device allows it). */
function confirmRead() {
  try { navigator.vibrate?.(60); } catch { /* not supported */ }
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 1400; g.gain.value = 0.08;
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.08);
    o.onended = () => void ctx.close();
  } catch { /* no audio */ }
}

/**
 * Camera scanner in a modal: calls `onCode` with the first code it reads. With `continuous` (billing on a phone) the
 * camera stays open and every new code is passed on; the same code is read again only after a short pause.
 */
function CameraScan({ onCode, onClose, continuous = false, status }: { onCode: (code: string) => void; onClose: () => void; continuous?: boolean; status?: string | null }) {
  const video = useRef<HTMLVideoElement>(null);
  const [mode, setMode] = useState<"live" | "photo">(liveCameraPossible() ? "live" : "photo");
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const done = useRef(onCode);
  done.current = onCode;
  useEffect(() => {
    if (mode !== "live") return;
    let stream: MediaStream | null = null;
    let stop = false;
    (async () => {
      try {
        // The browser's own detector when it has one (fast); otherwise ZXing on video frames.
        const native = window.BarcodeDetector ? new window.BarcodeDetector({ formats: ["qr_code", "code_128", "ean_13", "ean_8", "upc_a", "upc_e", "code_39"] }) : null;
        const { decodeVideoFrame } = await import("../lib/scanDecode");
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } } });
        if (!video.current || stop) return;
        video.current.srcObject = stream;
        await video.current.play();
        let lastCode = "", lastAt = 0;
        while (!stop) {
          const code = native ? (await native.detect(video.current).catch(() => []))[0]?.rawValue ?? null : await decodeVideoFrame(video.current).catch(() => null);
          if (code && (code !== lastCode || Date.now() - lastAt > 2500)) {
            lastCode = code; lastAt = Date.now();
            confirmRead();
            done.current(code);
            if (!continuous) return;
            await new Promise((r) => setTimeout(r, 900));
          }
          await new Promise((r) => setTimeout(r, native ? 200 : 300));
        }
      } catch (e) {
        const name = (e as Error).name;
        setError(name === "NotAllowedError" ? "Camera permission was refused. Allow the camera for this site, or use a photo." : "The live camera is not available here. Take a photo of the code instead.");
        setMode("photo");
      }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [mode, continuous]);
  const fromPhoto = async (file: File | undefined) => {
    if (!file) return;
    setReading(true); setError(null);
    try {
      const { decodeImageFile } = await import("../lib/scanDecode");
      const code = await decodeImageFile(file);
      if (code) { confirmRead(); done.current(code); }
      else setError("No code found in the photo. Hold the phone steady, close to the code, in good light, and try again.");
    } catch (e) { setError(`Could not read the photo: ${(e as Error).message}`); }
    finally { setReading(false); }
  };
  return (
    <Modal open title="Scan with camera" onClose={onClose}>
      {mode === "live" ? <>
        <video ref={video} className="w-full rounded-lg bg-black" muted playsInline />
        <p className="mt-2 text-xs muted">{continuous ? "Point at each product's QR code or barcode in turn: every scan is added to the bill. Close when done." : "Point the camera at the product QR code or barcode."}</p>
        {status && <p className="mt-1 rounded-lg bg-emerald-50 px-2 py-1 text-sm font-medium text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200" role="status">{status}</p>}
        <button className="mt-1 text-xs text-brand-700 underline dark:text-brand-300" onClick={() => setMode("photo")}>Use a photo instead</button>
      </> : <>
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-[var(--border)] p-6 text-center hover:border-brand-500">
          <Camera className="h-8 w-8 text-brand-600" />
          <span className="font-medium">{reading ? "Reading…" : "Take a photo of the code"}</span>
          <span className="text-xs muted">Opens the camera. Fill most of the photo with the QR code or barcode.</span>
          <input type="file" accept="image/*" capture="environment" className="sr-only" disabled={reading} onChange={(e) => { void fromPhoto(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
      </>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </Modal>
  );
}

/**
 * Scan box for billing, purchases, stock and labels. Works with a USB/Bluetooth barcode scanner (it types the code
 * and presses Enter), the device camera where the browser supports it, or typing the code by hand.
 */
export function ScanInput({ label = "Scan product", onItem, onError, autoFocus, continuous = false }: { label?: string; onItem: (item: any) => void; onError?: (msg: string) => void; autoFocus?: boolean; continuous?: boolean }) {
  const { path } = useCompany();
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const look = async (code: string) => {
    const c = code.trim();
    if (!c) return;
    setBusy(true);
    try {
      const r = await api.get<{ item: any }>(path(`/items/lookup?code=${encodeURIComponent(c)}`));
      onItem(r.item);
      setAdded(`Added: ${r.item.name}`);
      setV("");
    } catch (e) {
      onError?.(errorMessage(e));
      setAdded(`Not found: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Field label={label} hint="USB scanner, camera, or type the code and press Enter">{(fid) => (
      <div className="flex gap-2">
        <div className="relative flex-1">
          <ScanLine className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 muted" />
          <Input id={fid} className="pl-8 font-mono" value={v} autoFocus={autoFocus} autoComplete="off" spellCheck={false} placeholder="Product code / barcode"
            onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void look(v); } }} disabled={busy} />
        </div>
        {cameraScanSupported() && <Button type="button" variant="secondary" onClick={() => setCamera(true)} aria-label="Scan with camera"><Camera className="h-4 w-4" /></Button>}
        {camera && <CameraScan continuous={continuous} status={continuous ? added : null} onClose={() => { setCamera(false); setAdded(null); }}
          onCode={(code) => { if (!continuous) setCamera(false); void look(code); }} />}
      </div>
    )}</Field>
  );
}
