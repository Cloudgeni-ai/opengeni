import {
  SandboxOrganizationBoxLimitError,
  type SandboxOrganizationBoxLimitReason,
  type SandboxComputeStandingFallback,
} from "@opengeni/db";
import type { Observability } from "@opengeni/observability";
import { HTTPException } from "hono/http-exception";
import { ApiHttpError } from "../http/api-error";

/** Refusals that last until the daily allowance resets at midnight UTC. A
 * young organization's spent box time lifts when it is a day old instead
 * (from the refusal's `liftsAt`, midnight UTC only when that is unknown). */
const DAILY_REFUSAL_REASONS: ReadonlySet<SandboxOrganizationBoxLimitReason> = new Set([
  "daily_budget",
  "young_box_time",
  "fleet_daily_budget",
]);

/** Refusals no wait can lift: the person must start a chat or add credit. */
const NON_RETRYABLE_REFUSAL_REASONS: ReadonlySet<SandboxOrganizationBoxLimitReason> = new Set([
  "young_turnless",
]);

/** A box slot frees when a task finishes or an idle box drains. */
const RUNNING_LIMIT_RETRY_AFTER_SECONDS = 60;

/**
 * When a client may usefully retry a refused sandbox (sent as `Retry-After`),
 * so a caller that retries does not hammer a limit that cannot have changed.
 */
export function sandboxComputeRetryAfterSeconds(
  reason: SandboxOrganizationBoxLimitReason,
  now: Date = new Date(),
  liftsAt?: Date,
): number {
  if (!DAILY_REFUSAL_REASONS.has(reason)) return RUNNING_LIMIT_RETRY_AFTER_SECONDS;
  const liftsAtMs =
    reason === "young_box_time" && liftsAt && Number.isFinite(liftsAt.getTime())
      ? liftsAt.getTime()
      : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(RUNNING_LIMIT_RETRY_AFTER_SECONDS, Math.ceil((liftsAtMs - now.getTime()) / 1000));
}

/**
 * The HTTP answer to a sandbox refused under the plan's compute bounds
 * (docs/deployment.md, "Free compute bounds"): 403 when the plan allows no
 * sandbox at all, 429 when a running-box or daily box-time limit is reached.
 * The message is the person-facing reason. Null for any other error. A
 * missing verified card is 403 with `details.code` `sandbox_card_required`, so
 * a client can offer Add a card. A 429 carries `Retry-After` (and
 * `details.retryAfterSeconds`) so retrying clients back off.
 */
export function sandboxComputeRefusal(error: unknown): HTTPException | null {
  if (!(error instanceof SandboxOrganizationBoxLimitError)) return null;
  if (error.reason === "card_required") {
    return new ApiHttpError(403, {
      code: "forbidden",
      message: error.message,
      details: { code: error.code },
    });
  }
  if (error.reason === "closed") {
    return new HTTPException(403, { message: error.message, cause: error });
  }
  if (NON_RETRYABLE_REFUSAL_REASONS.has(error.reason)) {
    return new ApiHttpError(429, {
      code: "limit_exceeded",
      message: error.message,
      retryable: false,
      details: { code: error.code },
    });
  }
  return new ApiHttpError(429, {
    code: "limit_exceeded",
    message: error.message,
    retryable: true,
    details: {
      code: error.code,
      retryAfterSeconds: sandboxComputeRetryAfterSeconds(error.reason, new Date(), error.liftsAt),
    },
  });
}

/** The acting person of a grant, when it is a person (`user:<id>`). */
export function sandboxActingPerson(subjectId: string | null | undefined): string | null {
  return typeof subjectId === "string" && subjectId.startsWith("user:") ? subjectId : null;
}

/** Records a compute-standing read that failed open at admission (the
 * organization's own tier or bounds applied instead). Undefined without
 * observability, where the database layer logs it. */
export function sandboxComputeStandingFallbackObserver(
  observability: Observability | undefined,
): SandboxComputeStandingFallback | undefined {
  if (!observability) return undefined;
  return (error, part) => {
    observability.incrementCounter({
      name: "opengeni_sandbox_compute_standing_fallbacks_total",
      help: "Sandbox admissions whose compute-standing read failed and fell back to the organization's own bounds, by part.",
      labels: { part },
    });
    observability.warn("sandbox compute standing read failed; admission fell back", {
      part,
      error: error instanceof Error ? error.message : String(error),
    });
  };
}
