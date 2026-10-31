import { describe, expect, it } from "vitest";
import { SHORTCUTS, findShortcut, keyName } from "../src/web/lib/shortcuts";

const ev = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("keyboard shortcuts", () => {
  it("names keys the way they are listed (Cmd counts as Ctrl)", () => {
    expect(keyName(ev("F8"))).toBe("F8");
    expect(keyName(ev("F8", { ctrlKey: true }))).toBe("Ctrl+F8");
    expect(keyName(ev("F8", { altKey: true }))).toBe("Alt+F8");
    expect(keyName(ev("s", { metaKey: true }))).toBe("Ctrl+S");
    expect(keyName(ev("c", { altKey: true }))).toBe("Alt+C");
    expect(keyName(ev("k", { ctrlKey: true }))).toBe("Ctrl+K");
  });

  it("follows the familiar voucher keys and has aliases", () => {
    expect(findShortcut("F8")?.to).toBe("sales/invoice/new");
    expect(findShortcut("F9")?.to).toBe("purchases/bill/new");
    expect(findShortcut("F6")?.to).toBe("payments/in/new");
    expect(findShortcut("F5")?.to).toBe("payments/out/new");
    expect(findShortcut("F7")?.to).toBe("journals/new");
    expect(findShortcut("Ctrl+F8")?.to).toBe("sales/credit_note/new");
    expect(findShortcut("Ctrl+F9")?.to).toBe("purchases/debit_note/new");
    expect(findShortcut("Ctrl+K")?.action).toBe("goto");
    expect(findShortcut("Ctrl+Enter")?.action).toBe("post");
    expect(findShortcut("Q")).toBeUndefined(); // plain letters never trigger anything while typing
  });

  it("has no duplicate keys", () => {
    const keys = SHORTCUTS.map((s) => s.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
