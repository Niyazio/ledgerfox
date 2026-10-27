import { useSyncExternalStore } from "react";
import { translate, type Lang } from "@shared/i18n";

/** The app language is a per-device choice (navigation and POS; other screens stay in English). */
const KEY = "ledgerfox-lang";
const listeners = new Set<() => void>();
const read = (): Lang => { try { const v = localStorage.getItem(KEY); return v === "hi" || v === "ta" ? v : "en"; } catch { return "en"; } };

export function setLang(lang: Lang) {
  try { localStorage.setItem(KEY, lang); } catch { /* storage unavailable: keep for this page only */ }
  current = lang;
  document.documentElement.lang = lang;
  listeners.forEach((l) => l());
}
let current: Lang = typeof window === "undefined" ? "en" : read();

export function useLang() {
  const lang = useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => current, () => "en" as Lang);
  return { lang, t: (en: string) => translate(en, lang) };
}
