/**
 * Headless LedgerFox server for an always-on office computer or mini-PC.
 *   node ledgerfox-server.mjs --data "C:\LedgerFox\Data\My Business.ledgerfox" [--port 4780] [--lan]
 * Without --lan only this computer can connect; with --lan, phones and PCs on the same network can too.
 */
import { resolve, join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { startServer } from "./http";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const here = dirname(fileURLToPath(import.meta.url));
const dataFile = resolve(arg("data") ?? "LedgerFox.ledgerfox");
const lan = process.argv.includes("--lan");
mkdirSync(dirname(dataFile), { recursive: true });

const server = await startServer({
  dataFile,
  webDir: resolve(arg("web") ?? join(here, "..", "dist")),
  migrationsDir: resolve(arg("migrations") ?? join(here, "..", "migrations")),
  host: lan ? "0.0.0.0" : "127.0.0.1",
  port: Number(arg("port") ?? 4780),
});
console.log(`LedgerFox is running. Data file: ${dataFile}`);
console.log(`  This computer: http://127.0.0.1:${server.port}`);
if (lan) for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) console.log(`  Same network:  http://${a.address}:${server.port}`);
const stop = async () => { await server.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
