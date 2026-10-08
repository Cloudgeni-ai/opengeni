import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  CapabilityCatalogItem,
  McpServerConnectionRef,
  stableJson,
  type AccessGrant,
  type ConnectionMetadata,
} from "@opengeni/contracts";
import type { ConnectOwnership, PreparedMcpSetup } from "@opengeni/contracts/connect";
import type { Settings } from "@opengeni/config";
import { getCapabilityCatalogItem, type Database } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import {
  createCatalogItem,
  prepareCapabilityEnable,
  validateMcpCapabilityConnection,
  type McpCapabilityProbe,
} from "../domain/capabilities";

/** Initialize/list tools before committing anything. Secret headers stay in this
 * invocation; the installation contains only an ordinary native connection ref.
 * The caller commits the connection and this installation in one authorized
 * Connect operation, so retries cannot leave an orphan credential or catalog. */
export async function prepareMcpConnectionActivation(input: {
  grant: AccessGrant;
  settings: Settings;
  setup: PreparedMcpSetup;
  ownership: ConnectOwnership;
  headers: Record<string, string>;
  probe?: McpCapabilityProbe;
}) {
  const { grant, settings, ownership } = input;
  const setup = structuredClone(input.setup);
  const endpoint = new URL(setup.endpointUrl).toString();
  const key = createHash("sha256")
    .update(stableJson({ endpoint, ownership }))
    .digest("hex")
    .slice(0, 32);
  const capabilityId = `mcp:custom-${key}`;
  const item = CapabilityCatalogItem.parse({
    id: capabilityId,
    kind: "mcp",
    source: "manual",
    name: setup.name,
    endpointUrl: endpoint,
    authModel: "native_connection",
    runtime: { available: true, mcpServerId: `custom-${key}` },
    metadata: { mcpServerId: `custom-${key}` },
  });
  const connectivity = await validateMcpCapabilityConnection(
    item,
    input.probe,
    { ...input.headers },
    settings,
  );
  return {
    capabilityId,
    commit: async (db: Database, connection: ConnectionMetadata) => {
      const existing = await getCapabilityCatalogItem(db, grant.workspaceId, capabilityId);
      if (existing && (existing.kind !== "mcp" || existing.endpointUrl !== endpoint))
        throw new HTTPException(409, { message: "MCP catalog definition changed; reload setup" });
      if (!existing)
        await createCatalogItem({
          db,
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          payload: {
            id: capabilityId,
            kind: "mcp",
            source: "manual",
            name: setup.name,
            endpointUrl: endpoint,
            authModel: "native_connection",
            category: "custom",
            tags: [],
            metadata: item.metadata,
          },
        });
      const connectionRef: McpServerConnectionRef = {
        providerDomain: new URL(endpoint).hostname,
        subjectScope: ownership === "personal" ? "subject" : "workspace",
        accountSelection: "all_eligible",
        kind: "api_key",
        resource: endpoint,
      };
      const prepared = await prepareCapabilityEnable({
        db,
        grant,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        settings,
        capabilityId,
        payload: {
          onlyIfUninstalled: true,
          config: {},
          headers: {},
          metadata: {},
          connectionRef,
        },
        verifiedConnection: {
          id: connection.id,
          version: connection.version,
          endpointUrl: endpoint,
          connectivity,
        },
      });
      const installation = await prepared.commit(db);
      const savedRef = McpServerConnectionRef.safeParse(installation.config.connectionRef);
      const retainedExactPin =
        savedRef.success &&
        savedRef.data.authoritySource !== "host" &&
        savedRef.data.connectionId === connection.id &&
        savedRef.data.providerDomain === connectionRef.providerDomain &&
        (savedRef.data.subjectScope ?? "workspace") === connectionRef.subjectScope &&
        (savedRef.data.kind ?? connection.kind) === connection.kind &&
        (!savedRef.data.resource || savedRef.data.resource === endpoint);
      // onlyIfUninstalled preserves existing account choices. Do not report a
      // newly saved account as usable when a different binding was preserved;
      // throw inside Connect's transaction so its credential also rolls back.
      // Reconnecting the exact pinned account keeps the pin and its restrictions.
      if (
        installation.status !== "active" ||
        (!retainedExactPin && !isDeepStrictEqual(installation.config.connectionRef, connectionRef))
      ) {
        throw new HTTPException(409, {
          message: "MCP account selection changed; review the existing connection before setup",
        });
      }
      return installation;
    },
  };
}
