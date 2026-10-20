import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteD1 } from "./sqlite-d1";

/**
 * Apply pending migrations from `dir`, recorded in the same `d1_migrations` table wrangler uses, so a desktop data
 * file and the cloud database share one schema history.
 */
export function migrate(db: SqliteD1, dir: string): string[] {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  const done = new Set((db.raw.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name));
  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(dir, name), "utf8");
    db.raw.exec("BEGIN IMMEDIATE");
    try {
      db.raw.exec(sql);
      db.raw.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
      db.raw.exec("COMMIT");
    } catch (e) {
      db.raw.exec("ROLLBACK");
      throw new Error(`Migration ${name} failed: ${(e as Error).message}`, { cause: e });
    }
    applied.push(name);
  }
  return applied;
}
