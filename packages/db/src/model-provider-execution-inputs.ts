import { and, eq, inArray, isNull } from "drizzle-orm";
import { withRlsContext, type Database } from "./database";
import {
  listConnectionsMetadataInScope,
  type ConnectionMetadataWithVerification,
} from "./connection-metadata";
import {
  listWorkspaceProviderCustomModelsByKindInScope,
  type WorkspaceCustomModelProviderKind,
  type WorkspaceProviderCustomModel,
} from "./model-catalog";
import {
  mapOrganizationModelProviderCustomModel,
  type OrganizationModelProviderCustomModel,
  type OrganizationModelCatalogProviderKind,
} from "./organization-model-providers";
import * as schema from "./schema";

/** Attempt-local read results, never a cross-turn credential or authority cache. */
export type ModelProviderExecutionInputs = {
  claudeSubscriptionEnabled: boolean;
  loadOrganizationCredentials: boolean;
  workspaceModels: Record<WorkspaceCustomModelProviderKind, WorkspaceProviderCustomModel[]>;
  organizationModels: Record<
    OrganizationModelCatalogProviderKind,
    OrganizationModelProviderCustomModel[]
  >;
  workspaceConnections: ConnectionMetadataWithVerification[];
  encryptedCredentials: Partial<Record<OrganizationModelCatalogProviderKind, string>>;
};

/**
 * Read the full execution catalog in one scoped transaction. Selected workspace
 * credentials still use the normal live broker and model-access check afterwards.
 * Keep organization model queries unchanged: their row order feeds the catalog.
 */
export async function loadModelProviderExecutionInputs(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    claudeSubscriptionEnabled: boolean;
    loadOrganizationCredentials: boolean;
  },
): Promise<ModelProviderExecutionInputs> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const kinds: WorkspaceCustomModelProviderKind[] = [
      "vercel_gateway",
      "openrouter",
      "opper",
      "anthropic",
      ...(input.claudeSubscriptionEnabled ? ["claude_subscription" as const] : []),
    ];
    const workspaceModels = await listWorkspaceProviderCustomModelsByKindInScope(scopedDb, {
      ...input,
      providerKinds: kinds,
    });
    const workspaceConnections = await listConnectionsMetadataInScope(
      scopedDb,
      input.workspaceId,
      null,
    );
    const organizationModels: ModelProviderExecutionInputs["organizationModels"] = {
      vercel_gateway: [],
      openrouter: [],
      opper: [],
      anthropic: [],
      claude_subscription: [],
    };
    for (const providerKind of kinds) {
      const rows = await scopedDb
        .select()
        .from(schema.organizationModelProviderCustomModels)
        .where(
          and(
            eq(schema.organizationModelProviderCustomModels.accountId, input.accountId),
            eq(schema.organizationModelProviderCustomModels.providerKind, providerKind),
            isNull(schema.organizationModelProviderCustomModels.retiredAt),
          ),
        );
      organizationModels[providerKind] = rows.map(mapOrganizationModelProviderCustomModel);
    }
    const encryptedCredentials: ModelProviderExecutionInputs["encryptedCredentials"] = {};
    if (input.loadOrganizationCredentials) {
      const rows = await scopedDb
        .select({
          providerKind: schema.organizationModelProviderConnections.providerKind,
          credentialEncrypted: schema.organizationModelProviderConnections.credentialEncrypted,
        })
        .from(schema.organizationModelProviderConnections)
        .where(
          and(
            eq(schema.organizationModelProviderConnections.accountId, input.accountId),
            eq(schema.organizationModelProviderConnections.status, "active"),
            inArray(schema.organizationModelProviderConnections.providerKind, [
              "vercel_gateway",
              "openrouter",
              "opper",
              "anthropic",
            ]),
          ),
        );
      for (const row of rows) {
        if (row.providerKind !== "elevenlabs") {
          encryptedCredentials[row.providerKind] = row.credentialEncrypted;
        }
      }
    }
    return {
      claudeSubscriptionEnabled: input.claudeSubscriptionEnabled,
      loadOrganizationCredentials: input.loadOrganizationCredentials,
      workspaceModels,
      workspaceConnections,
      organizationModels,
      encryptedCredentials,
    };
  });
}
