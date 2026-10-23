import {
  rlsContextForWorkspace,
  withRlsContext,
  WorkspaceNotFoundError,
  type Database,
} from "./database";
import { listConnectionsMetadataInScope } from "./connection-metadata";
import {
  listWorkspaceProviderCustomModelsByKindInScope,
  type WorkspaceCustomModelProviderKind,
} from "./model-catalog";
import {
  getOrganizationModelProviderCatalogInScope,
  type OrganizationModelCatalogProviderKind,
} from "./organization-model-providers";

/**
 * One invocation's public model metadata, in one short tenant-scoped read.
 * No credentials, subscription discovery, provider requests or cross-read cache.
 * Each underlying SELECT retains its ordinary READ COMMITTED snapshot.
 */
export async function loadWorkspaceModelCatalogInputs(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    providerKinds: readonly WorkspaceCustomModelProviderKind[];
    organizationProviderKinds: readonly OrganizationModelCatalogProviderKind[];
  },
) {
  return await withRlsContext(db, input, async (scopedDb) => {
    // The former connection reader resolved its account from the workspace.
    // Retain that existence check under the shared fence; an explicit account
    // alone must not turn a deleted workspace into an empty catalog. Refuse
    // inconsistent scope pairs before reading either metadata family.
    const actualScope = await rlsContextForWorkspace(scopedDb, input.workspaceId);
    if (actualScope.accountId !== input.accountId) {
      throw new WorkspaceNotFoundError(input.workspaceId);
    }
    const workspaceConnections = await listConnectionsMetadataInScope(
      scopedDb,
      input.workspaceId,
      null,
    );
    const workspaceCustomModels = await listWorkspaceProviderCustomModelsByKindInScope(
      scopedDb,
      input,
    );
    const organizationProviders = await getOrganizationModelProviderCatalogInScope(scopedDb, {
      ...input,
      providerKinds: input.organizationProviderKinds,
    });
    return { workspaceConnections, workspaceCustomModels, organizationProviders };
  });
}
