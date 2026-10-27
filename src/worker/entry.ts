import app from "./index";
import type { Env } from "./env";
import { dailyBillingReminders } from "./services/notices";

/** Cloudflare entry point: the HTTP app plus the daily job (cron in wrangler.jsonc) that sends billing reminders. */
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dailyBillingReminders(env).then((n) => console.log(JSON.stringify({ level: "info", job: "billing-reminders", sent: n }))));
  },
} satisfies ExportedHandler<Env>;
