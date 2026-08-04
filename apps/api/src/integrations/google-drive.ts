import { createHash, randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  GOOGLE_DRIVE_CREDENTIAL_LABEL,
  GOOGLE_DRIVE_CREDENTIAL_ROLE,
  GOOGLE_DRIVE_PROVIDER_DOMAIN,
  GOOGLE_DRIVE_READONLY_SCOPE,
  GoogleDriveBrowseItem,
  GoogleDriveBrowseResponse,
  GoogleDriveConnectionLifecycle,
  GoogleDriveConnectionMetadata,
  GoogleDriveOAuthStartResponse,
  SaveGoogleDriveSourceRequest,
  googleDriveOAuthScopeDecision,
  googleDriveScopesAllowCapability,
  type GoogleDriveDisconnectRequest,
  type GoogleDriveLifecycleActionRequest,
  type GoogleDriveOAuthStartRequest,
} from "@opengeni/contracts/google-drive";
import {
  bindConnectorDocumentDestination,
  type ConnectorDocumentDestinationSelection,
} from "@opengeni/contracts/connector-destinations";
import { hasPermission, requireEnvironmentEncryption } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  buildConnectionTokenResolver,
  ConnectionDisconnectGenerationError,
  ConnectionDisconnectIdempotencyError,
  consumeIntegrationOAuthStateNonce,
  createConnection,
  decryptEnvironmentValue,
  disconnectConnectionIdempotently,
  encryptEnvironmentValue,
  getConnectionMetadata,
  getWorkspaceGrant,
  loadConnectionCredentialForBroker,
  transitionConnectionState,
  updateConnection,
  type PermanentConnectionRefreshFailure,
} from "@opengeni/db";
import { createSignedState, readSignedState } from "@opengeni/github";
import { readResponseJsonBounded, type FetchLike } from "@opengeni/network";
import { HTTPException } from "hono/http-exception";
import {
  integrationBaseUrl,
  oauthStateTtlMs,
  requireIntegrationsStateSecret,
} from "./oauth-client";

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const GOOGLE_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const GOOGLE_REQUEST_TIMEOUT_MS = 10_000;
const GOOGLE_DRIVE_PAGE_SIZE = 100;
const GOOGLE_DRIVE_RETURN_PATH = (workspaceId: string) => `/workspaces/${workspaceId}/capabilities`;
const GOOGLE_DRIVE_RECONSENT_ERROR_CODES = new Set([
  "appNotAuthorizedToFile",
  "authError",
  "insufficientFilePermissions",
  "insufficientPermissions",
]);

type GoogleDriveOAuthState = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  returnPath: string;
  encryptedPkceVerifier: string;
  connectionId?: string;
  connectionVersion?: number;
  nonce: string;
  iat: number;
};

type GoogleTokenResponse = {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt: Date | null;
  scopes: string[];
};

type GoogleDriveConnectionRecord = NonNullable<Awaited<ReturnType<typeof getConnectionMetadata>>>;

export async function startGoogleDriveOAuth(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    requestUrl: string;
    payload: GoogleDriveOAuthStartRequest;
  },
): Promise<GoogleDriveOAuthStartResponse> {
  const google = requireGoogleDriveSettings(deps.settings);
  const existing = input.payload.connectionId
    ? await getConnectionMetadata(
        deps.db,
        input.workspaceId,
        input.payload.connectionId,
        input.subjectId,
      )
    : null;
  if (input.payload.connectionId && !existing) {
    throw new HTTPException(404, { message: "Google Drive connection not found" });
  }
  if (existing) {
    requireGoogleDriveConnection(existing, input.subjectId);
  }

  const key = requireEnvironmentEncryption(deps.settings);
  const verifier = randomBytes(48).toString("base64url");
  const baseUrl = integrationBaseUrl(deps.settings.publicBaseUrl, input.requestUrl);
  const redirectUri = `${baseUrl}/v1/integrations/google-drive/callback`;
  const state = createSignedState(requireIntegrationsStateSecret(deps.settings), {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    returnPath: GOOGLE_DRIVE_RETURN_PATH(input.workspaceId),
    encryptedPkceVerifier: encryptEnvironmentValue(key, verifier),
    ...(existing ? { connectionId: existing.id, connectionVersion: existing.version } : {}),
  });
  const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_URL);
  authorizationUrl.searchParams.set("client_id", google.clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", GOOGLE_DRIVE_READONLY_SCOPE);
  authorizationUrl.searchParams.set("access_type", "offline");
  authorizationUrl.searchParams.set("include_granted_scopes", "true");
  authorizationUrl.searchParams.set("prompt", "consent select_account");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set(
    "code_challenge",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  return GoogleDriveOAuthStartResponse.parse({
    authorizationUrl: authorizationUrl.toString(),
    expiresAt: new Date(Date.now() + oauthStateTtlMs).toISOString(),
  });
}

export async function completeGoogleDriveOAuthCallback(
  deps: ApiRouteDeps,
  input: {
    code?: string | undefined;
    state?: string | undefined;
    error?: string | undefined;
    requestUrl: string;
  },
): Promise<{ redirectTo: string }> {
  const baseUrl = integrationBaseUrl(deps.settings.publicBaseUrl, input.requestUrl);
  const returnBaseUrl = deps.settings.webBaseUrl?.replace(/\/+$/, "") ?? baseUrl;
  let state: GoogleDriveOAuthState | null = null;
  try {
    state = readGoogleDriveOAuthState(input.state, deps.settings);
    await requireGoogleDriveCallbackGrant(deps, state);
    const consumed = await consumeIntegrationOAuthStateNonce(deps.db, {
      accountId: state.accountId,
      workspaceId: state.workspaceId,
      subjectId: state.subjectId,
      nonce: state.nonce,
      expiresAt: new Date(state.iat * 1000 + oauthStateTtlMs),
      now: new Date(),
    });
    if (!consumed) {
      throw new HTTPException(400, { message: "Google Drive OAuth state has already been used" });
    }
    if (input.error) {
      throw new GoogleDriveCallbackError("provider_denied");
    }
    if (!input.code) {
      throw new GoogleDriveCallbackError("missing_code");
    }

    const google = requireGoogleDriveSettings(deps.settings);
    const key = requireEnvironmentEncryption(deps.settings);
    const verifier = decryptEnvironmentValue(key, state.encryptedPkceVerifier);
    const redirectUri = `${baseUrl}/v1/integrations/google-drive/callback`;
    const fetchImpl = deps.googleDriveFetch ?? fetch;
    const token = await exchangeGoogleAuthorizationCode(
      {
        code: input.code,
        verifier,
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        redirectUri,
      },
      fetchImpl,
    );
    const scopeDecision = googleDriveOAuthScopeDecision(token.scopes);
    if (
      scopeDecision.accessMode !== "readonly" ||
      !scopeDecision.capabilities.includes("recursive_source_sync")
    ) {
      throw new GoogleDriveCallbackError("scope_not_granted");
    }
    const identity = await verifyGoogleDriveIdentity(token.accessToken, fetchImpl);
    await requireGoogleDriveCallbackGrant(deps, state);
    const existing = state.connectionId
      ? await getConnectionMetadata(deps.db, state.workspaceId, state.connectionId, state.subjectId)
      : null;
    if (state.connectionId && !existing) {
      throw new GoogleDriveCallbackError("connection_conflict");
    }
    if (existing) {
      requireGoogleDriveConnection(existing, state.subjectId);
      if (existing.version !== state.connectionVersion) {
        throw new GoogleDriveCallbackError("connection_conflict");
      }
      const previous = GoogleDriveConnectionMetadata.parse(existing.metadata);
      if (previous.googlePermissionId !== identity.permissionId) {
        throw new GoogleDriveCallbackError("account_mismatch");
      }
    }
    const previousMetadata = existing
      ? GoogleDriveConnectionMetadata.parse(existing.metadata)
      : null;
    let refreshToken = token.refreshToken;
    if (!refreshToken && existing) {
      const previousCredential = await loadConnectionCredentialForBroker(deps.db, deps.settings, {
        workspaceId: state.workspaceId,
        connectionId: existing.id,
        providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
        kind: "oauth2",
        subjectId: state.subjectId,
        allowSubjectOwned: true,
      });
      refreshToken = optionalString(previousCredential?.credential.refresh_token) ?? undefined;
    }
    if (!refreshToken) {
      throw new GoogleDriveCallbackError("refresh_token_missing");
    }
    const credentialEncrypted = encryptEnvironmentValue(
      key,
      JSON.stringify({
        access_token: token.accessToken,
        refresh_token: refreshToken,
        token_type: token.tokenType,
        ...(token.expiresAt ? { expires_at: token.expiresAt.toISOString() } : {}),
        scope: token.scopes.join(" "),
        token_endpoint: GOOGLE_TOKEN_URL,
        client_id: google.clientId,
        client_secret: google.clientSecret,
        token_endpoint_auth_method: "client_secret_post",
      }),
    );
    const metadata = GoogleDriveConnectionMetadata.parse({
      credentialRole: GOOGLE_DRIVE_CREDENTIAL_ROLE,
      credentialLabel: GOOGLE_DRIVE_CREDENTIAL_LABEL,
      googlePermissionId: identity.permissionId,
      googleEmail: identity.emailAddress,
      googleDisplayName: identity.displayName,
      verifiedAt: new Date().toISOString(),
      accessMode: scopeDecision.accessMode,
      lifecycle: googleDriveLifecycle("active"),
      ...(previousMetadata?.documentDestination
        ? { documentDestination: previousMetadata.documentDestination }
        : {}),
      ...(previousMetadata?.selectedSources
        ? { selectedSources: previousMetadata.selectedSources }
        : previousMetadata?.selectedSource
          ? { selectedSources: [previousMetadata.selectedSource] }
          : {}),
    });
    const connection = existing
      ? await updateConnection(deps.db, {
          workspaceId: state.workspaceId,
          connectionId: existing.id,
          visibleToSubjectId: state.subjectId,
          expectedVersion: existing.version,
          subjectId: state.subjectId,
          providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
          kind: "oauth2",
          status: "active",
          credentialEncrypted,
          grantedScopes: token.scopes,
          expiresAt: token.expiresAt,
          metadata,
          updatedBySubjectId: state.subjectId,
        })
      : await createConnection(deps.db, {
          accountId: state.accountId,
          workspaceId: state.workspaceId,
          subjectId: state.subjectId,
          providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
          kind: "oauth2",
          credentialEncrypted,
          grantedScopes: token.scopes,
          expiresAt: token.expiresAt,
          metadata,
          createdBySubjectId: state.subjectId,
        });
    if (!connection) {
      throw new GoogleDriveCallbackError("connection_conflict");
    }
    return {
      redirectTo: googleDriveReturnUrl(returnBaseUrl, state.returnPath, "connected", connection.id),
    };
  } catch (error) {
    return {
      redirectTo: googleDriveReturnUrl(
        returnBaseUrl,
        state?.returnPath ?? "/integrations",
        "error",
        googleDriveErrorReason(error),
      ),
    };
  }
}

export async function transitionGoogleDriveLifecycle(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    subjectId: string;
    connectionId: string;
    payload: GoogleDriveLifecycleActionRequest;
  },
) {
  const existing = await getConnectionMetadata(
    deps.db,
    input.workspaceId,
    input.connectionId,
    input.subjectId,
  );
  if (!existing) {
    throw new HTTPException(404, { message: "Google Drive connection not found" });
  }
  const metadata = requireGoogleDriveConnection(existing, input.subjectId);
  const lifecycle = effectiveGoogleDriveLifecycle(existing, metadata);
  const targetState = input.payload.action === "pause" ? "paused" : "active";

  // Natural convergence makes retried pause/resume requests idempotent even if
  // the caller still carries the pre-transition version.
  if (existing.status === "active" && lifecycle.state === targetState) {
    return existing;
  }
  if (existing.status === "revoked") {
    throw new HTTPException(409, {
      message: "Google Drive is disconnected; connect it again instead",
    });
  }
  if (input.payload.action === "pause" && lifecycle.state !== "active") {
    throw new HTTPException(409, {
      message: "Google Drive must be reconnected before it can be paused",
    });
  }
  if (input.payload.action === "resume" && lifecycle.state !== "paused") {
    throw new HTTPException(409, {
      message: "Google Drive must be reconnected or re-consented before it can resume",
    });
  }
  if (existing.status !== "active" || existing.version !== input.payload.expectedVersion) {
    throw new HTTPException(409, { message: "Google Drive connection changed; try again" });
  }

  const updated = await transitionConnectionState(deps.db, {
    workspaceId: input.workspaceId,
    connectionId: existing.id,
    visibleToSubjectId: input.subjectId,
    expectedVersion: existing.version,
    status: "active",
    metadata: GoogleDriveConnectionMetadata.parse({
      ...metadata,
      lifecycle: googleDriveLifecycle(targetState),
    }),
    lastError: null,
    updatedBySubjectId: input.subjectId,
  });
  if (!updated) {
    const converged = await getConnectionMetadata(
      deps.db,
      input.workspaceId,
      input.connectionId,
      input.subjectId,
    );
    if (converged?.status === "active") {
      const convergedMetadata = requireGoogleDriveConnection(converged, input.subjectId);
      if (effectiveGoogleDriveLifecycle(converged, convergedMetadata).state === targetState) {
        return converged;
      }
    }
    throw new HTTPException(409, { message: "Google Drive connection changed; try again" });
  }
  return updated;
}

export async function disconnectGoogleDrive(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    subjectId: string;
    connection: GoogleDriveConnectionRecord;
    payload: GoogleDriveDisconnectRequest;
  },
) {
  const metadata = requireGoogleDriveConnection(input.connection, input.subjectId);
  try {
    return await disconnectConnectionIdempotently(deps.db, {
      accountId: input.connection.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      connectionId: input.connection.id,
      expectedVersion: input.payload.expectedVersion,
      idempotencyKey: input.payload.idempotencyKey,
      metadata: GoogleDriveConnectionMetadata.parse({
        ...metadata,
        lifecycle: googleDriveLifecycle("disconnected"),
      }),
      lastError: null,
      updatedBySubjectId: input.subjectId,
    });
  } catch (error) {
    if (error instanceof ConnectionDisconnectIdempotencyError) {
      throw new HTTPException(409, {
        message: "Google Drive disconnect key was already used for another operation",
      });
    }
    if (error instanceof ConnectionDisconnectGenerationError) {
      throw new HTTPException(409, {
        message: "Google Drive connection changed; refresh before disconnecting",
      });
    }
    throw error;
  }
}

export async function browseGoogleDrive(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    subjectId: string;
    connectionId: string;
    parentId: string;
    pageToken?: string | undefined;
  },
) {
  const connection = await getConnectionMetadata(
    deps.db,
    input.workspaceId,
    input.connectionId,
    input.subjectId,
  );
  if (!connection) {
    throw new HTTPException(404, { message: "Google Drive connection not found" });
  }
  await requireGoogleDriveSourceConnection(deps, connection, input.subjectId);
  const parentId = validDriveId(input.parentId, "parentId");
  const currentItem = await resolveGoogleDriveBoundaryItem(deps, {
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    connectionId: input.connectionId,
    sourceId: parentId,
  });
  const url = new URL(`${GOOGLE_DRIVE_API_BASE}/files`);
  url.searchParams.set("q", `'${parentId}' in parents and trashed = false`);
  url.searchParams.set("pageSize", String(GOOGLE_DRIVE_PAGE_SIZE));
  url.searchParams.set("orderBy", "folder,name_natural");
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set(
    "fields",
    "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,driveId,size,webViewLink)",
  );
  if (input.pageToken) {
    url.searchParams.set("pageToken", validPageToken(input.pageToken));
  }
  const payload = await googleDriveApiRequest(deps, {
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    connectionId: input.connectionId,
    url,
    label: "Google Drive file list",
  });
  const record = objectRecord(payload);
  const items = Array.isArray(record.files)
    ? record.files
        .map(parseDriveItem)
        .filter((item): item is GoogleDriveBrowseItem => item !== null)
    : [];
  const current =
    (await getConnectionMetadata(
      deps.db,
      input.workspaceId,
      input.connectionId,
      input.subjectId,
    )) ?? connection;
  return GoogleDriveBrowseResponse.parse({
    connection: current,
    parentId,
    current: currentItem,
    items,
    nextPageToken: optionalString(record.nextPageToken),
    incompleteSearch: record.incompleteSearch === true,
  });
}

export async function saveGoogleDriveSource(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    connectionId: string;
    payload: unknown;
    canManageOrganizationDestination: boolean;
    canManageWorkspaceDestination: boolean;
    canManagePersonalDestination: boolean;
  },
) {
  const parsedPayload = SaveGoogleDriveSourceRequest.safeParse(input.payload);
  if (!parsedPayload.success) {
    throw new HTTPException(400, { message: "invalid Google Drive source selection" });
  }
  const payload = parsedPayload.data;
  const existing = await getConnectionMetadata(
    deps.db,
    input.workspaceId,
    input.connectionId,
    input.subjectId,
  );
  if (!existing) {
    throw new HTTPException(404, { message: "Google Drive connection not found" });
  }
  if (existing.accountId !== input.accountId || existing.workspaceId !== input.workspaceId) {
    throw new HTTPException(403, { message: "Google Drive connection authority mismatch" });
  }
  await requireGoogleDriveSourceConnection(deps, existing, input.subjectId);
  const destinationSelection: ConnectorDocumentDestinationSelection = payload.destination ?? {
    authorityKind: "workspace",
    collectionId: null,
  };
  if (
    destinationSelection.authorityKind === "organization" &&
    !input.canManageOrganizationDestination
  ) {
    throw new HTTPException(403, { message: "missing permission: account:admin" });
  }
  if (
    destinationSelection.authorityKind === "workspace" &&
    !input.canManageWorkspaceDestination
  ) {
    throw new HTTPException(403, { message: "missing permission: workspace:admin" });
  }
  if (
    destinationSelection.authorityKind === "personal" &&
    !input.canManagePersonalDestination
  ) {
    throw new HTTPException(403, { message: "personal destination requires the exact actor" });
  }
  const documentDestination = bindConnectorDocumentDestination(destinationSelection, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initiatingSubjectId: input.subjectId,
  });
  const verifiedSources = [];
  for (const source of payload.sources) {
    const sourceId = validDriveId(source.id, "source.id");
    const verified = await resolveGoogleDriveBoundaryItem(deps, {
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      connectionId: input.connectionId,
      sourceId,
    });
    if (
      verified.name !== source.name ||
      verified.mimeType !== source.mimeType ||
      verified.driveId !== source.driveId
    ) {
      throw new HTTPException(409, {
        message: "Google Drive source changed while it was being selected; browse again",
      });
    }
    verifiedSources.push(verified);
  }
  const latest =
    (await getConnectionMetadata(
      deps.db,
      input.workspaceId,
      input.connectionId,
      input.subjectId,
    )) ?? existing;
  const latestMetadata = await requireGoogleDriveSourceConnection(deps, latest, input.subjectId);
  const updated = await transitionConnectionState(deps.db, {
    workspaceId: input.workspaceId,
    connectionId: latest.id,
    visibleToSubjectId: input.subjectId,
    expectedVersion: latest.version,
    metadata: GoogleDriveConnectionMetadata.parse({
      ...latestMetadata,
      documentDestination,
      selectedSource: null,
      selectedSources: verifiedSources.map((verified) => ({
        id: verified.id,
        name: verified.name,
        mimeType: verified.mimeType,
        driveId: verified.driveId,
        destination: documentDestination,
        syncCadence: payload.syncCadence,
        readPolicy: payload.readPolicy,
        selectedAt: new Date().toISOString(),
      })),
    }),
    updatedBySubjectId: input.subjectId,
  });
  if (!updated) {
    throw new HTTPException(409, { message: "Google Drive connection changed; try again" });
  }
  return updated;
}

function googleDriveFileMetadataUrl(fileId: string): URL {
  const url = new URL(`${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "id,name,mimeType,modifiedTime,driveId,size,webViewLink");
  return url;
}

async function resolveGoogleDriveBoundaryItem(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    subjectId: string;
    connectionId: string;
    sourceId: string;
  },
): Promise<GoogleDriveBrowseItem> {
  if (input.sourceId === "root") {
    return GoogleDriveBrowseItem.parse({
      id: "root",
      name: "My Drive",
      mimeType: "application/vnd.google-apps.folder",
      kind: "folder",
      driveId: null,
      modifiedTime: null,
      size: null,
      webViewLink: "https://drive.google.com/drive/my-drive",
    });
  }
  const fileItem = parseDriveItem(
    objectRecord(
      await googleDriveApiRequest(deps, {
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        connectionId: input.connectionId,
        url: googleDriveFileMetadataUrl(input.sourceId),
        label: "Google Drive source metadata",
      }),
    ),
  );
  if (!fileItem) {
    throw new HTTPException(502, { message: "Google Drive returned invalid source metadata" });
  }
  if (fileItem.kind !== "folder") {
    throw new HTTPException(400, { message: "Google Drive source must be a Drive or folder" });
  }
  if (fileItem.driveId !== fileItem.id) return fileItem;

  const driveUrl = new URL(
    `${GOOGLE_DRIVE_API_BASE}/drives/${encodeURIComponent(fileItem.driveId)}`,
  );
  driveUrl.searchParams.set("fields", "id,name");
  let drive: Record<string, unknown>;
  try {
    drive = objectRecord(
      await googleDriveApiRequest(deps, {
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        connectionId: input.connectionId,
        url: driveUrl,
        label: "Google Shared Drive metadata",
      }),
    );
  } catch (error) {
    if (error instanceof HTTPException && error.status === 403) return fileItem;
    throw error;
  }
  const driveName = optionalString(drive.name);
  if (optionalString(drive.id) !== fileItem.id || !driveName) {
    throw new HTTPException(502, {
      message: "Google Drive returned invalid Shared Drive metadata",
    });
  }
  return GoogleDriveBrowseItem.parse({
    ...fileItem,
    name: driveName,
    webViewLink: `https://drive.google.com/drive/folders/${encodeURIComponent(fileItem.id)}`,
  });
}

function requireGoogleDriveSettings(settings: Settings): {
  clientId: string;
  clientSecret: string;
} {
  const clientId = settings.googleDriveClientId?.trim();
  const clientSecret = settings.googleDriveClientSecret?.trim();
  if (!clientId || !clientSecret) {
    throw new HTTPException(503, {
      message:
        "Google Drive requires OPENGENI_GOOGLE_DRIVE_CLIENT_ID and OPENGENI_GOOGLE_DRIVE_CLIENT_SECRET",
    });
  }
  return { clientId, clientSecret };
}

function requireGoogleDriveConnection(connection: GoogleDriveConnectionRecord, subjectId: string) {
  const parsed = GoogleDriveConnectionMetadata.safeParse(connection.metadata);
  if (
    connection.subjectId !== subjectId ||
    connection.providerDomain !== GOOGLE_DRIVE_PROVIDER_DOMAIN ||
    connection.kind !== "oauth2" ||
    !parsed.success
  ) {
    throw new HTTPException(422, { message: "connection is not this user's Google Drive" });
  }
  return parsed.data;
}

function googleDriveLifecycle(
  state: GoogleDriveConnectionLifecycle["state"],
): GoogleDriveConnectionLifecycle {
  return GoogleDriveConnectionLifecycle.parse({
    state,
    recoverable: state !== "app_removed",
    observedAt: new Date().toISOString(),
  });
}

function effectiveGoogleDriveLifecycle(
  connection: GoogleDriveConnectionRecord,
  metadata: ReturnType<typeof requireGoogleDriveConnection>,
): GoogleDriveConnectionLifecycle {
  if (metadata.lifecycle) return metadata.lifecycle;
  if (connection.status === "revoked") return googleDriveLifecycle("disconnected");
  if (connection.status === "active") return googleDriveLifecycle("active");
  return googleDriveLifecycle("reconnect_required");
}

async function transitionGoogleDriveConnectionLifecycle(
  deps: ApiRouteDeps,
  connection: GoogleDriveConnectionRecord,
  subjectId: string,
  lifecycle: GoogleDriveConnectionLifecycle,
  status: "active" | "needs_reauth" | "error",
  lastError: string | null,
) {
  const metadata = requireGoogleDriveConnection(connection, subjectId);
  if (
    connection.status === status &&
    metadata.lifecycle?.state === lifecycle.state &&
    metadata.lifecycle.recoverable === lifecycle.recoverable
  ) {
    return connection;
  }
  return await transitionConnectionState(deps.db, {
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    visibleToSubjectId: subjectId,
    expectedVersion: connection.version,
    status,
    metadata: GoogleDriveConnectionMetadata.parse({ ...metadata, lifecycle }),
    lastError,
    updatedBySubjectId: subjectId,
  });
}

async function requireGoogleDriveSourceConnection(
  deps: ApiRouteDeps,
  connection: GoogleDriveConnectionRecord,
  subjectId: string,
) {
  const metadata = requireGoogleDriveConnection(connection, subjectId);
  const lifecycle = effectiveGoogleDriveLifecycle(connection, metadata);
  if (connection.status === "revoked") {
    throw new HTTPException(409, { message: "Google Drive is disconnected" });
  }
  if (lifecycle.state === "paused") {
    throw new HTTPException(409, { message: "Google Drive is paused" });
  }
  if (connection.status !== "active" || lifecycle.state !== "active") {
    throw new HTTPException(401, {
      message:
        lifecycle.state === "reconsent_required"
          ? "Google Drive needs permission re-consent"
          : lifecycle.state === "app_removed"
            ? "Google Drive app access is unavailable"
            : "Google Drive needs to be reconnected",
    });
  }
  if (!googleDriveScopesAllowCapability(connection.grantedScopes, "recursive_source_sync")) {
    await transitionGoogleDriveConnectionLifecycle(
      deps,
      connection,
      subjectId,
      googleDriveLifecycle("reconsent_required"),
      "needs_reauth",
      "google_drive_reconsent_required",
    );
    throw new HTTPException(401, {
      message: "Google Drive needs permission re-consent for selected-source read access",
    });
  }
  return metadata;
}

function readGoogleDriveOAuthState(
  raw: string | undefined,
  settings: Settings,
): GoogleDriveOAuthState {
  if (!raw) {
    throw new HTTPException(400, { message: "missing Google Drive OAuth state" });
  }
  const payload = readSignedState(raw, requireIntegrationsStateSecret(settings)) as Record<
    string,
    unknown
  > | null;
  if (!payload) {
    throw new HTTPException(400, { message: "invalid or expired Google Drive OAuth state" });
  }
  const iat = numberValue(payload.iat);
  const now = Math.floor(Date.now() / 1000);
  if (iat === undefined || now < iat || now - iat > oauthStateTtlMs / 1000) {
    throw new HTTPException(400, { message: "invalid or expired Google Drive OAuth state" });
  }
  return {
    accountId: requiredString(payload.accountId, "state.accountId"),
    workspaceId: requiredString(payload.workspaceId, "state.workspaceId"),
    subjectId: requiredString(payload.subjectId, "state.subjectId"),
    returnPath: requiredString(payload.returnPath, "state.returnPath"),
    encryptedPkceVerifier: requiredString(
      payload.encryptedPkceVerifier,
      "state.encryptedPkceVerifier",
    ),
    ...(optionalString(payload.connectionId)
      ? { connectionId: optionalString(payload.connectionId)! }
      : {}),
    ...(numberValue(payload.connectionVersion) !== undefined
      ? { connectionVersion: numberValue(payload.connectionVersion)! }
      : {}),
    nonce: requiredString(payload.nonce, "state.nonce"),
    iat,
  };
}

async function requireGoogleDriveCallbackGrant(
  deps: ApiRouteDeps,
  state: GoogleDriveOAuthState,
): Promise<void> {
  const grant = await getWorkspaceGrant(deps.db, state.subjectId, state.workspaceId);
  if (
    !grant ||
    grant.accountId !== state.accountId ||
    !hasPermission(grant.permissions, "connections:write")
  ) {
    throw new HTTPException(403, {
      message: "Google Drive OAuth subject no longer has permission for this workspace",
    });
  }
}

async function exchangeGoogleAuthorizationCode(
  input: {
    code: string;
    verifier: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  },
  fetchImpl: FetchLike,
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code: input.code,
    code_verifier: input.verifier,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
  });
  const response = await providerFetch(fetchImpl, GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GoogleDriveCallbackError("token_exchange_failed");
  }
  const payload = objectRecord(
    await readResponseJsonBounded<unknown>(
      response,
      GOOGLE_RESPONSE_MAX_BYTES,
      "Google OAuth token response",
    ),
  );
  const accessToken = optionalString(payload.access_token);
  if (!accessToken) {
    throw new GoogleDriveCallbackError("token_exchange_failed");
  }
  const expiresIn = numberValue(payload.expires_in);
  return {
    accessToken,
    ...(optionalString(payload.refresh_token)
      ? { refreshToken: optionalString(payload.refresh_token)! }
      : {}),
    tokenType: optionalString(payload.token_type) ?? "Bearer",
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    scopes: uniqueStrings((optionalString(payload.scope) ?? "").split(/\s+/)),
  };
}

async function verifyGoogleDriveIdentity(accessToken: string, fetchImpl: FetchLike) {
  const url = new URL(`${GOOGLE_DRIVE_API_BASE}/about`);
  url.searchParams.set("fields", "user(displayName,emailAddress,permissionId)");
  const response = await providerFetch(fetchImpl, url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GoogleDriveCallbackError("identity_verification_failed");
  }
  const payload = objectRecord(
    await readResponseJsonBounded<unknown>(
      response,
      GOOGLE_RESPONSE_MAX_BYTES,
      "Google Drive identity response",
    ),
  );
  const user = objectRecord(payload.user);
  const permissionId = optionalString(user.permissionId);
  const emailAddress = optionalString(user.emailAddress);
  if (!permissionId || !emailAddress) {
    throw new GoogleDriveCallbackError("identity_verification_failed");
  }
  return {
    permissionId,
    emailAddress,
    displayName: optionalString(user.displayName),
  };
}

function googleDriveRefreshFailureLifecycle(failure: PermanentConnectionRefreshFailure): {
  lifecycle: GoogleDriveConnectionLifecycle;
  status: "needs_reauth" | "error";
  lastError: string;
} {
  const code = failure.oauthErrorCode?.toLowerCase() ?? null;
  if (code === "invalid_client" || code === "unauthorized_client") {
    return {
      lifecycle: googleDriveLifecycle("app_removed"),
      status: "error",
      lastError: "google_drive_app_removed",
    };
  }
  if (code === "invalid_scope" || code === "insufficient_scope") {
    return {
      lifecycle: googleDriveLifecycle("reconsent_required"),
      status: "needs_reauth",
      lastError: "google_drive_reconsent_required",
    };
  }
  if (code === "invalid_grant") {
    return {
      lifecycle: googleDriveLifecycle("token_revoked"),
      status: "needs_reauth",
      lastError: "google_drive_token_revoked",
    };
  }
  return {
    lifecycle: googleDriveLifecycle("reconnect_required"),
    status: "needs_reauth",
    lastError: "google_drive_reconnect_required",
  };
}

async function transitionGoogleDrivePermanentRefreshFailure(
  deps: ApiRouteDeps,
  failure: PermanentConnectionRefreshFailure,
): Promise<boolean> {
  if (failure.providerDomain !== GOOGLE_DRIVE_PROVIDER_DOMAIN || !failure.subjectId) {
    return false;
  }
  const connection = await getConnectionMetadata(
    deps.db,
    failure.workspaceId,
    failure.connectionId,
    failure.subjectId,
  );
  if (!connection || connection.version !== failure.connectionVersion) {
    return true;
  }
  const transition = googleDriveRefreshFailureLifecycle(failure);
  await transitionGoogleDriveConnectionLifecycle(
    deps,
    connection,
    failure.subjectId,
    transition.lifecycle,
    transition.status,
    transition.lastError,
  );
  return true;
}

async function transitionGoogleDriveProviderResponseFailure(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    subjectId: string;
    connectionId: string;
    connectionVersion: number;
    lifecycle: GoogleDriveConnectionLifecycle;
    status: "needs_reauth" | "error";
    lastError: string;
  },
): Promise<void> {
  const latest = await getConnectionMetadata(
    deps.db,
    input.workspaceId,
    input.connectionId,
    input.subjectId,
  );
  if (!latest || latest.version !== input.connectionVersion || latest.status !== "active") {
    return;
  }
  await transitionGoogleDriveConnectionLifecycle(
    deps,
    latest,
    input.subjectId,
    input.lifecycle,
    input.status,
    input.lastError,
  );
}

async function googleDriveApiRequest(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    subjectId: string;
    connectionId: string;
    url: URL;
    label: string;
  },
): Promise<unknown> {
  const current = await getConnectionMetadata(
    deps.db,
    input.workspaceId,
    input.connectionId,
    input.subjectId,
  );
  if (!current) {
    throw new HTTPException(404, { message: "Google Drive connection not found" });
  }
  await requireGoogleDriveSourceConnection(deps, current, input.subjectId);
  const resolver = buildConnectionTokenResolver(deps.db, deps.settings, undefined, {
    ...(deps.googleDriveFetch ? { refreshTransport: { fetchImpl: deps.googleDriveFetch } } : {}),
    transitionPermanentRefreshFailure: async (failure) =>
      await transitionGoogleDrivePermanentRefreshFailure(deps, failure),
  });
  const resolve = async (forceRefresh: boolean) =>
    await resolver({
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      serverId: "google-drive-source-browser",
      toolName: input.label,
      connectionRef: {
        providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
        connectionId: input.connectionId,
        kind: "oauth2",
        subjectScope: "subject",
      },
      destinationUrl: input.url.toString(),
      forceRefresh,
    });
  let credential = await resolve(false);
  if (credential.status !== "ok") {
    throw new HTTPException(401, { message: "Google Drive needs to be reconnected" });
  }
  let providerConnectionVersion = credential.connectionVersion;
  if (providerConnectionVersion === undefined) {
    throw new Error("Google Drive credential resolver omitted the connection version");
  }
  const fetchImpl = deps.googleDriveFetch ?? fetch;
  let response = await providerFetch(fetchImpl, input.url, {
    headers: { ...credential.headers, accept: "application/json" },
  });
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    credential = await resolve(true);
    if (credential.status !== "ok") {
      throw new HTTPException(401, { message: "Google Drive needs to be reconnected" });
    }
    providerConnectionVersion = credential.connectionVersion;
    if (providerConnectionVersion === undefined) {
      throw new Error("Google Drive credential resolver omitted the connection version");
    }
    response = await providerFetch(fetchImpl, input.url, {
      headers: { ...credential.headers, accept: "application/json" },
    });
  }
  if (!response.ok) {
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      await transitionGoogleDriveProviderResponseFailure(deps, {
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        connectionId: input.connectionId,
        connectionVersion: providerConnectionVersion,
        lifecycle: googleDriveLifecycle("reconnect_required"),
        status: "needs_reauth",
        lastError: "google_drive_reconnect_required",
      });
      throw new HTTPException(401, { message: "Google Drive needs to be reconnected" });
    }
    const providerErrorCode =
      response.status === 403 ? await readGoogleDriveProviderErrorCode(response) : null;
    if (response.status !== 403) {
      await response.body?.cancel().catch(() => undefined);
    }
    if (
      response.status === 403 &&
      providerErrorCode &&
      GOOGLE_DRIVE_RECONSENT_ERROR_CODES.has(providerErrorCode)
    ) {
      await transitionGoogleDriveProviderResponseFailure(deps, {
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        connectionId: input.connectionId,
        connectionVersion: providerConnectionVersion,
        lifecycle: googleDriveLifecycle("reconsent_required"),
        status: "needs_reauth",
        lastError: "google_drive_reconsent_required",
      });
    }
    throw new HTTPException(response.status === 403 ? 403 : 502, {
      message:
        response.status === 403
          ? "Google Drive denied metadata access; re-consent may be required"
          : "Google Drive metadata request failed",
    });
  }
  return await readResponseJsonBounded<unknown>(response, GOOGLE_RESPONSE_MAX_BYTES, input.label);
}

async function providerFetch(
  fetchImpl: FetchLike,
  url: string | URL,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new HTTPException(502, { message: "Google Drive is temporarily unavailable" });
  }
}

async function readGoogleDriveProviderErrorCode(response: Response): Promise<string | null> {
  try {
    const payload = objectRecord(
      await readResponseJsonBounded<unknown>(
        response,
        GOOGLE_RESPONSE_MAX_BYTES,
        "Google Drive error response",
      ),
    );
    const error = objectRecord(payload.error);
    const first = Array.isArray(error.errors) ? objectRecord(error.errors[0]) : {};
    const code = optionalString(first.reason) ?? optionalString(error.status);
    return code && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : null;
  } catch {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
}

function parseDriveItem(value: unknown): GoogleDriveBrowseItem | null {
  const item = objectRecord(value);
  const id = optionalString(item.id);
  const name = optionalString(item.name);
  const mimeType = optionalString(item.mimeType);
  if (!id || !name || !mimeType) {
    return null;
  }
  return {
    id,
    name,
    mimeType,
    kind: mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE ? "folder" : "file",
    driveId: optionalString(item.driveId),
    modifiedTime: optionalString(item.modifiedTime),
    size: optionalString(item.size),
    webViewLink: optionalString(item.webViewLink),
  };
}

function validDriveId(value: string, label: string): string {
  const candidate = value.trim();
  if (candidate === "root" || /^[A-Za-z0-9_-]{1,256}$/.test(candidate)) {
    return candidate;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol === "https:" && url.hostname === "drive.google.com") {
      const folderId = url.pathname.match(/(?:^|\/)folders\/([A-Za-z0-9_-]{1,256})(?:\/|$)/)?.[1];
      if (folderId) {
        return folderId;
      }
    }
  } catch {
    // Fall through to the bounded public error below.
  }
  throw new HTTPException(400, { message: `${label} is invalid` });
}

function validPageToken(value: string): string {
  if (value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/.test(value)) {
    return value;
  }
  throw new HTTPException(400, { message: "pageToken is invalid" });
}

function googleDriveReturnUrl(
  returnBaseUrl: string,
  returnPath: string,
  status: "connected" | "error",
  value: string,
): string {
  const url = new URL(returnPath, returnBaseUrl);
  url.searchParams.set("google_drive", status);
  url.searchParams.set(status === "connected" ? "connectionId" : "reason", value);
  return url.toString();
}

function googleDriveErrorReason(error: unknown): string {
  if (error instanceof GoogleDriveCallbackError) {
    return error.reason;
  }
  if (error instanceof HTTPException) {
    return `http_${error.status}`;
  }
  return "connection_failed";
}

class GoogleDriveCallbackError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "GoogleDriveCallbackError";
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredString(value: unknown, label: string): string {
  const parsed = optionalString(value);
  if (!parsed) {
    throw new HTTPException(400, { message: `${label} is invalid` });
  }
  return parsed;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
