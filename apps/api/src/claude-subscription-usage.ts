import { parseClaudeUsageResponse, type Settings } from "@opengeni/config";
import { emptyClaudeUsage } from "@opengeni/config";
import type { ClaudeSubscriptionUsage } from "@opengeni/contracts";
import {
  loadClaudeSubscriptionUsageCredential,
  recordClaudeSubscriptionUsage,
  type ClaudeUsageScope,
  type Database,
} from "@opengeni/db";
import { readResponseJsonBounded } from "@opengeni/network";
import { HTTPException } from "hono/http-exception";

/** No inference calls. Inference-only setup tokens retain their response-header cache. */
export async function refreshClaudeSubscriptionUsage(
  db: Database,
  settings: Settings,
  scope: ClaudeUsageScope,
  fetchImpl: typeof fetch = globalThis.fetch,
) {
  const credential = await loadClaudeSubscriptionUsageCredential(db, settings, scope);
  if (!credential) return emptyClaudeUsage(null);
  const current = credential.usage;
  if (
    current.refreshStatus === "scope_required" ||
    (current.refreshCheckedAt && Date.now() - Date.parse(current.refreshCheckedAt) < 30_000)
  )
    return current;
  const checkedAt = new Date().toISOString();
  let status: ClaudeSubscriptionUsage["refreshStatus"] = "unavailable";
  let observation: ReturnType<typeof parseClaudeUsageResponse> = null;
  try {
    const signal = AbortSignal.timeout(10_000);
    const response = await fetchImpl("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${credential.token}`,
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
  const result = await recordClaudeSubscriptionUsage(db, settings, scope, {
    token: credential.token,
    expectedConnectionId: credential.connectionId,
    expectedCredentialVersion: credential.credentialVersion,
    ...(observation ? { observation } : {}),
    refresh: { status, checkedAt },
  });
  if (!result)
    throw new HTTPException(409, { message: "Claude connection changed; reload usage." });
  return result;
}
