// Runs the whole test suite against the desktop engine (Node SQLite) instead of D1. Cross-platform env handling.
import { spawnSync } from "node:child_process";
const r = spawnSync("npx", ["vitest", "run", ...process.argv.slice(2)], { stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, LEDGERFOX_TEST_DB: "sqlite" } });
process.exit(r.status ?? 1);
