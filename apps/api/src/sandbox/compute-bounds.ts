import {
  SandboxOrganizationBoxLimitError,
  type SandboxComputeStandingFallback,
} from "@opengeni/db";
import type { Observability } from "@opengeni/observability";
import { HTTPException } from "hono/http-exception";
import { ApiHttpError } from "../http/api-error";

/**
 * The HTTP answer to a sandbox refused under the plan's compute bounds
 * (docs/deployment.md, "Free compute bounds"): 403 when the plan allows no
 * sandbox at all, 429 when a running-box or daily box-time limit is reached.
 * The message is the person-facing reason. Null for any other error. A
 * missing verified card is 403 with `details.code` `sandbox_card_required`, so
 * a client can offer Add a card.
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
  return new HTTPException(error.reason === "closed" ? 403 : 429, {
    message: error.message,
    cause: error,
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
