import { parseClaudeUsageResponse } from "@opengeni/config";
import type { ClaudeSubscriptionUsage } from "@opengeni/contracts";
import { readResponseJsonBounded } from "@opengeni/network";

/** The Claude profile usage request (no inference); the caller records its reading. */

export async function requestClaudeUsage(
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  const checkedAt = new Date().toISOString();
  let status: ClaudeSubscriptionUsage["refreshStatus"] = "unavailable";
  let observation: ReturnType<typeof parseClaudeUsageResponse> = null;
  try {
    const signal = AbortSignal.timeout(10_000);
    const response = await fetchImpl("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "cache-control": "no-cache",
      },
      redirect: "error",
      signal,
    });
    if (response.ok || response.status === 403) {
      const body = await readResponseJsonBounded<unknown>(response, 64 * 1024, "Claude usage", {
        signal,
      });
      if (response.ok) {
        observation = parseClaudeUsageResponse(body, new Date(checkedAt));
        status = observation ? "available" : "unavailable";
      } else {
        const error = body && typeof body === "object" && "error" in body ? body.error : null;
        const message =
          error && typeof error === "object" && "message" in error ? error.message : null;
        status =
          typeof message === "string" &&
          message.includes("scope requirement") &&
          message.includes("user:profile")
            ? "scope_required"
            : "unavailable";
      }
    } else {
      status = response.status === 401 ? "reconnect" : "unavailable";
      await response.body?.cancel().catch(() => undefined);
    }
  } catch {
    // Retain the last provider observation; never imply an unavailable quota is zero.
  }

  return { status, observation, checkedAt };
}
