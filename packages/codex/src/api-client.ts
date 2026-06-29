// Thin ChatGPT/Codex API client used outside the streamed turn: the login-check
// (GET /codex/models) and the usage/limits readback (GET /wham/usage). spec §1.4, §1.8, §F.

import { CODEX_ORIGINATOR, CODEX_RESPONSES_BASE, CODEX_WHAM_BASE } from "./constants";
import type { CodexFetch } from "./device-code";

export type CodexAuthHeaders = {
  accessToken: string;
  chatgptAccountId: string | null;
  isFedramp: boolean;
  clientVersion: string;
};

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
): Promise<{ ok: boolean; status: number; slugs: string[] }> {
  const res = await fetchImpl(`${CODEX_RESPONSES_BASE}/models?client_version=${encodeURIComponent(a.clientVersion)}`, {
    method: "GET",
    headers: subscriptionHeaders(a),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, slugs: [] };
  }
  const body = (await res.json()) as { models?: Array<{ slug?: string }> };
  const slugs = (body.models ?? []).map((m) => m.slug).filter((s): s is string => typeof s === "string");
  return { ok: true, status: res.status, slugs };
}

/** GET /wham/usage — authoritative limits. NB the WHAM base is /backend-api, NOT /codex (spec §1.8a). */
export async function fetchCodexUsage(
  a: CodexAuthHeaders,
  fetchImpl: CodexFetch = fetch,
): Promise<{ status: number; payload: unknown }> {
  const res = await fetchImpl(`${CODEX_WHAM_BASE}/wham/usage`, {
    method: "GET",
    headers: subscriptionHeaders(a),
  });
  // A 404 may carry a usage-limit body; the route layer normalizes it to a limits state (spec §1.8c).
  const payload = res.ok || res.status === 404 ? await res.json().catch(() => null) : null;
  return { status: res.status, payload };
}
