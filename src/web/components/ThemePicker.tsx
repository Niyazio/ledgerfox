import { useEffect, useRef, useState } from "react";
import { Check, Palette } from "lucide-react";

/**
 * Appearance picker in the top bar: light / dark / follow the device, an accent colour and a background style.
 * Saved per browser (public/theme.js applies it before the first paint). Purely visual: printed bills are unchanged.
 */
export const ACCENTS = [
  { id: "", label: "Blue", swatch: "#1d4ed8" }, { id: "indigo", label: "Indigo", swatch: "#4338ca" },
  { id: "violet", label: "Violet", swatch: "#6d28d9" }, { id: "rose", label: "Rose", swatch: "#be123c" },
  { id: "amber", label: "Sunset", swatch: "#c2410c" }, { id: "emerald", label: "Emerald", swatch: "#047857" },
  { id: "teal", label: "Ocean", swatch: "#0f766e" }, { id: "slate", label: "Graphite", swatch: "#334155" },
] as const;
export const BACKGROUNDS = [
  { id: "", label: "Plain" }, { id: "glow", label: "Soft glow" }, { id: "gradient", label: "Gradient" },
  { id: "dots", label: "Dots" }, { id: "paper", label: "Warm paper" },
] as const;
type Mode = "light" | "dark" | "auto";

const read = (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } };
const write = (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* storage unavailable */ } };
const systemDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

export function applyAppearance(mode: Mode, accent: string, bg: string) {
  const root = document.documentElement;
  root.classList.toggle("dark", mode === "dark" || (mode === "auto" && systemDark()));
  if (accent) root.dataset.accent = accent; else delete root.dataset.accent;
  if (bg) root.dataset.bg = bg; else delete root.dataset.bg;
}

export function ThemePicker() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(() => (read("ledgerfox-theme") as Mode) || "auto");
  const [accent, setAccent] = useState(() => read("ledgerfox-accent"));
  const [bg, setBg] = useState(() => read("ledgerfox-bg"));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    applyAppearance(mode, accent, bg);
    write("ledgerfox-theme", mode === "auto" ? "" : mode); write("ledgerfox-accent", accent); write("ledgerfox-bg", bg);
  }, [mode, accent, bg]);
  useEffect(() => {
    if (mode !== "auto" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyAppearance("auto", accent, bg);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [mode, accent, bg]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);
  const chip = (on: boolean) => `rounded-lg border px-2.5 py-1 text-xs ${on ? "border-brand-600 bg-brand-50 font-medium text-brand-800 dark:bg-brand-900/40 dark:text-brand-200" : "border-[var(--border)] hover:bg-[var(--surface-2)]"}`;
  return (
    <div className="relative" ref={box}>
      <button onClick={() => setOpen(!open)} className="rounded-lg p-2 hover:bg-[var(--surface-2)]" aria-label="Appearance: theme, colour and background" aria-expanded={open} title="Appearance">
        <Palette className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-72 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl" role="dialog" aria-label="Appearance">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider muted">Theme</p>
          <div className="flex gap-1.5">
            {(["light", "dark", "auto"] as const).map((m) => <button key={m} className={chip(mode === m)} aria-pressed={mode === m} onClick={() => setMode(m)}>{m === "auto" ? "Device" : m === "light" ? "Light" : "Dark"}</button>)}
          </div>
          <p className="mb-1.5 mt-4 text-xs font-semibold uppercase tracking-wider muted">Colour</p>
          <div className="grid grid-cols-4 gap-2">
            {ACCENTS.map((a) => (
              <button key={a.id || "blue"} onClick={() => setAccent(a.id)} aria-pressed={accent === a.id} title={a.label} className="flex flex-col items-center gap-1 text-[11px]">
                <span className="flex h-8 w-8 items-center justify-center rounded-full ring-offset-2 ring-offset-[var(--surface)]" style={{ background: a.swatch, boxShadow: accent === a.id ? `0 0 0 2px var(--surface), 0 0 0 4px ${a.swatch}` : undefined }}>
                  {accent === a.id && <Check className="h-4 w-4 text-white" />}
                </span>{a.label}
              </button>
            ))}
          </div>
          <p className="mb-1.5 mt-4 text-xs font-semibold uppercase tracking-wider muted">Background</p>
          <div className="flex flex-wrap gap-1.5">
            {BACKGROUNDS.map((b) => <button key={b.id || "plain"} className={chip(bg === b.id)} aria-pressed={bg === b.id} onClick={() => setBg(b.id)}>{b.label}</button>)}
          </div>
          <button className="mt-4 text-xs muted hover:underline" onClick={() => { setMode("auto"); setAccent(""); setBg(""); }}>Reset to default</button>
        </div>
      )}
    </div>
  );
}
