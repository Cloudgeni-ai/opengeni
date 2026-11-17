import { SandboxOrganizationBoxLimitError } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

/**
 * The HTTP answer to a sandbox refused under the plan's compute bounds
 * (docs/deployment.md, "Free compute bounds"): 403 when the plan allows no
 * sandbox at all, 429 when a running-box or daily box-time limit is reached.
 * The message is the person-facing reason. Null for any other error.
 */
export function sandboxComputeRefusal(error: unknown): HTTPException | null {
  if (!(error instanceof SandboxOrganizationBoxLimitError)) return null;
  return new HTTPException(error.reason === "closed" ? 403 : 429, {
    message: error.message,
    cause: error,
  });
}

/** The acting person of a grant, when it is a person (`user:<id>`). */
export function sandboxActingPerson(subjectId: string | null | undefined): string | null {
  return typeof subjectId === "string" && subjectId.startsWith("user:") ? subjectId : null;
}
