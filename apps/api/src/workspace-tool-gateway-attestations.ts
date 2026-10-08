import type { ToolGatewayCatalog, ToolGatewayIdentity } from "@opengeni/contracts";
import { digestCanonicalJson } from "@opengeni/tool-gateway";

/**
 * Content-free memory of complete workspace tool catalogs this API process
 * produced for one exact caller scope.
 *
 * A complete catalog digest covers every enabled connector, so verifying a
 * call's `catalogDigest` used to require connecting and listing every
 * connector again. The attestation remembers, per complete digest, only the
 * canonical digest of each entry. A later call can then prepare just its
 * target connector live and prove that the entry it is about to execute is
 * byte-for-byte the entry its caller saw in that complete catalog.
 *
 * It never stores credentials, prepared gateways, connections, schemas,
 * arguments, or results, and grants no authority: every call still resolves
 * live caller, account, connection, policy, and Site authority. A miss,
 * expiry, or entry mismatch falls back to complete preparation and the exact
 * historical stale-catalog contract.
 */
export type WorkspaceToolGatewayCatalogAttestations = {
  record(scope: string, catalog: Pick<ToolGatewayCatalog, "digest" | "entries">): void;
  /** The attested entry digest, or `undefined` when the catalog is unknown or expired. */
  entryDigest(
    scope: string,
    catalogDigest: string,
    identity: ToolGatewayIdentity,
  ): string | undefined;
};

export type WorkspaceToolGatewayCatalogAttestationOptions = {
  /** Fixed lifetime from complete preparation; use never extends it. */
  ttlMs?: number;
  maxScopes?: number;
  maxCatalogsPerScope?: number;
  now?: () => number;
};

export const WORKSPACE_TOOL_GATEWAY_ATTESTATION_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_SCOPES = 512;
const DEFAULT_MAX_CATALOGS_PER_SCOPE = 4;

type AttestedCatalog = { expiresAt: number; entries: ReadonlyMap<string, string> };

export function createWorkspaceToolGatewayCatalogAttestations(
  options: WorkspaceToolGatewayCatalogAttestationOptions = {},
): WorkspaceToolGatewayCatalogAttestations {
  const ttlMs = options.ttlMs ?? WORKSPACE_TOOL_GATEWAY_ATTESTATION_TTL_MS;
  const maxScopes = options.maxScopes ?? DEFAULT_MAX_SCOPES;
  const maxCatalogsPerScope = options.maxCatalogsPerScope ?? DEFAULT_MAX_CATALOGS_PER_SCOPE;
  const now = options.now ?? Date.now;
  // Map insertion order is the eviction order (least recently recorded first).
  const scopes = new Map<string, Map<string, AttestedCatalog>>();
  return {
    record(scope, catalog) {
      const entries = new Map<string, string>();
      for (const entry of catalog.entries) {
        entries.set(
          workspaceToolGatewayIdentityKey(entry.identity),
          digestWorkspaceToolGatewayCatalogEntry(entry),
        );
      }
      const catalogs = scopes.get(scope) ?? new Map<string, AttestedCatalog>();
      scopes.delete(scope);
      catalogs.delete(catalog.digest);
      catalogs.set(catalog.digest, { expiresAt: now() + ttlMs, entries });
      while (catalogs.size > maxCatalogsPerScope) {
        catalogs.delete(catalogs.keys().next().value!);
      }
      scopes.set(scope, catalogs);
      while (scopes.size > maxScopes) {
        scopes.delete(scopes.keys().next().value!);
      }
    },
    entryDigest(scope, catalogDigest, identity) {
      const catalogs = scopes.get(scope);
      const attested = catalogs?.get(catalogDigest);
      if (!catalogs || !attested) return undefined;
      if (attested.expiresAt <= now()) {
        catalogs.delete(catalogDigest);
        if (catalogs.size === 0) scopes.delete(scope);
        return undefined;
      }
      return attested.entries.get(workspaceToolGatewayIdentityKey(identity));
    },
  };
}

export function digestWorkspaceToolGatewayCatalogEntry(entry: unknown): string {
  return digestCanonicalJson(entry);
}

function workspaceToolGatewayIdentityKey(identity: ToolGatewayIdentity): string {
  return JSON.stringify([identity.serverId, identity.toolName]);
}
