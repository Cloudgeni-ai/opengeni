import { HTTPException } from "hono/http-exception";

export function safeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new HTTPException(400, {
      message: "OAuth returnPath must be a relative path",
    });
  }
  const parsed = new URL(value, "https://opengeni.local");
  // `..` segments can normalize back into a `//host` prefix, which browsers
  // resolve as a protocol-relative absolute URL. Reject the NORMALIZED path.
  if (parsed.origin !== "https://opengeni.local" || parsed.pathname.startsWith("//")) {
    throw new HTTPException(400, {
      message: "OAuth returnPath must be a relative path",
    });
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
