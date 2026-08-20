import { request as apiRequest } from "@/api";
import type {
  ConnectorDocumentDestinationAuthority,
  ConnectionMetadata,
  GoogleDriveBrowseItem,
  GoogleDriveConnectionMetadata as GoogleDriveMetadata,
  GoogleDriveReadPolicy,
  GoogleDriveSyncCadence,
} from "@/types";

export type ConfiguredGoogleDriveSource = GoogleDriveBrowseItem & {
  authorityKind: ConnectorDocumentDestinationAuthority;
  syncCadence: GoogleDriveSyncCadence;
  syncEnabled: boolean;
  readPolicy: GoogleDriveReadPolicy;
};

/**
 * Save one Google Drive source selection for the exact connection. Shared by the
 * folder picker and by the sheet's sync toggle so both write the same shape.
 */
export async function saveGoogleDriveSources(
  workspaceId: string,
  connectionId: string,
  input: {
    sources: Array<Pick<GoogleDriveBrowseItem, "id" | "name" | "mimeType" | "driveId">>;
    authorityKind: ConnectorDocumentDestinationAuthority;
    syncCadence: GoogleDriveSyncCadence;
    syncEnabled: boolean;
    readPolicy: GoogleDriveReadPolicy;
  },
): Promise<ConnectionMetadata> {
  const { connection } = await apiRequest<{ connection: ConnectionMetadata }>(
    `/v1/workspaces/${workspaceId}/connections/google-drive/${connectionId}/source`,
    {
      method: "POST",
      body: JSON.stringify({
        sources: input.sources.map((selected) => ({
          id: selected.id,
          name: selected.name,
          mimeType: selected.mimeType,
          driveId: selected.driveId,
        })),
        destination: { authorityKind: input.authorityKind, collectionId: null },
        syncCadence: input.syncCadence,
        syncEnabled: input.syncEnabled,
        readPolicy: input.readPolicy,
      }),
    },
  );
  return connection;
}

export function googleDriveCadenceLabel(cadence: GoogleDriveSyncCadence): string {
  if (cadence === "manual") return "On demand";
  if (cadence === "daily") return "Daily";
  return "Hourly";
}

export function googleDriveReadPolicyLabel(policy: GoogleDriveReadPolicy): string {
  if (policy === "ask") return "Ask for actions";
  if (policy === "block") return "Actions blocked";
  return "Actions allowed";
}

export function googleDriveBoundaryLabel(source: {
  id: string;
  name: string;
  driveId: string | null;
}): string {
  if (source.id === source.driveId && source.name.trim() === "Drive") {
    return `Shared Drive · ${source.id.slice(-6)}`;
  }
  return source.name.trim();
}

export function configuredGoogleDriveSources(
  metadata: GoogleDriveMetadata | undefined,
): ConfiguredGoogleDriveSource[] {
  const sources =
    metadata?.selectedSources ?? (metadata?.selectedSource ? [metadata.selectedSource] : []);
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    mimeType: source.mimeType,
    kind: "folder",
    driveId: source.driveId,
    modifiedTime: null,
    size: null,
    webViewLink: null,
    authorityKind:
      source.destination?.authorityKind ??
      metadata?.documentDestination?.authorityKind ??
      "workspace",
    syncCadence: source.syncCadence,
    syncEnabled: source.syncEnabled,
    readPolicy: source.readPolicy,
  }));
}

export function googleDriveDestinationOptionDisabled(
  authorityKind: ConnectorDocumentDestinationAuthority,
  canManageWorkspaceDestination: boolean,
  canManageOrganizationDestination: boolean,
): boolean {
  if (authorityKind === "organization") return !canManageOrganizationDestination;
  if (authorityKind === "workspace") return !canManageWorkspaceDestination;
  return false;
}

export function googleDriveScopeLabel(scope: ConnectorDocumentDestinationAuthority): string {
  if (scope === "personal") return "Only me";
  if (scope === "organization") return "Company";
  return "Workspace";
}
