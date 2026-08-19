import { HTTPException } from "hono/http-exception";

export function allowedCorsOrigin(pattern: string, origin: string): boolean {
  return new RegExp(`^(?:${pattern})$`).test(origin);
}

export function validateInteractionRequestOrigin(
  value: string | undefined,
  input: {
    corsAllowOriginRegex: string;
    publicBaseUrl?: string | undefined;
    webBaseUrl?: string | undefined;
  },
): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HTTPException(400, { message: "invalid request origin" });
  }
  if (
    url.origin === "null" ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== value
  ) {
    throw new HTTPException(400, { message: "invalid request origin" });
  }
  if (
    allowedCorsOrigin(input.corsAllowOriginRegex, url.origin) ||
    [input.publicBaseUrl, input.webBaseUrl].some((baseUrl) =>
      baseUrl ? new URL(baseUrl).origin === url.origin : false,
    )
  ) {
    return url.origin;
  }
  throw new HTTPException(403, { message: "request origin is not allowed" });
}
