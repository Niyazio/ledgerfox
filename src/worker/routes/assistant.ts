import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { body } from "../lib/validate";
import { rateLimit } from "../lib/auth";
import { AppError } from "../lib/errors";
import { answer } from "../services/assistant";

/** The in-app assistant (questions about this company's books; no AI service involved). */
const assistant = new Hono<AppEnv>();

assistant.post("/", async (c) => {
  const { message } = await body(c, z.object({ message: z.string().trim().min(1).max(500) }));
  if (!(await rateLimit(c.env.DB, `assistant:${c.get("user").id}`, 60, 60))) throw new AppError(429, "RATE_LIMITED", "Too many questions in a minute; wait a moment");
  return c.json(await answer(c, message));
});

export default assistant;
