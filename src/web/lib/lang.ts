import { useSyncExternalStore } from "react";
import { LANGS, isRtl, translate, type Lang } from "@shared/i18n";

/** The app language is a per-device choice (navigation and POS; other screens stay in English). */
const KEY = "ledgerfox-lang";
const listeners = new Set<() => void>();
const read = (): Lang => { try { const v = localStorage.getItem(KEY); return LANGS.some((l) => l.value === v) ? (v as Lang) : "en"; } catch { return "en"; } };

export function setLang(lang: Lang) {
  try { localStorage.setItem(KEY, lang); } catch { /* storage unavailable: keep for this page only */ }
  current = lang;
  applyDirection(lang);
  listeners.forEach((l) => l());
}
/** Arabic mirrors the layout (menu on the right, text from the right). */
function applyDirection(lang: Lang) {
  document.documentElement.lang = lang;
  document.documentElement.dir = isRtl(lang) ? "rtl" : "ltr";
}
let current: Lang = typeof window === "undefined" ? "en" : read();
if (typeof window !== "undefined") applyDirection(current);

export function useLang() {
  const lang = useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => current, () => "en" as Lang);
  return { lang, t: (en: string) => translate(en, lang) };
}
