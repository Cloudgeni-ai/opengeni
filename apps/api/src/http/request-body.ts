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
/** Malformed-JSON failures raised by reading a client request body. */
const requestBodyJsonErrors = new WeakSet<SyntaxError>();

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

/**
 * Read a raw request body, refusing (413) one larger than `maxBytes` before
 * buffering it. Webhook intakes verify signatures over these exact bytes.
 */
export async function readBoundedRawBody(
  request: Request,
  maxBytes: number,
  tooLargeMessage = "request body is too large",
): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HTTPException(413, { message: tooLargeMessage });
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new HTTPException(413, { message: tooLargeMessage });
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * Tag malformed-JSON failures of `c.req.json()` for this request. The same
 * `SyntaxError` instance is rethrown so routes that already catch it keep
 * their own mapping; an uncaught one becomes a 400 in `app.onError` instead of
 * a 500. A `SyntaxError` from parsing stored or upstream data is never tagged.
 */
export function tagRequestJsonParseErrors(c: Context): void {
  const original = c.req.json.bind(c.req);
  const tagged = async () => {
    try {
      return await original();
    } catch (error) {
      if (error instanceof SyntaxError) requestBodyJsonErrors.add(error);
      throw error;
    }
  };
  (c.req as { json: typeof tagged }).json = tagged;
}

export function isRequestBodyValidationError(error: unknown): error is ZodError | SyntaxError {
  return requestBodyInputError(error) !== null;
}

/** Walk a bounded cause chain for a tagged client-input failure. */
function requestBodyInputError(error: unknown): ZodError | SyntaxError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof ZodError && requestBodyValidationErrors.has(current)) return current;
    if (current instanceof SyntaxError && requestBodyJsonErrors.has(current)) return current;
    current = current.cause;
  }
  return null;
}

/**
 * Public 400 for a registered request-body validation failure, naming every
 * offending field (bounded) so API callers can correct the request.
 */
export function requestBodyValidationHttpError(error: unknown): ApiHttpError | null {
  const inputError = requestBodyInputError(error);
  if (!inputError) return null;
  if (inputError instanceof SyntaxError) {
    return new ApiHttpError(400, {
      code: "validation_failed",
      message: "Request body must be valid JSON.",
      retryable: false,
      details: { code: "invalid_json" },
    });
  }
  const zodError = inputError;
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
