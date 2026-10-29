import { Hono } from "hono";
import type { AppEnv } from "./env";
import { AppError, fromDbError } from "./lib/errors";
import { requireAuth, requireCompany } from "./lib/auth";
import { idempotency } from "./lib/idempotency";
import { newId } from "./lib/crypto";
import authRoutes from "./routes/auth";
import orgRoutes, { invitations } from "./routes/orgs";
import settings from "./routes/settings";
import accounts from "./routes/accounts";
import journals from "./routes/journals";
import contacts from "./routes/contacts";
import items from "./routes/items";
import documents from "./routes/documents";
import payments from "./routes/payments";
import expenses from "./routes/expenses";
import banking from "./routes/banking";
import assets from "./routes/assets";
import reports from "./routes/reports";
import daybook from "./routes/daybook";
import imports from "./routes/imports";
import recurring from "./routes/recurring";
import priceLists from "./routes/priceLists";
import production from "./routes/production";
import clients from "./routes/clients";
import assistant from "./routes/assistant";
import pos from "./routes/pos";
import files from "./routes/files";
import exportdata from "./routes/exportdata";
import payroll from "./routes/payroll";
import { verifyPublic, verifyToken } from "./routes/verify";
import backups from "./routes/backups";
import { VERSION } from "./version";
import billing from "./routes/billing";
import { autopayRequired, hasFeature, requireFeature } from "./services/billing";


const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  const requestId = c.req.header("cf-ray") ?? newId();
  c.set("requestId", requestId);
  await next();
  c.header("X-Request-Id", requestId);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "DENY");
  if (new URL(c.req.url).protocol === "https:") c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  c.header("Cache-Control", c.res.headers.get("Cache-Control") ?? "no-store");
});

/**
 * CSRF defence for cookie-authenticated mutations: require a custom header (forces a CORS preflight that
 * we never approve cross-origin) and, when present, an Origin matching the request host.
 */
app.use("/api/*", async (c, next) => {
  const m = c.req.method;
  // Razorpay's webhook carries no cookies and is authenticated by its HMAC signature instead.
  if (c.req.path === "/api/billing/webhook") return next();
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
    if (c.req.header("x-requested-with") !== "ledgerfox") throw new AppError(403, "CSRF", "Missing request header");
    const origin = c.req.header("origin");
    if (origin && new URL(origin).host !== new URL(c.req.url).host) throw new AppError(403, "CSRF", "Cross-origin request rejected");
  }
  await next();
});

/** Where the download page sends people. Installers (~100 MB) live on GitHub Releases: free, and too big for Workers assets. */
app.get("/api/downloads", (c) => {
  const repo = c.env.GITHUB_REPO && /^[\w.-]+\/[\w.-]+$/.test(c.env.GITHUB_REPO) ? c.env.GITHUB_REPO : null;
  const latest = repo ? `https://github.com/${repo}/releases/latest/download/` : null;
  return c.json({
    available: Boolean(repo),
    releases_page: repo ? `https://github.com/${repo}/releases/latest` : null,
    files: latest ? {
      windows: `${latest}LedgerFox-Setup-x64.exe`,
      mac_arm64: `${latest}LedgerFox-mac-arm64.dmg`,
      mac_x64: `${latest}LedgerFox-mac-x64.dmg`,
      linux: `${latest}LedgerFox-linux-x86_64.AppImage`,
      android: `${latest}LedgerFox-android.apk`,
    } : null,
  });
});

app.get("/api/health", async (c) => {
  let db = "ok";
  try {
    await c.env.DB.prepare("SELECT 1").first();
  } catch {
    db = "error";
  }
  // Public and non-sensitive; readable cross-origin so the Android launcher can confirm an address is a LedgerFox server.
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({ status: db === "ok" ? "ok" : "degraded", db, version: VERSION, brand: c.env.BRAND_NAME ?? "LedgerFox", time: new Date().toISOString() }, db === "ok" ? 200 : 503);
});

app.route("/api/auth", authRoutes);
app.route("/api/orgs", orgRoutes);
app.route("/api/invitations", invitations);
app.route("/api/verify", verifyPublic);
app.route("/api/backups", backups);
app.route("/api/billing", billing);
app.route("/api/clients", clients);

const company = new Hono<AppEnv>();
company.use("*", requireAuth, requireCompany, idempotency);
// Free trial with auto-pay required: everything can be viewed, but new entries wait until auto-pay is set up.
company.use("*", async (c, next) => {
  // Company set-up (details, logo, payment QR, branches) is always allowed: it comes before the trial screen.
  const setup = /^\/api\/c\/[^/]+\/settings(\/|$)/.test(c.req.path) || c.req.path.endsWith("/recurring/run");
  if (c.req.method !== "GET" && !setup && (await autopayRequired(c.env, c.get("company").org_id, c.get("user").email))) {
    throw new AppError(402, "AUTOPAY_REQUIRED", "Start your free trial first: set up auto-pay in Settings → Plan & billing. Razorpay takes ₹5 to check your UPI or card and refunds it; nothing is charged until the trial ends.");
  }
  await next();
});
// Plan features (hosted edition with billing on); registered before the routes so they run first.
company.use("/pos/*", async (c, next) => { await requireFeature(c, c.get("company").org_id, "pos"); await next(); });
company.use("/recurring/*", async (c, next) => {
  // The app's once-a-day background run has nothing to do on a plan without recurring invoices; say so quietly.
  if (c.req.method === "POST" && c.req.path.endsWith("/recurring/run") && c.req.query("auto") === "1" && !(await hasFeature(c, c.get("company").org_id, "recurring"))) return c.json({ created: [], errors: [] });
  await requireFeature(c, c.get("company").org_id, "recurring");
  await next();
});
company.use("/payroll/*", async (c, next) => { if (c.req.method !== "GET") await requireFeature(c, c.get("company").org_id, "payroll"); await next(); });
company.use("/reports/:gst{gstr1|gstr3b}", async (c, next) => { await requireFeature(c, c.get("company").org_id, "gst_returns"); await next(); });

company.route("/settings", settings);
company.route("/accounts", accounts);
company.route("/journals", journals);
company.route("/contacts", contacts);
company.route("/items", items);
company.route("/documents", documents);
company.route("/payments", payments);
company.route("/expenses", expenses);
company.route("/banking", banking);
company.route("/assets", assets);
company.route("/reports", reports);
company.route("/daybook", daybook);
company.route("/import", imports);
company.route("/recurring", recurring);
company.route("/pos", pos);
company.route("/price-lists", priceLists);
company.route("/production", production);
company.route("/assistant", assistant);
company.route("/attachments", files);
company.route("/export", exportdata);
company.route("/payroll", payroll);
company.route("/verify", verifyToken);
app.route("/api/c/:companyId", company);

app.all("/api/*", (c) => c.json({ error: { code: "NOT_FOUND", message: "Unknown API route" } }, 404));

// Non-API paths are served by static assets (SPA fallback is configured in wrangler.jsonc).
app.all("*", async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text("Not found", 404);
});

app.onError((err, c) => {
  const e = err instanceof AppError ? err : fromDbError(err);
  if (e) {
    if (e.status >= 500) console.error(JSON.stringify({ level: "error", requestId: c.get("requestId"), code: e.code, message: e.message }));
    return c.json({ error: { code: e.code, message: e.message, details: e.details } }, e.status as 400);
  }
  console.error(JSON.stringify({ level: "error", requestId: c.get("requestId"), path: new URL(c.req.url).pathname, message: (err as Error)?.message, stack: (err as Error)?.stack?.slice(0, 2000) }));
  return c.json({ error: { code: "INTERNAL", message: "Something went wrong. The error has been logged.", request_id: c.get("requestId") } }, 500);
});

export default app;
