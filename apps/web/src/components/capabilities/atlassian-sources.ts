import { request as apiRequest } from "@/api";
import type {
  AtlassianBrowseItem,
  AtlassianSyncCadence,
  ConnectorDocumentDestinationAuthority,
  ConnectionMetadata,
} from "@/types";

type AtlassianSourceInput = Pick<
  AtlassianBrowseItem,
  "id" | "cloudId" | "siteName" | "siteUrl" | "resourceId" | "key" | "name" | "kind"
>;

/**
 * Save one Jira/Confluence source selection for the exact connection. Shared by
 * the source picker and by the sheet's sync toggle so both write the same shape.
 */
export async function saveAtlassianSources(
  workspaceId: string,
  connectionId: string,
  input: {
    sources: AtlassianSourceInput[];
    authorityKind: ConnectorDocumentDestinationAuthority;
    syncCadence: AtlassianSyncCadence;
    syncEnabled: boolean;
  },
): Promise<ConnectionMetadata> {
  const { connection } = await apiRequest<{ connection: ConnectionMetadata }>(
    `/v1/workspaces/${workspaceId}/connections/atlassian/${connectionId}/source`,
    {
      method: "POST",
      body: JSON.stringify({
        sources: input.sources.map(
          ({ id, cloudId, siteName, siteUrl, resourceId, key, name, kind }) => ({
            id,
            cloudId,
            siteName,
            siteUrl,
            resourceId,
            key,
            name,
            kind,
          }),
        ),
        destination: { authorityKind: input.authorityKind, collectionId: null },
        syncCadence: input.syncCadence,
        syncEnabled: input.syncEnabled,
        readPolicy: "allow",
      }),
    },
  );
  return connection;
}
