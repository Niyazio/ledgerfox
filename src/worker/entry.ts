import app from "./index";
import type { Env } from "./env";
import { dailyBillingReminders } from "./services/notices";
import { sendPaymentReminders } from "./services/collect";
import { sendScheduledReports } from "./services/customise";

/** Cloudflare entry point: the HTTP app plus the daily job (cron in wrangler.jsonc) that sends billing and payment reminders. */
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dailyBillingReminders(env).then((n) => console.log(JSON.stringify({ level: "info", job: "billing-reminders", sent: n }))));
    // Businesses' payment reminders to their customers (each company's own schedule).
    ctx.waitUntil(sendPaymentReminders(env).then((n) => console.log(JSON.stringify({ level: "info", job: "payment-reminders", sent: n })))
      .catch((e) => console.error(JSON.stringify({ level: "error", job: "payment-reminders", message: (e as Error).message }))));
    // Reports the businesses asked to receive by email.
    ctx.waitUntil(sendScheduledReports(env).then((n) => console.log(JSON.stringify({ level: "info", job: "scheduled-reports", sent: n })))
      .catch((e) => console.error(JSON.stringify({ level: "error", job: "scheduled-reports", message: (e as Error).message }))));
  },
} satisfies ExportedHandler<Env>;
