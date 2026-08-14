import type {
  ConnectionMetadata,
  GoogleDriveConnectionMetadata,
  GoogleDriveDisconnectRequest,
} from "@/types";

const GOOGLE_DRIVE_PROVIDER_DOMAIN = "googleapis.com";
const GOOGLE_DRIVE_FULL_SCOPE = "https://www.googleapis.com/auth/drive";
const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export const GOOGLE_DRIVE_APP_DESCRIPTION =
  "Browse selected folders and Shared Drives for read-only knowledge sync.";

export const GOOGLE_DRIVE_ACCESS_DISCLOSURE =
  "For source sync, OpenGeni requests read-only Google Drive access to browse folders and Shared Drives and, only after you enable synchronization, import supported files within the boundaries you select. OAuth tokens stay encrypted on the server. Without separate publishing consent, OpenGeni cannot create, edit, or delete files in Drive.";

export const GOOGLE_DRIVE_PUBLISHING_DISCLOSURE =
  "Publishing is optional and requests separate drive.file consent. OpenGeni publishes only completed editable-artifact exports into the output folder you explicitly configure; connector actions ask before writing by default. This consent does not widen source-sync boundaries.";

export const GOOGLE_DRIVE_SYNC_BEHAVIOR =
  "The first sync inventories existing supported files. Later scheduled runs rescan the selected boundaries and skip unchanged revisions; Google Changes API eventing is not enabled.";

export function localConnectedGoogleDrivePreview(
  search: string,
  workspaceId: string,
  enabled = import.meta.env.DEV,
): ConnectionMetadata | null {
  if (!enabled || new URLSearchParams(search).get("previewGoogleDrive") !== "connected") {
    return null;
  }

  const now = new Date().toISOString();
  return {
    id: "00000000-0000-4000-8000-000000000011",
    accountId: "00000000-0000-4000-8000-000000000001",
    workspaceId,
    subjectId: "preview-user",
    providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
    kind: "oauth2",
    status: "active",
    grantedScopes: ["https://www.googleapis.com/auth/drive.readonly"],
    expiresAt: null,
    lastRefreshAt: now,
    lastUsedAt: now,
    lastError: null,
    version: 1,
    metadata: {
      credentialRole: "google_drive_metadata",
      credentialLabel: "Google Drive read-only source sync",
      googlePermissionId: "preview-permission",
      googleEmail: "bendik@cloudgeni.ai",
      googleDisplayName: "Bendik Nyheim",
      verifiedAt: now,
      accessMode: "readonly",
      lifecycle: { state: "active", recoverable: true, observedAt: now },
      selectedSources: [
        {
          id: "preview-cloudgeni-drive",
          name: "CloudGeni",
          mimeType: "application/vnd.google-apps.folder",
          driveId: "preview-cloudgeni-drive",
          syncCadence: "hourly",
          syncEnabled: true,
          configGeneration: 1,
          readPolicy: "allow",
          selectedAt: now,
        },
        {
          id: "preview-research-folder",
          name: "Research",
          mimeType: "application/vnd.google-apps.folder",
          driveId: "preview-cloudgeni-drive",
          syncCadence: "hourly",
          syncEnabled: true,
          configGeneration: 1,
          readPolicy: "allow",
          selectedAt: now,
        },
      ],
    },
    createdBySubjectId: "preview-user",
    updatedBySubjectId: "preview-user",
    createdAt: now,
    updatedAt: now,
  };
}

export type GoogleDriveAccountState =
  | { state: "unverified" }
  | { state: "not_connected" }
  | { state: "connected"; connection: ConnectionMetadata; recoverable: true }
  | { state: "paused"; connection: ConnectionMetadata; recoverable: true }
  | { state: "token_revoked"; connection: ConnectionMetadata; recoverable: true }
  | { state: "app_removed"; connection: ConnectionMetadata; recoverable: false }
  | { state: "reconnect_required"; connection: ConnectionMetadata; recoverable: true }
  | { state: "reconsent_required"; connection: ConnectionMetadata; recoverable: true }
  | { state: "disconnected"; connection: ConnectionMetadata; recoverable: true };

export type GoogleDriveDisconnectAttempt = GoogleDriveDisconnectRequest & {
  connectionId: string;
};

/** Preserve one operation key across retries of the same immutable connection generation. */
export function googleDriveDisconnectAttempt(
  connection: Pick<ConnectionMetadata, "id" | "version">,
  previous: GoogleDriveDisconnectAttempt | null,
  createIdempotencyKey: () => string = () => crypto.randomUUID(),
): GoogleDriveDisconnectAttempt {
  if (previous?.connectionId === connection.id && previous.expectedVersion === connection.version) {
    return previous;
  }
  return {
    connectionId: connection.id,
    expectedVersion: connection.version,
    idempotencyKey: createIdempotencyKey(),
  };
}

export function googleDriveConnectionMetadata(
  value: Record<string, unknown>,
): GoogleDriveConnectionMetadata | null {
  if (
    value.credentialRole !== "google_drive_metadata" ||
    typeof value.googlePermissionId !== "string" ||
    typeof value.googleEmail !== "string" ||
    (value.accessMode !== "file_only" &&
      value.accessMode !== "metadata_readonly" &&
      value.accessMode !== "readonly")
  ) {
    return null;
  }
  return value as GoogleDriveConnectionMetadata;
}

export function googleDriveConnections(connections: ConnectionMetadata[]): ConnectionMetadata[] {
  return connections.filter(
    (connection) =>
      connection.subjectId !== null &&
      connection.kind === "oauth2" &&
      normalizedProviderDomain(connection.providerDomain) === GOOGLE_DRIVE_PROVIDER_DOMAIN &&
      googleDriveConnectionMetadata(connection.metadata) !== null,
  );
}

/** Prefer usable/actionable current truth, retaining the newest revoked row for disconnected UX. */
export function preferredGoogleDriveConnection(
  connections: ConnectionMetadata[],
): ConnectionMetadata | null {
  return (
    googleDriveConnections(connections).sort((left, right) => {
      const statusRank = (connection: ConnectionMetadata) =>
        connection.status === "active"
          ? 0
          : connection.status === "needs_reauth"
            ? 1
            : connection.status === "error"
              ? 2
              : 3;
      return (
        statusRank(left) - statusRank(right) ||
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
        right.id.localeCompare(left.id)
      );
    })[0] ?? null
  );
}

/** Secret-safe lifecycle projection. Provider bodies and `lastError` never drive UI text. */
export function googleDriveAccountState(
  connection: ConnectionMetadata | null,
  loaded: boolean,
): GoogleDriveAccountState {
  if (!loaded) return { state: "unverified" };
  if (!connection) return { state: "not_connected" };
  if (connection.status === "revoked") {
    return { state: "disconnected", connection, recoverable: true };
  }

  const metadata = googleDriveConnectionMetadata(connection.metadata);
  if (!metadata) return { state: "reconnect_required", connection, recoverable: true };
  const lifecycle = metadata.lifecycle;
  if (lifecycle?.state === "app_removed") {
    return { state: "app_removed", connection, recoverable: false };
  }
  if (lifecycle?.state === "disconnected") {
    return { state: "disconnected", connection, recoverable: true };
  }
  if (lifecycle?.state === "token_revoked") {
    return { state: "token_revoked", connection, recoverable: true };
  }
  if (lifecycle?.state === "reconsent_required" || metadata.accessMode === "metadata_readonly") {
    return { state: "reconsent_required", connection, recoverable: true };
  }
  if (lifecycle?.state === "paused" && connection.status === "active") {
    return { state: "paused", connection, recoverable: true };
  }
  if (
    lifecycle?.state === "reconnect_required" ||
    connection.status === "needs_reauth" ||
    connection.status === "error"
  ) {
    return { state: "reconnect_required", connection, recoverable: true };
  }
  return { state: "connected", connection, recoverable: true };
}

export function googleDriveCanReadSources(
  metadata: GoogleDriveConnectionMetadata | null | undefined,
): boolean {
  return metadata?.accessMode === "readonly";
}

export function googleDriveCanPublish(connection: ConnectionMetadata | null): boolean {
  if (!connection) return false;
  const scopes = new Set(connection.grantedScopes);
  return scopes.has(GOOGLE_DRIVE_FULL_SCOPE) || scopes.has(GOOGLE_DRIVE_FILE_SCOPE);
}

function normalizedProviderDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}
