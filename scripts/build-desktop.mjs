// Bundles the desktop main process and the headless server with esbuild (the web UI is built by Vite separately).
import { build } from "esbuild";

const common = { bundle: true, platform: "node", target: "node22", sourcemap: false, legalComments: "none", logLevel: "info" };
await build({ ...common, entryPoints: ["src/desktop/main.ts"], outfile: "desktop-build/main.cjs", format: "cjs", external: ["electron"] });
await build({
  ...common, entryPoints: ["src/server/cli.ts"], outfile: "server-build/ledgerfox-server.mjs", format: "esm",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
