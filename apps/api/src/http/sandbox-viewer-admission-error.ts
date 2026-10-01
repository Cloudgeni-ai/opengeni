import { SandboxViewerAdmissionBlockedError } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

/** Map the shared viewer/interaction drain fence to the public attach contract. */
export function httpExceptionForSandboxViewerAdmission(error: unknown): HTTPException | null {
  if (!(error instanceof SandboxViewerAdmissionBlockedError)) return null;
  return new HTTPException(error.reason === "balance" ? 402 : 429, {
    message:
      error.reason === "balance"
        ? "insufficient OpenGeni credits for an idle sandbox viewer"
        : "workspace sandbox warm allowance exhausted",
    cause: error,
  });
}
