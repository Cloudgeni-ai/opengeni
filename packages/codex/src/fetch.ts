// codexSubscriptionFetch — the transport installed on the OpenAI client for the
// "codex-subscription" provider. Mirrors the runtime's computerCallNormalizingFetch
// pattern: wraps a base fetch and returns a (input, init) => Promise<Response>.
//
// It reads the per-request Codex context from AsyncLocalStorage at CALL time, so a
// single process-cached client serves every workspace with the correct token. It:
//   - rewrites /responses -> /codex/responses
//   - injects the subscription auth headers (omits OpenAI-Beta on SSE; spec §1.2)
//   - normalizes the request body (spec §0 verdict)
//   - retries once on 401 after a forced token refresh (spec §1.9)
// Stream parsing is delegated to the SDK (SSE passthrough; spec §0(d)).

import { CODEX_ORIGINATOR } from "./constants";
import { normalizeCodexRequestBody } from "./normalize";
import { codexRequestStorage, type CodexTokenSnapshot } from "./request-context";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function codexSubscriptionFetch(base: FetchLike = globalThis.fetch): FetchLike {
  return async (input, init) => {
    const ctx = codexRequestStorage.getStore();
    if (!ctx) {
      return base(input, init); // not a codex turn — passthrough, untouched
    }

    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    // /responses -> /codex/responses, idempotent: the negative lookbehind skips
    // URLs whose base already includes /codex (avoids /codex/codex/responses).
    const rewritten = rawUrl.replace(/(?<!\/codex)\/responses(\b|$)/, "/codex/responses$1");

    const attempt = async (auth: CodexTokenSnapshot): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${auth.accessToken}`);
      if (auth.chatgptAccountId) {
        headers.set("ChatGPT-Account-ID", auth.chatgptAccountId);
      }
      headers.set("originator", CODEX_ORIGINATOR);
      headers.set("User-Agent", `${CODEX_ORIGINATOR}/${ctx.clientVersion}`);
      headers.set("version", ctx.clientVersion);
      headers.set("accept", "text/event-stream");
      headers.set("content-type", "application/json");
      if (auth.isFedramp) {
        headers.set("X-OpenAI-Fedramp", "true");
      }
      headers.delete("OpenAI-Beta"); // omit on SSE (spec §1.2); fallback: "responses=experimental" if backend 400s
      headers.delete("x-api-key");

      const nextInit: RequestInit = { ...init, headers };
      if (typeof init?.body === "string") {
        try {
          nextInit.body = JSON.stringify(
            normalizeCodexRequestBody(JSON.parse(init.body) as Record<string, unknown>, ctx.resolveModel),
          );
        } catch {
          /* leave unparseable bodies untouched (already copied from init) */
        }
      }
      return base(rewritten, nextInit);
    };

    let res = await attempt(await ctx.getToken());
    if (res.status === 401) {
      res = await attempt(await ctx.refresh()); // single refresh-on-401 retry (spec §1.9)
    }
    return res;
  };
}
