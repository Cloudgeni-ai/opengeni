/** Production Opengeni API, used when neither `--base-url` nor `OPENGENI_BASE_URL` is set. */
export const DEFAULT_OPENGENI_BASE_URL = "https://app.opengeni.ai";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ApiClientOptions = {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
  userAgent: string;
};

/** A failed API request with the server's error code and message when it sent one. */
export class CliApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = "CliApiError";
    this.status = status;
    this.code = code;
  }
}

function decodeError(status: number, body: string): CliApiError {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const decoded = JSON.parse(body) as Record<string, unknown>;
    const nested =
      decoded.error && typeof decoded.error === "object"
        ? (decoded.error as Record<string, unknown>)
        : decoded;
    if (typeof nested.code === "string") code = nested.code;
    else if (typeof decoded.error === "string") code = decoded.error;
    if (typeof nested.message === "string") message = nested.message;
  } catch {
    // Not JSON; fall through to the status line.
  }
  return new CliApiError(
    status,
    code,
    message ?? (body.trim() ? body.trim().slice(0, 300) : `HTTP ${status}`),
  );
}

/** Sends one JSON request to the Opengeni API and returns the decoded body. */
export async function requestJson<T>(
  options: ApiClientOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await options.fetch(`${options.baseUrl.replace(/\/+$/u, "")}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: "application/json",
        "user-agent": options.userAgent,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new CliApiError(
      0,
      "network_error",
      `cannot reach ${options.baseUrl} (${(error as Error).message}).`,
    );
  }
  const text = await response.text();
  if (!response.ok) throw decodeError(response.status, text);
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new CliApiError(
      response.status,
      "invalid_response",
      "the API returned a response that is not JSON.",
    );
  }
}
