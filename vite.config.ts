import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const BUILD_ID = Date.now().toString(36);
// From package.json, so the version is right however the build is started (npm script or npx).
const VERSION: string = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

/** Emits the list of files the service worker precaches so the app shell works offline. */
function precacheManifest(): Plugin {
  return {
    name: "ledgerfox-precache-manifest",
    apply: "build",
    generateBundle(_opts, bundle) {
      const built = Object.keys(bundle).filter((f) => !f.endsWith(".html") && !f.endsWith(".map")).map((f) => `/${f}`);
      const statics = ["/", "/favicon.svg", "/theme.js", "/manifest.webmanifest", "/brand/icon-192.png"];
      this.emitFile({ type: "asset", fileName: "precache-manifest.json", source: JSON.stringify({ version: BUILD_ID, files: [...statics, ...built] }) });
      // Open tabs compare this with their own build to offer "Reload to update".
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: BUILD_ID, version: VERSION }) });
    },
  };
}

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID), __APP_VERSION__: JSON.stringify(VERSION) },
  root: "src/web",
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  plugins: [react(), tailwindcss(), precacheManifest()],
  resolve: { alias: { "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)) } },
  build: { outDir: fileURLToPath(new URL("./dist", import.meta.url)), emptyOutDir: true, sourcemap: false },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
