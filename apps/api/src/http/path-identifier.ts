import { ApiHttpError } from "./api-error";

const UUID_SYNTAX_MESSAGE = /invalid input syntax for type uuid: "([^"]*)"/u;

/**
 * A resource id taken verbatim from the URL path that is not a UUID cannot
 * name any row. Routes pass such ids straight to PostgreSQL, which rejects the
 * cast (SQLSTATE 22P02); that is a client addressing error, so answer 404
 * instead of an unhandled 500.
 *
 * Deliberately narrow: only a uuid-syntax failure whose rejected text is
 * exactly one of this request's own path segments qualifies. A malformed UUID
 * produced by server code (a stored value, a derived subject, a body field)
 * does not appear as a path segment and stays a genuine 500.
 *
 * Typical cause: a client built against a newer API calls a literal route
 * (for example `.../scheduled-tasks/attention`) that an older server does not
 * have, so the literal falls through to `.../scheduled-tasks/:taskId`.
 */
export function invalidPathIdentifierHttpError(
  error: unknown,
  pathname: string,
): ApiHttpError | null {
  const rejected = rejectedUuidText(error);
  if (rejected === null || rejected.length === 0) return null;
  const segments = pathname.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  if (!segments.includes(rejected)) return null;
  return new ApiHttpError(404, {
    code: "not_found",
    message: `Not found: "${rejected.slice(0, 64)}" is not a valid resource id for this route.`,
    retryable: false,
    details: { code: "invalid_path_identifier" },
  });
}

/** The text PostgreSQL refused to cast to uuid, found through a bounded cause chain. */
function rejectedUuidText(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code === "22P02") {
      const match = UUID_SYNTAX_MESSAGE.exec(current.message);
      if (match) return match[1] ?? null;
    }
    current = current.cause;
  }
  return null;
}
