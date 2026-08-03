import type {
  ConnectionMetadata,
  GoogleDriveConnectionMetadata,
  GoogleDriveDisconnectRequest,
} from "@/types";

const GOOGLE_DRIVE_PROVIDER_DOMAIN = "googleapis.com";

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
    (value.accessMode !== "metadata_readonly" && value.accessMode !== "readonly")
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
  if (lifecycle?.state === "reconsent_required" || metadata.accessMode !== "readonly") {
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

function normalizedProviderDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}
