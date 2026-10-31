import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Keyboard } from "lucide-react";
import { useCompany } from "../lib/company";
import { useLang } from "../lib/lang";
import { SHORTCUTS, findShortcut, keyName, type Shortcut } from "../lib/shortcuts";
import { Modal } from "./ui";
import type { Permission } from "@shared/permissions";

export interface GotoItem { to: string; label: string; group?: string; perm?: Permission | Permission[] }

const visible = (el: Element | null): el is HTMLButtonElement => !!el && !(el as HTMLButtonElement).disabled && (el as HTMLElement).offsetParent !== null;

/** The button Ctrl+S / Ctrl+A should press: inside the open pop-up first, then on the page. */
function target(kind: "save" | "post"): HTMLButtonElement | null {
  const dialogs = document.querySelectorAll('[role="dialog"]');
  const dialog = dialogs[dialogs.length - 1] ?? null;
  const scope: Element | Document = dialog ?? document;
  const pick = (k: string) => [...scope.querySelectorAll(`[data-shortcut="${k}"]`)].reverse().find(visible) ?? null;
  const own = kind === "save" ? pick("save") ?? pick("post") : pick("post") ?? pick("save");
  if (own) return own as HTMLButtonElement;
  if (dialog) {
    // Pop-ups put their main button last in the footer.
    const buttons = [...dialog.querySelectorAll("[data-modal-footer] button")].filter(visible);
    return (buttons[buttons.length - 1] as HTMLButtonElement) ?? null;
  }
  return null;
}

function GotoPalette({ items, onClose }: { items: (GotoItem & { keys?: string })[]; onClose: () => void }) {
  const nav = useNavigate();
  const { id } = useCompany();
  const { t } = useLang();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = items.filter((i) => words.every((w) => `${i.label} ${t(i.label)} ${i.group ?? ""} ${i.keys ?? ""}`.toLowerCase().includes(w))).slice(0, 12);
  const go = (i: GotoItem) => { onClose(); nav(`/app/${id}/${i.to}`); };
  return (
    <Modal open title="Go to" onClose={onClose}>
      <input ref={input} className="input w-full" placeholder="Type a screen or action, e.g. invoice, GST, stock, new customer" value={q}
        aria-label="Search screens" onChange={(e) => { setQ(e.target.value); setSel(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, list.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
          else if (e.key === "Enter" && list[sel]) { e.preventDefault(); go(list[sel]); }
        }} />
      <ul className="mt-2 max-h-80 overflow-y-auto" role="listbox" aria-label="Screens">
        {list.map((i, n) => (
          <li key={`${i.to}-${i.label}`} role="option" aria-selected={n === sel}>
            <button className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${n === sel ? "bg-brand-50 text-brand-800 dark:bg-brand-900/30 dark:text-brand-200" : "hover:bg-[var(--surface-2)]"}`}
              onMouseEnter={() => setSel(n)} onClick={() => go(i)}>
              <span>{t(i.label)}{i.group && <span className="ml-2 text-xs muted">{t(i.group)}</span>}</span>
              {i.keys && <kbd className="rounded border border-[var(--border)] px-1.5 py-0.5 font-mono text-[11px]">{i.keys}</kbd>}
            </button>
          </li>
        ))}
        {!list.length && <li className="px-3 py-4 text-sm muted">Nothing matches “{q}”.</li>}
      </ul>
      <p className="mt-2 text-xs muted">↑ ↓ to move, Enter to open, Esc to close.</p>
    </Modal>
  );
}

function HelpSheet({ list, onClose }: { list: Shortcut[]; onClose: () => void }) {
  const groups = [...new Set(list.map((s) => s.group))];
  return (
    <Modal open title="Keyboard shortcuts" onClose={onClose}>
      <div className="grid gap-4 sm:grid-cols-2">
        {groups.map((g) => (
          <section key={g}>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider muted">{g}</h3>
            <ul className="space-y-1 text-sm">
              {list.filter((s) => s.group === g).map((s) => (
                <li key={s.keys} className="flex items-center justify-between gap-3">
                  <span>{s.label}</span><kbd className="shrink-0 rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[11px]">{s.keys}</kbd>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="mt-4 text-xs muted">Voucher keys follow the layout most accountants already know from other accounting software. At the POS counter, F2 searches and F9 takes payment.</p>
    </Modal>
  );
}

/** Global keyboard shortcuts, the Go-to search (Alt+G / Ctrl+K) and the shortcut list (F1), plus a keyboard button. */
export function Shortcuts({ items }: { items: GotoItem[] }) {
  const { id, can } = useCompany();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState<"goto" | "help" | null>(null);
  const allowed = useMemo(() => SHORTCUTS.filter((s) => !s.perm || can(s.perm)), [can]);
  const allowedItems = useMemo(() => items.filter((i) => !i.perm || (Array.isArray(i.perm) ? i.perm.some(can) : can(i.perm))), [items, can]);
  const gotoList = useMemo(() => [
    ...allowed.filter((s) => s.to).map((s) => ({ to: s.to!, label: s.label, group: s.group === "Vouchers (familiar keys)" ? "New" : s.group, keys: s.keys })),
    ...allowedItems,
  ], [allowed, allowedItems]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const name = keyName(e);
      const s = findShortcut(name);
      if (!s) return;
      // The POS counter has its own F-keys (F2 search, F9 pay); leave those to it.
      if (/\/pos$/.test(pathname) && /^F\d+$/.test(name) && name !== "F1") return;
      if (s.perm && !can(s.perm)) return;
      if (s.to) { e.preventDefault(); setOpen(null); nav(`/app/${id}/${s.to}`); return; }
      if (s.action === "goto") { e.preventDefault(); setOpen("goto"); return; }
      if (s.action === "help") { e.preventDefault(); setOpen("help"); return; }
      if (s.action === "save" || s.action === "post") {
        const b = target(s.action);
        if (!b) return; // nothing to save here: Ctrl+A keeps meaning "select all"
        e.preventDefault();
        b.click();
        return;
      }
      if (s.action === "print") {
        const doc = /^\/app\/([^/]+)\/(?:sales|purchases)\/[a-z_]+\/([0-9a-f-]{20,})$/.exec(pathname);
        const pay = /^\/app\/([^/]+)\/payments\/view\/([0-9a-f-]{20,})$/.exec(pathname);
        if (doc) { e.preventDefault(); nav(`/print/${doc[1]}/document/${doc[2]}`); }
        else if (pay) { e.preventDefault(); nav(`/print/${pay[1]}/payment/${pay[2]}`); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pathname, can, nav, id]);

  return (
    <>
      <button onClick={() => setOpen("help")} className="hidden rounded-lg p-2 hover:bg-[var(--surface-2)] sm:inline-flex" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (F1) · Go to (Alt+G or Ctrl+K)">
        <Keyboard className="h-4 w-4" />
      </button>
      {open === "goto" && <GotoPalette items={gotoList} onClose={() => setOpen(null)} />}
      {open === "help" && <HelpSheet list={allowed} onClose={() => setOpen(null)} />}
    </>
  );
}
