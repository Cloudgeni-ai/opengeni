import type { MiddlewareHandler } from "hono";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "@opengeni/contracts";

const BEARER_AUTHORIZATION = /^bearer\s+\S/i;

/**
 * Keep published SDKs working across additive contract-revision bumps.
 *
 * Every `@opengeni/sdk` release up to 7.x throws `OpenGeniApiContractMismatchError`
 * on ANY response whose `x-opengeni-api-contract` header differs from the
 * revision it was built with, reads included. The header exists to make a
 * stale first-party browser tab reload (docs/design/api-compatibility-policy.md
 * (e)); a backend integration pinned to an SDK version cannot reload, so the
 * next additive revision bump would break every call it makes.
 *
 * For a bearer-authenticated caller (API key, delegated token) that announced a
 * different revision, the response therefore omits the header instead of
 * advertising one the caller is known to reject. Cookie/unauthenticated
 * callers (the stock web app) keep it, and so does an explicit
 * `API_CONTRACT_CHANGED` refusal, so a refused client can still explain the
 * mismatch. This is not an authorization boundary: routes authorize as usual.
 */
export function bearerApiContractHeaderCompatibility(): MiddlewareHandler {
  return async (context, next) => {
    await next();
    const claimed = context.req.header(OPENGENI_API_CONTRACT_HEADER);
    if (claimed === undefined || claimed === OPENGENI_API_CONTRACT_REVISION) return;
    if (!BEARER_AUTHORIZATION.test(context.req.header("authorization") ?? "")) return;
    if (!context.res.headers.has(OPENGENI_API_CONTRACT_HEADER)) return;
    if (context.res.status === 409 && (await isContractRefusal(context.res))) return;
    try {
      context.res.headers.delete(OPENGENI_API_CONTRACT_HEADER);
    } catch {
      // Immutable headers (a proxied or redirect response): copy once.
      context.res = new Response(context.res.body, context.res);
      context.res.headers.delete(OPENGENI_API_CONTRACT_HEADER);
    }
  };
}

async function isContractRefusal(response: Response): Promise<boolean> {
  if (!/^application\/json/i.test(response.headers.get("content-type") ?? "")) return false;
  try {
    const body = (await response.clone().json()) as { code?: unknown };
    return body?.code === "API_CONTRACT_CHANGED";
  } catch {
    return false;
  }
}
