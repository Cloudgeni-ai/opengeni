import type {
  ConnectorDocumentDestinationAuthority,
  GoogleDriveBrowseItem,
  GoogleDriveConnectionMetadata as GoogleDriveMetadata,
  GoogleDriveReadPolicy,
  GoogleDriveSyncCadence,
} from "@opengeni/react/app/types";

export type ConfiguredGoogleDriveSource = GoogleDriveBrowseItem & {
  authorityKind: ConnectorDocumentDestinationAuthority;
  syncCadence: GoogleDriveSyncCadence;
  syncEnabled: boolean;
  readPolicy: GoogleDriveReadPolicy;
};

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
