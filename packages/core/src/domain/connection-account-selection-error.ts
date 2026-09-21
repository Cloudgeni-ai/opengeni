import { HTTPException } from "hono/http-exception";

/** An account choice needs attention; retrying the same work cannot fix it. */
export class ConnectionAccountSelectionError extends HTTPException {
  override name = "ConnectionAccountSelectionError";
  constructor(message: string) {
    super(422, { message });
  }
}
