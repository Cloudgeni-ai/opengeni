import { HTTPException } from "hono/http-exception";
import { ConnectionAccountSelectionDiagnostic } from "@opengeni/contracts";

/** An account choice needs attention; retrying the same work cannot fix it. */
export class ConnectionAccountSelectionError extends HTTPException {
  override name = "ConnectionAccountSelectionError";
  readonly diagnostic: ConnectionAccountSelectionDiagnostic;
  constructor(
    message: string,
    diagnostic: ConnectionAccountSelectionDiagnostic = {
      version: 1,
      reason: "selection_unavailable",
      accounts: [],
    },
  ) {
    super(422, { message });
    this.diagnostic = ConnectionAccountSelectionDiagnostic.parse(diagnostic);
  }
}
