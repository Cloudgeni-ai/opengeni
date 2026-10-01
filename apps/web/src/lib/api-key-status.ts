import type { ApiKey } from "@/types";

export type ApiKeyStatus = "active" | "expired" | "revoked";

/** Mirrors the server: a revoked or expired key no longer authenticates. */
export function apiKeyStatus(
  apiKey: Pick<ApiKey, "revokedAt" | "expiresAt">,
  now: number = Date.now(),
): ApiKeyStatus {
  if (apiKey.revokedAt) return "revoked";
  if (apiKey.expiresAt && Date.parse(apiKey.expiresAt) <= now) return "expired";
  return "active";
}
