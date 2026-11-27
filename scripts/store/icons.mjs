// Renders the Microsoft Store tile images (build/appx/*.png) from the Foxlator fox mark.
//   node scripts/store/icons.mjs        (CHROME_PATH optional)
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "..", "..", "build", "appx");
import { APP_ICON, BLUE, FOX } from "../brand/fox.mjs";
// The fox drawing fills 38–162 × 28–172 of its 200 × 200 box: crop to it so it centres on each tile.
const fox = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="30 22 140 156" width="${size}" height="${size}">${FOX}</svg>`;
const page = (w, h, body, bg) => `<html><body style="margin:0;width:${w}px;height:${h}px;background:${bg};display:flex;align-items:center;justify-content:center;gap:${Math.round(h * 0.08)}px;font-family:'Segoe UI',Inter,Arial,sans-serif">${body}</body></html>`;

// name, width, height, fox share of the height, with the word "Foxlator", background
const TILES = [
  ["StoreLogo", 50, 50, 0.8, false, BLUE],
  ["Square44x44Logo", 44, 44, 0.8, false, "transparent"],
  ["SmallTile", 71, 71, 0.6, false, BLUE],
  ["Square150x150Logo", 150, 150, 0.5, false, BLUE],
  ["Wide310x150Logo", 310, 150, 0.46, true, BLUE],
  ["LargeTile", 310, 310, 0.45, false, BLUE],
];

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
mkdirSync(OUT, { recursive: true });
for (const scale of [1, 2]) {
  const ctx = await browser.newContext({ deviceScaleFactor: scale });
  const p = await ctx.newPage();
  for (const [name, w, h, share, word, bg] of TILES) {
    // Square44x44 is the taskbar / Start icon: a blue rounded square, like the app icon.
    const mark = name === "Square44x44Logo"
      ? APP_ICON.replace("<svg ", `<svg width="${w}" height="${h}" `)
      : fox(Math.round(h * share));
    const text = word ? `<span style="color:#fff;font-size:${Math.round(h * 0.2)}px;font-weight:600;letter-spacing:-0.5px">Foxlator</span>` : "";
    await p.setViewportSize({ width: w, height: h });
    await p.setContent(page(w, h, mark + text, bg));
    const file = join(OUT, `${name}${scale === 1 ? "" : ".scale-200"}.png`);
    await p.screenshot({ path: file, omitBackground: bg === "transparent" });
    console.log(file);
  }
  await ctx.close();
}
await browser.close();
