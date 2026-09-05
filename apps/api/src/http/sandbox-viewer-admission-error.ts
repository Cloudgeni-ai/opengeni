import type { InteractionError } from "@opengeni/contracts";
import { SandboxViewerAdmissionBlockedError } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

function sandboxViewerAdmissionPublicMessage(
  reason: SandboxViewerAdmissionBlockedError["reason"],
): string {
  return reason === "balance"
    ? "insufficient OpenGeni credits for an idle sandbox viewer"
    : "workspace sandbox warm allowance exhausted";
}

/** Map a sandbox viewer/interaction admission block to HTTP 402 (credits) or 429 (warm cap). */
export function httpExceptionForSandboxViewerAdmission(error: unknown): HTTPException | null {
  if (!(error instanceof SandboxViewerAdmissionBlockedError)) return null;
  return new HTTPException(error.reason === "balance" ? 402 : 429, {
    message: sandboxViewerAdmissionPublicMessage(error.reason),
    cause: error,
  });
}

/** Persistable InteractionError for a prepared Browser/Computer session that never acquired a holder. */
export function sandboxViewerAdmissionInteractionError(
  error: SandboxViewerAdmissionBlockedError,
): InteractionError {
  return {
    code: "resource_unavailable",
    message: sandboxViewerAdmissionPublicMessage(error.reason),
    retryable: false,
  };
}
