// End-to-end browser smoke test against a running server (default: wrangler dev on :8787).
// Usage: BASE_URL=http://127.0.0.1:8787 node scripts/e2e.mjs
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";

const base = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const exe = process.env.CHROMIUM_PATH ?? ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium"].find(existsSync);
const browser = await chromium.launch({ executablePath: exe });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
let offline = false; // failed requests while deliberately offline are expected, not errors
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error" && !offline) errors.push(`console: ${m.text()}`); });
const step = (s) => console.log(`✓ ${s}`);
const shot = async (n) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${n}.png`, fullPage: true }); };

try {
  await page.goto(`${base}/`);
  await page.locator("h1").first().waitFor();
  await page.waitForTimeout(500);
  if (new URL(page.url()).pathname === "/login") {
    // Desktop edition: first sign-in with the random one-time password shown on this computer, then a new password is required.
    await page.getByText("First time?").waitFor();
    const oneTime = (await page.locator("b.font-mono").first().textContent()).trim();
    if (!/^[A-Za-z2-9]{5}-[A-Za-z2-9]{5}-[A-Za-z2-9]{5}$/.test(oneTime)) throw new Error(`unexpected one-time password "${oneTime}"`);
    await page.getByLabel("Username or email").fill("admin");
    await page.getByLabel("Password", { exact: true }).fill(oneTime);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByText("Choose your own password").waitFor();
    await page.getByLabel("Username", { exact: true }).fill("asha");
    await page.getByLabel(/Current/).fill(oneTime);
    await page.getByLabel(/^New password/).fill("correct horse battery");
    await page.getByLabel(/Confirm new/).fill("correct horse battery");
    await page.getByRole("button", { name: "Save and continue" }).click();
    step("desktop edition: one-time password sign-in, forced password change");
  } else {
    await shot("01-landing");
    step("landing page");
    await page.getByRole("link", { name: "Create account" }).first().click();
    const email = `e2e${Date.now()}@example.com`;
    await page.getByLabel("Your name").fill("Asha Rao");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
    await page.getByLabel("Confirm password").fill("correct horse battery");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByText("Save your recovery codes").waitFor();
    step(`registered, ${await page.locator(".font-mono span").count()} recovery codes shown`);
    await page.getByLabel("I have stored these codes somewhere safe").check();
    await page.getByRole("button", { name: "Continue" }).click();
  }
  await page.getByText("Set up your first company").waitFor();
  await page.getByLabel("Organisation name").fill("Rao Group");
  await page.getByLabel(/^Company name/).fill("Rao Traders");
  await page.getByLabel(/State \(place of business\)/).selectOption("29");
  await shot("02-onboarding");
  await page.getByRole("button", { name: "Create company" }).click();
  await page.getByRole("heading", { name: "Dashboard" }).waitFor({ timeout: 20000 });
  const cid = page.url().split("/app/")[1].split("/")[0];
  step("company created → dashboard");

  await page.goto(`${base}/app/${cid}/customers`);
  await page.getByRole("button", { name: /New customer/ }).click();
  await page.getByLabel(/^Name/).fill("Bengaluru Retail Pvt Ltd");
  await page.getByLabel("State / place of supply").selectOption("29");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("link", { name: "Bengaluru Retail Pvt Ltd" }).waitFor();
  step("customer created");

  await page.goto(`${base}/app/${cid}/sales/invoice/new`);
  await page.getByLabel(/^Customer/).selectOption({ label: "Bengaluru Retail Pvt Ltd" });
  await page.getByLabel("Description").fill("Consulting services");
  await page.getByLabel("Quantity").fill("2");
  await page.getByLabel("Rate").fill("500.00");
  await page.getByLabel("Tax code").selectOption({ label: "GST 18%" });
  await page.getByText("1180.00").first().waitFor();
  step("live preview shows 1180.00 (2 × 500 + 9% CGST + 9% SGST)");
  await shot("03-invoice-form");
  await page.getByRole("button", { name: "Save & post" }).click();
  await page.getByRole("heading", { name: /Invoice INV-00001/ }).waitFor({ timeout: 20000 });
  const art = await page.locator("article").innerText();
  if (!/tax invoice/i.test(art) || !art.includes("CGST") || !art.includes("₹1,180.00")) throw new Error(`invoice body unexpected:\n${art}`);
  await shot("04-invoice");
  step("invoice INV-00001 posted; printable Tax Invoice shows CGST/SGST and ₹1,180.00");

  await page.getByRole("link", { name: "Record receipt" }).click();
  await page.getByRole("heading", { name: "Record receipt" }).waitFor();
  await page.getByLabel(/Apply to INV-00001/).waitFor();
  await page.getByLabel(/Amount \(INR\)/).fill("600");
  await page.getByLabel(/Apply to INV-00001/).fill("600");
  await page.getByRole("button", { name: "Save & post" }).click();
  await page.getByRole("heading", { name: /Receipt RCPT-00001/ }).waitFor({ timeout: 20000 });
  step("partial receipt RCPT-00001 of ₹600 applied");

  await page.goto(`${base}/app/${cid}/reports/trial-balance`);
  await page.getByText("Debits equal credits.").waitFor({ timeout: 20000 });
  step("trial balance balanced");
  await page.goto(`${base}/app/${cid}/reports/balance-sheet`);
  await page.getByText("Assets = Liabilities + Equity.").waitFor({ timeout: 20000 });
  await shot("05-balance-sheet");
  step("balance sheet balanced");
  await page.goto(`${base}/app/${cid}/reports/aging-receivable`);
  await page.getByText(/Matches the Accounts Receivable/).waitFor({ timeout: 20000 });
  const aging = await page.locator("tfoot").first().innerText();
  if (!aging.includes("580.00")) throw new Error(`aging total unexpected: ${aging}`);
  step("aged receivables = ₹580.00 and reconciles to AR");
  await page.goto(`${base}/app/${cid}/reports/profit-loss`);
  await page.getByText(/Net profit/).first().waitFor({ timeout: 20000 });
  step("profit & loss renders with explanation");
  await page.goto(`${base}/app/${cid}/dashboard`);
  await page.getByText("Receivables").waitFor();
  await shot("06-dashboard");

  // Offline: the app opens from this device, shows data viewed earlier, and queues new records until reconnect.
  await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller), null, { timeout: 20000 });
  await page.goto(`${base}/app/${cid}/customers`);
  await page.getByRole("link", { name: "Bengaluru Retail Pvt Ltd" }).waitFor();
  offline = true;
  await context.setOffline(true);
  await page.reload();
  await page.getByRole("link", { name: "Bengaluru Retail Pvt Ltd" }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: /Offline/ }).waitFor();
  step("offline: app shell and saved customer list load from the device");
  await page.getByRole("button", { name: /New customer/ }).click();
  await page.getByLabel(/^Name/).fill("Offline Kirana Store");
  await page.getByLabel("State / place of supply").selectOption("29");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: /1 on device/ }).waitFor();
  await shot("06b-offline-queued");
  step("offline: new customer saved on the device (1 waiting)");
  await context.setOffline(false);
  offline = false;
  await page.getByRole("button", { name: /on device/ }).waitFor({ state: "detached", timeout: 20000 });
  await page.reload();
  await page.getByRole("link", { name: "Offline Kirana Store" }).waitFor();
  const dupes = await page.getByRole("link", { name: "Offline Kirana Store" }).count();
  if (dupes !== 1) throw new Error(`expected exactly one synced customer, found ${dupes}`);
  step("back online: queued customer synced exactly once");
  await page.goto(`${base}/app/${cid}/dashboard`);
  await page.getByText("Receivables").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "Open menu" }).waitFor();
  await shot("07-mobile-dashboard");
  step("mobile layout renders with menu button");
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await shot("08-mobile-dark");
  if (errors.length) throw new Error(`browser errors:\n${errors.join("\n")}`);
  console.log("\nE2E PASSED");
} catch (e) {
  await page.screenshot({ path: "/tmp/e2e-failure.png", fullPage: true }).catch(() => {});
  console.error("E2E FAILED:", e.message, errors.length ? `\nbrowser errors:\n${errors.join("\n")}` : "");
  process.exitCode = 1;
} finally {
  await browser.close();
}
