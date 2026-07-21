// Thin ChatGPT/Codex API client used outside the streamed turn: the login-check
// (GET /codex/models) and the usage/limits readback (GET /wham/usage). spec §1.4, §1.8, §F.

import { CODEX_ORIGINATOR, CODEX_RESPONSES_BASE, CODEX_WHAM_BASE } from "./constants";
import type { CodexFetch } from "./device-code";
import {
  parseCodexRateLimitResetConsumeResponse,
  parseCodexRateLimitResetCreditsDetails,
  type CodexRateLimitResetConsumeResponse,
  type CodexRateLimitResetCreditsDetails,
} from "./reset-credits";
import { runBoundedCodexOperation } from "./bounded-operation";

export type CodexAuthHeaders = {
  accessToken: string;
  chatgptAccountId: string | null;
  isFedramp: boolean;
  clientVersion: string;
};

const CODEX_READ_TIMEOUT_MS = 5_000;
const RESET_CREDIT_DETAILS_TIMEOUT_MS = 5_000;
const RESET_CREDIT_CONSUME_TIMEOUT_MS = 10_000;

export type ResetCreditFetchFailureReason =
  | "http_error"
  | "invalid_response"
  | "network_error"
  | "timeout";

function subscriptionHeaders(a: CodexAuthHeaders): Record<string, string> {
  return {
    Authorization: `Bearer ${a.accessToken}`,
    ...(a.chatgptAccountId ? { "ChatGPT-Account-ID": a.chatgptAccountId } : {}),
    originator: CODEX_ORIGINATOR,
    "User-Agent": `${CODEX_ORIGINATOR}/${a.clientVersion}`,
    version: a.clientVersion,
    ...(a.isFedramp ? { "X-OpenAI-Fedramp": "true" } : {}),
  };
}

/** GET /codex/models — login-check + live catalog. A 200 means the token is accepted. spec §1.4/§F */
export async function fetchCodexModels(
  a: CodexAuthHeaders,
  fetchImpl: CodexFetch = fetch,
  timeoutMs = CODEX_READ_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; slugs: string[] }> {
  const fetched = await runBoundedCodexOperation(async (signal) => {
    const res = await fetchImpl(
      `${CODEX_RESPONSES_BASE}/models?client_version=${encodeURIComponent(a.clientVersion)}`,
      { method: "GET", headers: subscriptionHeaders(a), signal },
    );
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      return { ok: false, status: res.status, slugs: [] as string[] };
    }
    const body = (await res.json()) as { models?: Array<{ slug?: string }> };
    const slugs = (body.models ?? [])
      .map((model) => model.slug)
      .filter((slug): slug is string => typeof slug === "string");
    return { ok: true, status: res.status, slugs };
  }, timeoutMs);
  return fetched.ok ? fetched.value : { ok: false, status: 0, slugs: [] };
}

/** GET /wham/usage — authoritative limits. NB the WHAM base is /backend-api, NOT /codex (spec §1.8a). */
export async function fetchCodexUsage(
  a: CodexAuthHeaders,
  fetchImpl: CodexFetch = fetch,
  timeoutMs = CODEX_READ_TIMEOUT_MS,
): Promise<{ status: number; payload: unknown }> {
  const fetched = await runBoundedCodexOperation(async (signal) => {
    const res = await fetchImpl(`${CODEX_WHAM_BASE}/wham/usage`, {
      method: "GET",
      headers: subscriptionHeaders(a),
      signal,
    });
    // A 404 may carry a usage-limit body; the route layer normalizes it to a limits state (spec §1.8c).
    const payload = res.ok || res.status === 404 ? await res.json().catch(() => null) : null;
    if (!res.ok && res.status !== 404) await res.arrayBuffer().catch(() => undefined);
    return { status: res.status, payload };
  }, timeoutMs);
  if (!fetched.ok) throw new Error(`Codex usage request ${fetched.reason}`);
  return fetched.value;
}

/**
 * GET /wham/rate-limit-reset-credits — detailed earned reset credits.
 *
 * A non-2xx or malformed body returns an explicit non-ok result. The caller may
 * fall back to the count-only summary embedded in /wham/usage, but must never
 * invent actionable rows from that count.
 */
export async function fetchCodexRateLimitResetCredits(
  a: CodexAuthHeaders,
  fetchImpl: CodexFetch = fetch,
  timeoutMs = RESET_CREDIT_DETAILS_TIMEOUT_MS,
): Promise<
  | { ok: true; status: number; details: CodexRateLimitResetCreditsDetails }
  | { ok: false; status: number; reason: ResetCreditFetchFailureReason }
> {
  const fetched = await runBoundedCodexOperation(async (signal) => {
    const res = await fetchImpl(`${CODEX_WHAM_BASE}/wham/rate-limit-reset-credits`, {
      method: "GET",
      headers: subscriptionHeaders(a),
      signal,
    });
    if (!res.ok) {
      // Drain the body without retaining/logging it. Provider error bodies may
      // contain account-specific details and are not part of this contract.
      await res.arrayBuffer().catch(() => undefined);
      return { ok: false as const, status: res.status, reason: "http_error" as const };
    }
    const details = parseCodexRateLimitResetCreditsDetails(await res.json().catch(() => null));
    return details
      ? { ok: true as const, status: res.status, details }
      : { ok: false as const, status: res.status, reason: "invalid_response" as const };
  }, timeoutMs);
  return fetched.ok ? fetched.value : { ok: false, status: 0, reason: fetched.reason };
}

/**
 * POST /wham/rate-limit-reset-credits/consume with the exact v0.144.6 body.
 * `idempotencyKey` identifies one logical human redemption and MUST be reused
 * by the server on retries. Supplying `creditId` is preferred; omission leaves
 * provider selection in control and is therefore not used by OpenGeni's
 * human-only flow.
 */
export async function consumeCodexRateLimitResetCredit(
  a: CodexAuthHeaders,
  input: { idempotencyKey: string; creditId?: string | undefined },
  fetchImpl: CodexFetch = fetch,
  timeoutMs = RESET_CREDIT_CONSUME_TIMEOUT_MS,
): Promise<
  | { ok: true; status: number; result: CodexRateLimitResetConsumeResponse }
  | {
      ok: false;
      status: number;
      reason: ResetCreditFetchFailureReason | "invalid_request";
    }
> {
  if (input.idempotencyKey.length === 0 || input.creditId === "") {
    return { ok: false, status: 0, reason: "invalid_request" };
  }
  const fetched = await runBoundedCodexOperation(async (signal) => {
    const res = await fetchImpl(`${CODEX_WHAM_BASE}/wham/rate-limit-reset-credits/consume`, {
      method: "POST",
      headers: {
        ...subscriptionHeaders(a),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        redeem_request_id: input.idempotencyKey,
        ...(input.creditId ? { credit_id: input.creditId } : {}),
      }),
      signal,
    });
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      return { ok: false as const, status: res.status, reason: "http_error" as const };
    }
    const result = parseCodexRateLimitResetConsumeResponse(await res.json().catch(() => null));
    return result
      ? { ok: true as const, status: res.status, result }
      : { ok: false as const, status: res.status, reason: "invalid_response" as const };
  }, timeoutMs);
  return fetched.ok ? fetched.value : { ok: false, status: 0, reason: fetched.reason };
}
