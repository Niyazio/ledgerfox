// Builds every Foxlator logo file from one drawing: the geometric fox whose face is a calculator
// (forehead = display showing "=", cheeks = + / − keys).   node scripts/brand/logo.mjs   (CHROME_PATH optional)
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
import { APP_ICON, BLUE, FOX } from "./fox.mjs";
/** Android / PWA "maskable" icon: full blue square, fox inside the safe zone (centre 80%). */
const MASKABLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="${BLUE}"/><g transform="translate(30,26) scale(0.7)">${FOX}</g></svg>`;

writeFileSync(join(ROOT, "public", "favicon.svg"), APP_ICON + "\n");
writeFileSync(join(ROOT, "public", "brand", "foxlator-app-icon.svg"), APP_ICON + "\n");

const PNGS = [
  ["public/brand/icon-192.png", 192, APP_ICON], ["public/brand/icon-512.png", 512, APP_ICON], ["public/brand/icon-maskable-512.png", 512, MASKABLE],
  ["build/icon.png", 512, APP_ICON],
  ...[48, 72, 96, 144, 192].map((s) => [`mobile/icons/icon-${s}.png`, s, APP_ICON]),
];
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await browser.newPage();
for (const [file, size, svg] of PNGS) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  mkdirSync(join(ROOT, file, ".."), { recursive: true });
  await page.screenshot({ path: join(ROOT, file), omitBackground: true });
  console.log(file);
}
await browser.close();
