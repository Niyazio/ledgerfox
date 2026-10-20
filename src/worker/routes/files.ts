import { Hono } from "hono";
import type { AppEnv } from "../env";
import { all, batch, first, stmt } from "../lib/db";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { newId, sha256Hex } from "../lib/crypto";
import { audit, requirePerm } from "../lib/auth";

const files = new Hono<AppEnv>();

export const MAX_ATTACHMENT_BYTES = 1024 * 1024; // D1 rows are limited in size; keep attachments small.
const ALLOWED: Record<string, (b: Uint8Array) => boolean> = {
  "application/pdf": (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45,
};
const ENTITY_TABLES: Record<string, string> = { expense: "expenses", document: "documents", journal: "journal_entries", payment: "payments", asset: "fixed_assets" };

files.post("/", async (c) => {
  requirePerm(c, "txn.write");
  const company = c.get("company");
  const entityType = c.req.query("entity_type") ?? "";
  const entityId = c.req.query("entity_id") ?? "";
  const filename = (c.req.query("filename") ?? "attachment").replace(/[^\w.\- ()]/g, "_").slice(0, 120);
  const table = ENTITY_TABLES[entityType];
  if (!table) throw badRequest("Unsupported entity type");
  if (!(await first(c.env.DB, `SELECT 1 FROM ${table} WHERE id = ? AND company_id = ?`, entityId, company.id))) throw notFound("Record");
  const mime = (c.req.header("content-type") ?? "").split(";")[0].trim();
  const check = ALLOWED[mime];
  if (!check) throw new AppError(415, "UNSUPPORTED_TYPE", "Only PDF, PNG, JPEG and WebP files are accepted");
  const len = Number(c.req.header("content-length") ?? "0");
  if (len > MAX_ATTACHMENT_BYTES) throw new AppError(413, "TOO_LARGE", "Files must be 1 MB or smaller");
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.byteLength === 0) throw badRequest("Empty file");
  if (buf.byteLength > MAX_ATTACHMENT_BYTES) throw new AppError(413, "TOO_LARGE", "Files must be 1 MB or smaller");
  if (!check(buf)) throw new AppError(415, "TYPE_MISMATCH", "File contents do not match the declared type");
  const count = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM attachments WHERE company_id = ? AND entity_type = ? AND entity_id = ?`, company.id, entityType, entityId);
  if ((count?.n ?? 0) >= 10) throw conflict("TOO_MANY", "At most 10 attachments per record");
  const id = newId();
  await batch(c.env.DB, [
    c.env.DB.prepare(`INSERT INTO attachments (id, company_id, entity_type, entity_id, filename, mime_type, size_bytes, sha256, data, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, company.id, entityType, entityId, filename, mime, buf.byteLength, await sha256Hex(buf), buf, c.get("user").id),
    audit(c, "attachment.upload", entityType, entityId, { filename, size: buf.byteLength }),
  ]);
  return c.json({ id }, 201);
});

files.get("/", async (c) => {
  const company = c.get("company");
  const rows = await all(c.env.DB,
    `SELECT id, filename, mime_type, size_bytes, created_at FROM attachments WHERE company_id = ? AND entity_type = ? AND entity_id = ? ORDER BY created_at`,
    company.id, c.req.query("entity_type") ?? "", c.req.query("entity_id") ?? "");
  return c.json({ attachments: rows });
});

files.get("/:id", async (c) => {
  const company = c.get("company");
  const r = await c.env.DB.prepare(`SELECT filename, mime_type, data FROM attachments WHERE id = ? AND company_id = ?`).bind(c.req.param("id"), company.id).first<{ filename: string; mime_type: string; data: number[] | ArrayBuffer }>();
  if (!r) throw notFound("Attachment");
  const bytes = r.data instanceof ArrayBuffer ? new Uint8Array(r.data) : new Uint8Array(r.data);
  return new Response(bytes, {
    headers: {
      "Content-Type": r.mime_type,
      "Content-Disposition": `${c.req.query("download") ? "attachment" : "inline"}; filename="${r.filename.replace(/"/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
});

files.delete("/:id", async (c) => {
  requirePerm(c, "txn.write");
  const company = c.get("company");
  const a = await first<{ entity_type: string; entity_id: string }>(c.env.DB, `SELECT entity_type, entity_id FROM attachments WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id);
  if (!a) throw notFound("Attachment");
  if (a.entity_type === "expense") {
    const e = await first<{ status: string }>(c.env.DB, `SELECT status FROM expenses WHERE id = ?`, a.entity_id);
    if (e?.status === "posted") throw conflict("POSTED_IMMUTABLE", "Receipts of posted expenses are retained for audit");
  }
  await batch(c.env.DB, [stmt(c.env.DB, `DELETE FROM attachments WHERE id = ? AND company_id = ?`, c.req.param("id"), company.id), audit(c, "attachment.delete", a.entity_type, a.entity_id)]);
  return c.json({ ok: true });
});

export default files;
