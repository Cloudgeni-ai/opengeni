import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { ZodError } from "zod";

import { ApiHttpError } from "./api-error";

/**
 * Validation failures produced by parsing a client-supplied request body.
 *
 * The same `ZodError` instance is rethrown so route-local handlers that
 * already map `instanceof ZodError` keep their exact behavior; only the
 * central `app.onError` consults this set to answer a client error instead of
 * a 500. A ZodError that is NOT registered here (for example, a server-side
 * response projection that no longer matches its contract) remains a genuine
 * server fault.
 */
const requestBodyValidationErrors = new WeakSet<ZodError>();

const MAX_REPORTED_ISSUES = 10;

/** Parse an already-read request body against its public request schema. */
export function parseRequestBody<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  requestBodyValidationErrors.add(parsed.error);
  throw parsed.error;
}

/**
 * Read the request body as JSON. Malformed JSON is a client error (400), never
 * an unhandled `SyntaxError` 500. Other failures (body limit, aborted stream)
 * keep their own mapping.
 */
export async function readRequestJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ApiHttpError(400, {
        code: "validation_failed",
        message: "Request body must be valid JSON.",
        retryable: false,
        details: { code: "invalid_json" },
      });
    }
    throw error;
  }
}

/** Read and validate a JSON request body in one step. */
export async function parseRequestJson<Schema extends z.ZodType>(
  c: Context,
  schema: Schema,
): Promise<z.output<Schema>> {
  return parseRequestBody(schema, await readRequestJson(c));
}

export function isRequestBodyValidationError(error: unknown): error is ZodError {
  return error instanceof ZodError && requestBodyValidationErrors.has(error);
}

/**
 * Public 400 for a registered request-body validation failure, naming every
 * offending field (bounded) so API callers can correct the request.
 */
export function requestBodyValidationHttpError(error: unknown): ApiHttpError | null {
  const zodError =
    error instanceof HTTPException && isRequestBodyValidationError(error.cause)
      ? error.cause
      : isRequestBodyValidationError(error)
        ? error
        : null;
  if (!zodError) return null;
  const issues = zodError.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
  const summary = issues.map((issue) => `${issue.path || "request"}: ${issue.message}`).join("; ");
  const omittedIssueCount = Math.max(0, zodError.issues.length - issues.length);
  return new ApiHttpError(400, {
    code: "validation_failed",
    message: `Invalid request body: ${summary}${
      omittedIssueCount > 0 ? `; and ${omittedIssueCount} more` : ""
    }`,
    retryable: false,
    details: { code: "invalid_request_body", issues, omittedIssueCount },
  });
}
