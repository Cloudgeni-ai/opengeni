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

      // The backend is streaming-only; force stream=true on the wire but remember
      // the caller's intent so a non-streaming caller (e.g. the compaction
      // summarizer) still gets a single JSON Response back.
      let callerWantsStream = true;
      const nextInit: RequestInit = { ...init, headers };
      if (typeof init?.body === "string") {
        try {
          const parsed = JSON.parse(init.body) as Record<string, unknown>;
          callerWantsStream = parsed.stream === true;
          nextInit.body = JSON.stringify(normalizeCodexRequestBody(parsed, ctx.resolveModel));
        } catch {
          /* leave unparseable bodies untouched (already copied from init) */
        }
      }
      if (process.env.CODEX_DEBUG) {
        const keys = typeof nextInit.body === "string" ? Object.keys(JSON.parse(nextInit.body) as Record<string, unknown>) : [];
        console.error(`[codex-debug] POST ${rewritten} stream=${callerWantsStream} bodyKeys=[${keys.join(",")}]`);
      }
      const res = await base(rewritten, nextInit);
      if (process.env.CODEX_DEBUG && !res.ok) {
        console.error(`[codex-debug] <- ${res.status} ${await res.clone().text()}`);
      }
      // The codex backend leaves the terminal event's response.output empty and
      // delivers the assistant items via output_item.done events instead. The
      // @openai/agents parser (streaming AND non-streaming) reads response.output,
      // so we must reconstruct it: collapse to one JSON Response for a non-streaming
      // caller, or repair the live stream's terminal event for a streaming caller.
      if (!res.ok) {
        return res;
      }
      return callerWantsStream ? repairCodexStream(res) : await sseToJsonResponse(res);
    };

    let res = await attempt(await ctx.getToken());
    if (res.status === 401) {
      res = await attempt(await ctx.refresh()); // single refresh-on-401 retry (spec §1.9)
    }
    return res;
  };
}

/**
 * Collapse a Responses SSE stream into the single JSON Response object a
 * non-streaming `responses.create` caller expects: the terminal response.*
 * event carries the full `response` payload.
 */
async function sseToJsonResponse(res: Response): Promise<Response> {
  const text = await res.text();
  let final: Record<string, unknown> | null = null;
  const items: unknown[] = []; // assembled from output_item.done (the codex backend
  // leaves response.completed.response.output empty and emits the items separately).
  for (const block of text.split("\n\n")) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      const ev = JSON.parse(data) as { type?: string; response?: Record<string, unknown>; item?: unknown };
      if (ev.type === "response.output_item.done" && ev.item !== undefined) {
        items.push(ev.item);
      } else if (ev.type === "response.completed" || ev.type === "response.done" || ev.type === "response.incomplete") {
        final = ev.response ?? null;
      }
    } catch {
      /* ignore non-JSON keepalive lines */
    }
  }
  if (final && items.length > 0) {
    final = { ...final, output: items }; // prefer the assembled items over an empty output array
  }
  if (process.env.CODEX_DEBUG) {
    console.error(`[codex-debug] sse->json items=${items.length} outputLen=${Array.isArray(final?.output) ? (final.output as unknown[]).length : "?"}`);
  }
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(JSON.stringify(final ?? {}), { status: 200, headers });
}

/**
 * Repair a live Responses SSE stream for the @openai/agents streaming parser: pass
 * every event through unchanged, collect the output_item.done items, and inject
 * them into the terminal event's empty `output` so the parser sees the message.
 */
function repairCodexStream(res: Response): Response {
  if (!res.body) {
    return res;
  }
  const items: unknown[] = [];
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        controller.enqueue(encoder.encode(`${patchSseBlock(block, items)}\n\n`));
        idx = buffer.indexOf("\n\n");
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(patchSseBlock(buffer, items)));
      }
    },
  });
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(res.body.pipeThrough(transform), { status: res.status, headers });
}

/** Collect output_item.done items (mutating `items`); rewrite the terminal event's empty output. */
function patchSseBlock(block: string, items: unknown[]): string {
  const lines = block.split("\n");
  const dataStr = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
  if (!dataStr || dataStr === "[DONE]") {
    return block;
  }
  let ev: { type?: string; item?: unknown; response?: Record<string, unknown> };
  try {
    ev = JSON.parse(dataStr);
  } catch {
    return block;
  }
  if (ev.type === "response.output_item.done" && ev.item !== undefined) {
    items.push(ev.item);
    return block;
  }
  if (
    (ev.type === "response.completed" || ev.type === "response.done" || ev.type === "response.incomplete") &&
    ev.response
  ) {
    const out = ev.response.output;
    if ((!Array.isArray(out) || out.length === 0) && items.length > 0) {
      ev.response = { ...ev.response, output: items };
      const nonData = lines.filter((l) => !l.startsWith("data:"));
      return [...nonData, `data: ${JSON.stringify(ev)}`].join("\n");
    }
  }
  return block;
}
