// Renders the Microsoft Store tile images (build/appx/*.png) from the Foxlator fox mark.
//   node scripts/store/icons.mjs        (CHROME_PATH optional)
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "..", "..", "build", "appx");
const BLUE = "#1d4ed8";
// The fox from public/favicon.svg, without its blue square (the tile colour is the background).
const FOX = `<path d="M6.5 5.5 13 11.5h6l6.5-6v10.5L16 27 6.5 16z" fill="#fff"/><path d="M8.6 8.9 11.4 11.5 8.6 13.9z M23.4 8.9 20.6 11.5 23.4 13.9z" fill="#93c5fd"/><path d="M6.5 16 16 27l-4.6-9.6z M25.5 16 16 27l4.6-9.6z" fill="#dbeafe"/><circle cx="12.4" cy="15.6" r="1.25" fill="#172554"/><circle cx="19.6" cy="15.6" r="1.25" fill="#172554"/><path d="M14.6 20.6h2.8L16 22.4z" fill="#172554"/>`;
const fox = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 3.5 24 24" width="${size}" height="${size}">${FOX}</svg>`;
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
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${w}" height="${h}"><rect width="32" height="32" rx="7" fill="${BLUE}"/>${FOX}</svg>`
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
