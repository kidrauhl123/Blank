import { timingSafeEqual } from "node:crypto";
import { AuthError } from "./auth";

export function assertSchedulerRequest(request: Request) {
  const token = process.env.SCHEDULER_TOKEN;
  if (!token || token.length < 32) throw new AuthError("SCHEDULER_NOT_CONFIGURED", 503);
  const provided = request.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(provided);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AuthError("INVALID_SCHEDULER_TOKEN", 401);
}
