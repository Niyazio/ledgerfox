import { useEffect, useRef, useState } from "react";
import { Camera, ScanLine } from "lucide-react";
import { useCompany } from "../lib/company";
import { api, errorMessage } from "../lib/api";
import { Button, Field, Input, Modal } from "./ui";

/* Minimal typing for the browser's built-in barcode detector (Chrome/Edge/Android WebView; not every browser). */
interface Detected { rawValue: string }
interface Detector { detect(source: CanvasImageSource): Promise<Detected[]> }
declare global { interface Window { BarcodeDetector?: new (opts: { formats: string[] }) => Detector } }

export const cameraScanSupported = () => typeof window !== "undefined" && "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;

/** Camera scanner in a modal: calls `onCode` once with the first code it reads. */
function CameraScan({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(onCode);
  done.current = onCode;
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    (async () => {
      try {
        const detector = new window.BarcodeDetector!({ formats: ["qr_code", "code_128", "ean_13", "ean_8", "upc_a", "upc_e", "code_39"] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        while (!stop) {
          const found = await detector.detect(video.current).catch(() => []);
          if (found[0]?.rawValue) { done.current(found[0].rawValue); return; }
          await new Promise((r) => setTimeout(r, 200));
        }
      } catch (e) {
        setError((e as Error).name === "NotAllowedError" ? "Camera permission was refused." : `Camera unavailable: ${(e as Error).message}`);
      }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, []);
  return (
    <Modal open title="Scan with camera" onClose={onClose}>
      {error ? <p className="text-sm text-red-600">{error}</p> : <video ref={video} className="w-full rounded-lg bg-black" muted playsInline />}
      <p className="mt-2 text-xs muted">Point the camera at the product QR code or barcode.</p>
    </Modal>
  );
}

/**
 * Scan box for billing, purchases, stock and labels. Works with a USB/Bluetooth barcode scanner (it types the code
 * and presses Enter), the device camera where the browser supports it, or typing the code by hand.
 */
export function ScanInput({ label = "Scan product", onItem, onError, autoFocus }: { label?: string; onItem: (item: any) => void; onError?: (msg: string) => void; autoFocus?: boolean }) {
  const { path } = useCompany();
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(false);
  const look = async (code: string) => {
    const c = code.trim();
    if (!c) return;
    setBusy(true);
    try {
      const r = await api.get<{ item: any }>(path(`/items/lookup?code=${encodeURIComponent(c)}`));
      onItem(r.item);
      setV("");
    } catch (e) {
      onError?.(errorMessage(e));
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
        {camera && <CameraScan onClose={() => setCamera(false)} onCode={(code) => { setCamera(false); void look(code); }} />}
      </div>
    )}</Field>
  );
}
