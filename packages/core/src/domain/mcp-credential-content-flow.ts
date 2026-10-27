import {
  assertOrganizationContentFlowAllowed,
  findActiveApiKeyByHash,
  type Database,
  type WorkspaceContentFlowEnd,
} from "@opengeni/db";

/**
 * EU-only content stays in EU-only workspaces (docs/organization-tenancy.md).
 * An MCP server a workspace stores with an Opengeni organization (`ogk_`) or
 * personal (`ogp_`) API key reads that organization's workspaces. Saving one
 * in `target` is refused unless every workspace that key's organization has
 * may send content there. The endpoint checks every call again.
 */
const OPENGENI_KEY = /\bog[kp]_[A-Za-z0-9_-]{8,}/g;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Throws when a stored Opengeni key would bring EU-only content into `target`. */
export async function assertMcpCredentialContentFlowAllowed(
  db: Database,
  input: {
    target: WorkspaceContentFlowEnd;
    url?: string | null | undefined;
    headers?: Record<string, string> | null | undefined;
  },
): Promise<void> {
  const keys = new Set<string>();
  for (const value of [input.url ?? "", ...Object.values(input.headers ?? {})]) {
    for (const match of value.matchAll(OPENGENI_KEY)) keys.add(match[0]);
  }
  for (const key of keys) {
    const apiKey = await findActiveApiKeyByHash(db, await sha256Hex(key));
    // Not a live key: it reaches nothing.
    if (!apiKey) continue;
    await assertOrganizationContentFlowAllowed(db, {
      sourceAccountId: apiKey.accountId,
      target: input.target,
    });
  }
}
