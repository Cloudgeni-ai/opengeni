/**
 * Report catalog OAuth connectors whose authorization server advertises no
 * self-registration (neither dynamic client registration nor Client ID
 * Metadata Documents), compared with data/catalog/oauth-client-requirements.json.
 *
 * Read-only: fetches public MCP and OAuth metadata only and never registers a
 * client. Registration refusals and redirect allowlists are not visible in
 * metadata; record those from a reviewed registration attempt instead.
 *
 *   bun scripts/catalog-oauth-client-requirements-probe.ts
 */
import { readFile } from "node:fs/promises";
import {
  parseMcpOAuthChallenge,
  resolveMcpOAuthDiscovery,
} from "../packages/network/src/mcp-oauth-discovery";
import { normalizeCatalogSnapshot } from "./import-integrations-catalog";
import { oauthClientRequirementsEntriesByMcpUrl } from "./catalog-oauth-client-requirements";

const TIMEOUT_MS = 15_000;
const CONCURRENCY = 16;

async function probe(mcpUrl: string): Promise<{ issuer: string; selfRegistration: boolean }> {
  const response = await fetch(mcpUrl, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "OpenGeni", version: "1.0" },
      },
    }),
  });
  const challenge = parseMcpOAuthChallenge(response.headers.get("www-authenticate"));
  await response.body?.cancel().catch(() => undefined);
  const discovery = await resolveMcpOAuthDiscovery({
    resourceUrl: mcpUrl,
    challenge,
    fetchMetadata: async ({ url }) => {
      const metadata = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (metadata.status === 404 || metadata.status === 410) {
        await metadata.body?.cancel().catch(() => undefined);
        return { status: "absent", url, httpStatus: metadata.status };
      }
      if (!metadata.ok) throw new Error(`metadata HTTP ${metadata.status} at ${url}`);
      return {
        status: "present",
        url,
        document: (await metadata.json()) as Record<string, unknown>,
      };
    },
    validateEndpoint: (url) => url,
    canonicalizeResource: (url) => url,
  });
  const as = discovery.authorizationServerMetadata;
  return {
    issuer: as.issuer,
    selfRegistration: Boolean(as.registrationEndpoint) || as.clientIdMetadataDocumentSupported,
  };
}

if (import.meta.main) {
  const snapshot = JSON.parse(await readFile("data/catalog/integrations-snapshot.json", "utf8"));
  const rows = normalizeCatalogSnapshot(snapshot).rows.filter((row) => row.authKind === "oauth2");
  const missing: Array<{ name: string; mcpUrl: string; issuer: string }> = [];
  const failed: Array<{ name: string; mcpUrl: string; error: string }> = [];
  const queue = [...rows];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        try {
          const result = await probe(row.mcpUrl);
          if (!result.selfRegistration && !oauthClientRequirementsEntriesByMcpUrl.has(row.mcpUrl))
            missing.push({ name: row.name, mcpUrl: row.mcpUrl, issuer: result.issuer });
        } catch (error) {
          failed.push({
            name: row.name,
            mcpUrl: row.mcpUrl,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }),
  );
  console.log(
    JSON.stringify(
      {
        probed: rows.length,
        unlistedWithoutSelfRegistration: missing,
        discoveryFailures: failed,
      },
      null,
      2,
    ),
  );
}
