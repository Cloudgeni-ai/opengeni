import { createHash, randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  GOOGLE_DRIVE_CREDENTIAL_LABEL,
  GOOGLE_DRIVE_CREDENTIAL_ROLE,
  GOOGLE_DRIVE_METADATA_READONLY_SCOPE,
  GOOGLE_DRIVE_PROVIDER_DOMAIN,
  GoogleDriveBrowseResponse,
  GoogleDriveConnectionMetadata,
  GoogleDriveOAuthStartResponse,
  SaveGoogleDriveSourceRequest,
  type GoogleDriveBrowseItem,
  type GoogleDriveOAuthStartRequest,
} from "@opengeni/contracts";
import { hasPermission, requireEnvironmentEncryption } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  buildConnectionTokenResolver,
  consumeIntegrationOAuthStateNonce,
  createConnection,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  getConnectionMetadata,
  getWorkspaceGrant,
  loadConnectionCredentialForBroker,
  updateConnection,
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
  authorizationUrl.searchParams.set("scope", GOOGLE_DRIVE_METADATA_READONLY_SCOPE);
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
    if (!token.scopes.includes(GOOGLE_DRIVE_METADATA_READONLY_SCOPE)) {
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
      accessMode: "metadata_readonly",
      ...(previousMetadata?.selectedSource
        ? { selectedSource: previousMetadata.selectedSource }
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
  requireGoogleDriveConnection(connection, input.subjectId);
  const parentId = validDriveId(input.parentId, "parentId");
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
    items,
    nextPageToken: optionalString(record.nextPageToken),
    incompleteSearch: record.incompleteSearch === true,
  });
}

export async function saveGoogleDriveSource(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    subjectId: string;
    connectionId: string;
    payload: unknown;
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
  requireGoogleDriveConnection(existing, input.subjectId);
  const sourceId = validDriveId(payload.source.id, "source.id");
  const url = new URL(`${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(sourceId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "id,name,mimeType,modifiedTime,driveId,size,webViewLink");
  const verified = parseDriveItem(
    objectRecord(
      await googleDriveApiRequest(deps, {
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        connectionId: input.connectionId,
        url,
        label: "Google Drive source metadata",
      }),
    ),
  );
  if (!verified) {
    throw new HTTPException(502, { message: "Google Drive returned invalid source metadata" });
  }
  if (
    verified.name !== payload.source.name ||
    verified.mimeType !== payload.source.mimeType ||
    verified.driveId !== payload.source.driveId
  ) {
    throw new HTTPException(409, {
      message: "Google Drive source changed while it was being selected; browse again",
    });
  }
  const latest =
    (await getConnectionMetadata(
      deps.db,
      input.workspaceId,
      input.connectionId,
      input.subjectId,
    )) ?? existing;
  const latestMetadata = requireGoogleDriveConnection(latest, input.subjectId);
  const updated = await updateConnection(deps.db, {
    workspaceId: input.workspaceId,
    connectionId: latest.id,
    visibleToSubjectId: input.subjectId,
    expectedVersion: latest.version,
    metadata: GoogleDriveConnectionMetadata.parse({
      ...latestMetadata,
      selectedSource: {
        id: verified.id,
        name: verified.name,
        mimeType: verified.mimeType,
        driveId: verified.driveId,
        targetScope: payload.targetScope,
        selectedAt: new Date().toISOString(),
      },
    }),
    updatedBySubjectId: input.subjectId,
  });
  if (!updated) {
    throw new HTTPException(409, { message: "Google Drive connection changed; try again" });
  }
  return updated;
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

function requireGoogleDriveConnection(
  connection: {
    subjectId: string | null;
    providerDomain: string;
    kind: string;
    grantedScopes: string[];
    metadata: Record<string, unknown>;
  },
  subjectId: string,
) {
  const parsed = GoogleDriveConnectionMetadata.safeParse(connection.metadata);
  if (
    connection.subjectId !== subjectId ||
    connection.providerDomain !== GOOGLE_DRIVE_PROVIDER_DOMAIN ||
    connection.kind !== "oauth2" ||
    !parsed.success
  ) {
    throw new HTTPException(422, { message: "connection is not this user's Google Drive" });
  }
  if (!connection.grantedScopes.includes(GOOGLE_DRIVE_METADATA_READONLY_SCOPE)) {
    throw new HTTPException(401, {
      message: "Google Drive needs to be reconnected with metadata access",
    });
  }
  return parsed.data;
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
  const resolver = buildConnectionTokenResolver(deps.db, deps.settings);
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
    response = await providerFetch(fetchImpl, input.url, {
      headers: { ...credential.headers, accept: "application/json" },
    });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new HTTPException(response.status === 403 ? 403 : 502, {
      message:
        response.status === 403
          ? "Google Drive denied metadata access; reconnect and approve the requested scope"
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
  if (value === "root" || /^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    return value;
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
