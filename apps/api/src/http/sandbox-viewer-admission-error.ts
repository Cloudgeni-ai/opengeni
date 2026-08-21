import { SandboxViewerAdmissionBlockedError } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

/** Viewer and interaction holders share the workspace drain fence. Map it to
 *  the same 402/429 the `/viewers` attach path already returns so Browser and
 *  Desktop creates cannot become generic 500s with leftover `starting` rows. */
export function httpExceptionForSandboxViewerAdmission(
  error: unknown,
): HTTPException | null {
  if (!(error instanceof SandboxViewerAdmissionBlockedError)) return null;
  return new HTTPException(error.reason === "balance" ? 402 : 429, {
    message:
      error.reason === "balance"
        ? "insufficient OpenGeni credits for an idle sandbox viewer"
        : "workspace sandbox warm allowance exhausted",
    cause: error,
  });
}