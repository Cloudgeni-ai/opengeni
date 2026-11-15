import type { ConnectedModelListPrice } from "@opengeni/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  connectionMetadataColumns,
  mapConnectionMetadata,
  type ConnectionMetadataWithVerification,
} from "./connection-metadata";
import { withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";

/**
 * Set or clear (null) what a workspace's own OpenAI, Azure OpenAI or
 * OpenAI-compatible model key's model costs: the catalogue model whose list
 * rate it shares, or an explicit rate. Only the price changes: the key's
 * version, and so its model's id and every accepted turn on it, stay as they
 * are. Repeating the same price is a no-op write. Null when the connection is
 * not an active workspace model key in this workspace.
 */
export async function setWorkspaceModelKeyListPriceInScope(
  scopedDb: Database,
  input: {
    accountId: string;
    workspaceId: string;
    connectionId: string;
    actorSubjectId: string;
    price: ConnectedModelListPrice | null;
  },
): Promise<ConnectionMetadataWithVerification | null> {
  const [row] = await scopedDb
    .update(schema.connections)
    .set({
      priceBasisModelId: input.price?.basis === "model" ? input.price.modelId : null,
      listPricing: input.price?.basis === "custom" ? input.price.pricing : null,
      updatedBySubjectId: input.actorSubjectId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.connections.accountId, input.accountId),
        eq(schema.connections.workspaceId, input.workspaceId),
        eq(schema.connections.id, input.connectionId),
        isNull(schema.connections.subjectId),
        eq(schema.connections.kind, "api_key"),
        eq(schema.connections.status, "active"),
        sql`${schema.connections.metadata} ? 'directModelProvider'`,
      ),
    )
    .returning(connectionMetadataColumns);
  return row ? mapConnectionMetadata(row) : null;
}

/** `setWorkspaceModelKeyListPriceInScope` in its own workspace scope. */
export async function setWorkspaceModelKeyListPrice(
  db: Database,
  input: Parameters<typeof setWorkspaceModelKeyListPriceInScope>[1],
): Promise<ConnectionMetadataWithVerification | null> {
  return await withWorkspaceRls(
    db,
    input.workspaceId,
    async (scopedDb) => await setWorkspaceModelKeyListPriceInScope(scopedDb, input),
  );
}
