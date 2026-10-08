/** Raised when a write would execute or extend an archived (read-only) session. */
export class SessionArchivedError extends Error {
  readonly code = "SESSION_ARCHIVED_READ_ONLY";

  constructor() {
    super("This session is archived and read-only");
    this.name = "SessionArchivedError";
  }
}
