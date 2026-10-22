import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRINT_WORDS, UI_WORDS, bilingual, translate } from "../src/shared/i18n";
import { world } from "./helpers";

const DEVANAGARI = /[ऀ-ॿ]/, TAMIL = /[஀-௿]/;

describe("Hindi and Tamil wording", () => {
  it("has both languages, in the right script, for every entry", () => {
    for (const [en, t] of Object.entries({ ...PRINT_WORDS, ...UI_WORDS })) {
      expect(DEVANAGARI.test(t.hi), `${en} hi`).toBe(true);
      expect(TAMIL.test(t.ta), `${en} ta`).toBe(true);
    }
  });

  it("covers every sidebar label", () => {
    const layout = readFileSync(join(import.meta.dirname, "..", "src", "web", "components", "Layout.tsx"), "utf8");
    const nav = layout.slice(layout.indexOf("const NAV"), layout.indexOf("];", layout.indexOf("const NAV")));
    const labels = [...nav.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThan(30);
    expect(labels.filter((l) => !UI_WORDS[l])).toEqual([]);
  });

  it("prints English with the chosen language and falls back to English", () => {
    expect(bilingual("Qty", "hi")).toBe("Qty / मात्रा");
    expect(bilingual("Qty", "ta")).toBe("Qty / அளவு");
    expect(bilingual("Qty", "en")).toBe("Qty");
    expect(bilingual("Something new", "hi")).toBe("Something new");
    expect(translate("Customers", "ta")).toBe("வாடிக்கையாளர்கள்");
    expect(translate("Unlisted", "hi")).toBe("Unlisted");
  });

  it("stores the company's bill language", async () => {
    const W = await world();
    expect((await W.owner.patch(W.c("/settings"), { name: "Acme Traders", state_code: "29", print_language: "ta" })).status).toBe(200);
    expect((await W.owner.get(W.c("/settings"))).json.company.print_language).toBe("ta");
    expect((await W.owner.patch(W.c("/settings"), { name: "Acme Traders", state_code: "29" })).status).toBe(200);
    expect((await W.owner.get(W.c("/settings"))).json.company.print_language).toBe("ta");
    expect((await W.owner.patch(W.c("/settings"), { name: "Acme Traders", print_language: "fr" })).status).toBe(400);
  });
});
