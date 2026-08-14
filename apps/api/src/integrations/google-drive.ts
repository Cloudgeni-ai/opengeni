import { createHash, randomBytes } from "node:crypto";
import {
  configuredGoogleDriveSyncLimits,
  googleDriveOAuthCallbackUrl,
  type Settings,
} from "@opengeni/config";
import type { AccessGrant, ScheduledTask, ScheduledTaskScheduleSpec } from "@opengeni/contracts";
import {
  bindConnectorDocumentDestination,
  type ConnectorDocumentDestination,
  type ConnectorDocumentDestinationSelection,
} from "@opengeni/contracts/connector-destinations";
import {
  GOOGLE_DRIVE_CREDENTIAL_LABEL,
  GOOGLE_DRIVE_CREDENTIAL_ROLE,
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_PUBLICATION_CREATE_ACTION,
  GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
  GOOGLE_DRIVE_PUBLICATION_TOOL_NAME,
  GOOGLE_DRIVE_PROVIDER_DOMAIN,
  GOOGLE_DRIVE_READONLY_SCOPE,
  GoogleDriveKnowledgeSourceConfig,
  GoogleDriveBrowseItem,
  GoogleDriveBrowseResponse,
  GoogleDriveConnectionLifecycle,
  GoogleDriveConnectionMetadata,
  GoogleDriveOAuthStartResponse,
  GoogleDriveOutputDestination,
  SaveGoogleDriveIntegrationSourceRequest,
  SaveGoogleDriveSourceRequest,
  googleDriveOAuthScopeDecision,
  googleDriveScopesAllowCapability,
  type GoogleDriveDisconnectRequest,
  type GoogleDriveLifecycleActionRequest,
  type GoogleDriveOAuthStartRequest,
} from "@opengeni/contracts/google-drive";
import {
  API_INTEGRATION_OAUTH_CREDENTIAL_ROLE,
  ApiIntegrationOAuthConnectionMetadata,
  IntegrationFacetMutationResult,
} from "@opengeni/contracts";
import {
  GOOGLE_DRIVE_INTEGRATION_DEFINITION,
  integrationDefinitionProviderDomain,
} from "@opengeni/capabilities";
import {
  captureScheduledTaskRestoreState,
  createValidatedScheduledTask,
  hasPermission,
  manualScheduledTaskTriggerWorkflowId,
  requireEnvironmentEncryption,
  syncCreatedScheduledTask,
  syncUpdatedScheduledTask,
} from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  buildConnectionTokenResolver,
  configureIntegrationFacet,
  integrationFacetConfigureRequestDigest,
  appendKnowledgeSourceAclVersion,
  deauthorizeKnowledgeSourceRetrieval,
  ConnectionDisconnectGenerationError,
  ConnectionDisconnectIdempotencyError,
  consumeIntegrationOAuthStateNonce,
  createConnection,
  decryptEnvironmentValue,
  disconnectConnectionIdempotently,
  encryptEnvironmentValue,
  ensureConnectorActionPolicyDefault,
  getConnectionMetadata,
  getKnowledgeSourceByExternalIdentityForSyncAuthority,
  getKnowledgeSourceForSyncAuthority,
  getWorkspaceGrant,
  listKnowledgeSourceSyncTasksForConnection,
  loadConnectionCredentialForBroker,
  listIntegrationInstanceFacets,
  replayCompletedIntegrationFacetOperation,
  transitionConnectionState,
  updateConnection,
  updateScheduledTask,
  upsertKnowledgeProvider,
  upsertKnowledgeSource,
  recordKnowledgeLifecycleEvent,
  type PermanentConnectionRefreshFailure,
} from "@opengeni/db";
import { googleDriveKnowledgeSourceIdentity } from "@opengeni/documents/google-drive";
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
  capability: "source_read" | "publish";
  connectionId?: string;
  connectionVersion?: number;
  nonce: string;
  iat: number;
};

export async function wakeGoogleDriveSourcesFromWorkspaceEvent(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    connectionId: string;
    connectionOwnerSubjectId: string;
    eventId: string;
    driveId: string | null;
  },
): Promise<{ enabled: boolean; triggered: number }> {
  if (deps.settings.googleDriveWorkspaceEventsEnabled !== true) {
    return { enabled: false, triggered: 0 };
  }
  const eventId = input.eventId.trim();
  if (eventId.length < 1 || eventId.length > 1024) {
    throw new Error("google_drive_workspace_event_id_invalid");
  }
  const connection = await getConnectionMetadata(
    deps.db,
    input.workspaceId,
    input.connectionId,
    input.connectionOwnerSubjectId,
  );
  if (!connection || connection.accountId !== input.accountId) {
    throw new Error("google_drive_workspace_event_connection_not_found");
  }
  const metadata = requireGoogleDriveConnection(connection, input.connectionOwnerSubjectId);
  if (effectiveGoogleDriveLifecycle(connection, metadata).state !== "active") {
    return { enabled: true, triggered: 0 };
  }
  const selectedSources =
    metadata.selectedSources ?? (metadata.selectedSource ? [metadata.selectedSource] : []);
  const selectedById = new Map(selectedSources.map((source) => [source.id, source]));
  const tasks = await listKnowledgeSourceSyncTasksForConnection(
    deps.db,
    input.workspaceId,
    input.connectionId,
  );
  let triggered = 0;
  for (const task of tasks) {
    if (task.action.kind !== "knowledge_source_sync" || task.status !== "active") continue;
    const externalSourceId =
      typeof task.metadata.externalSourceId === "string" ? task.metadata.externalSourceId : null;
    const selectedSource = externalSourceId ? selectedById.get(externalSourceId) : null;
    if (
      !selectedSource ||
      !selectedSource.syncEnabled ||
      selectedSource.driveId !== input.driveId
    ) {
      continue;
    }
    const token = createHash("sha256")
      .update(`google-drive-workspace-event:${task.id}:${eventId}`)
      .digest("hex")
      .slice(0, 48);
    await deps.workflowClient.triggerScheduledTask({
      task,
      agentRunUsageIdempotencyKey: `knowledge-source-sync:provider-event:${task.id}:${token}`,
      triggerWorkflowId: manualScheduledTaskTriggerWorkflowId(task.id, `provider-event-${token}`),
      initiator: { kind: "service", subjectId: "google-drive-workspace-events" },
      triggerType: "provider_event",
    });
    triggered += 1;
  }
  return { enabled: true, triggered };
}

type GoogleTokenResponse = {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt: Date | null;
  scopes: string[];
};

type GoogleDriveConnectionRecord = NonNullable<Awaited<ReturnType<typeof getConnectionMetadata>>>;

type GoogleDriveApiConnection =
  | {
      kind: "legacy";
      connection: GoogleDriveConnectionRecord;
      metadata: GoogleDriveConnectionMetadata;
    }
  | {
      kind: "integration";
      connection: GoogleDriveConnectionRecord;
      metadata: ApiIntegrationOAuthConnectionMetadata;
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
  if (input.payload.capability === "publish" && !existing) {
    throw new HTTPException(409, {
      message: "Connect Google Drive for source access before enabling publishing",
    });
  }
  if (existing) {
    requireGoogleDriveConnection(existing, input.subjectId);
  }

  const key = requireEnvironmentEncryption(deps.settings);
  const verifier = randomBytes(48).toString("base64url");
  const redirectUri = requireGoogleDriveOAuthCallbackUrl(deps.settings);
  const state = createSignedState(requireIntegrationsStateSecret(deps.settings), {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    returnPath: GOOGLE_DRIVE_RETURN_PATH(input.workspaceId),
    encryptedPkceVerifier: encryptEnvironmentValue(key, verifier),
    capability: input.payload.capability,
    ...(existing ? { connectionId: existing.id, connectionVersion: existing.version } : {}),
  });
  const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_URL);
  authorizationUrl.searchParams.set("client_id", google.clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set(
    "scope",
    input.payload.capability === "publish" ? GOOGLE_DRIVE_FILE_SCOPE : GOOGLE_DRIVE_READONLY_SCOPE,
  );
  authorizationUrl.searchParams.set("access_type", "offline");
  authorizationUrl.searchParams.set("include_granted_scopes", "true");
  authorizationUrl.searchParams.set(
    "prompt",
    input.payload.capability === "publish" ? "consent" : "consent select_account",
  );
  if (input.payload.capability === "publish") {
    authorizationUrl.searchParams.set("trigger_onepick", "true");
    authorizationUrl.searchParams.set("allow_folder_selection", "true");
    authorizationUrl.searchParams.set("allow_multiple", "false");
    authorizationUrl.searchParams.set("mimetypes", GOOGLE_DRIVE_FOLDER_MIME_TYPE);
  }
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
    pickedFileIds?: string | undefined;
    requestUrl: string;
  },
): Promise<{ redirectTo: string }> {
  const redirectUri = requireGoogleDriveOAuthCallbackUrl(deps.settings);
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
    const grantedScopes = [...new Set(token.scopes)].sort();
    const scopeDecision = googleDriveOAuthScopeDecision(grantedScopes);
    const requiredCapability =
      state.capability === "publish" ? "publish_file" : "recursive_source_sync";
    if (
      !scopeDecision.accessMode ||
      !scopeDecision.capabilities.includes(requiredCapability) ||
      (state.capability === "publish" &&
        !scopeDecision.capabilities.includes("recursive_source_sync"))
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
    const outputDestination =
      state.capability === "publish"
        ? await verifyPickedGoogleDriveOutputDestination(
            token.accessToken,
            input.pickedFileIds,
            fetchImpl,
          )
        : previousMetadata?.outputDestination;
    if (state.capability === "publish") {
      if (!existing) throw new GoogleDriveCallbackError("connection_conflict");
      await ensureConnectorActionPolicyDefault(deps.db, {
        accountId: state.accountId,
        workspaceId: state.workspaceId,
        subjectId: state.subjectId,
        connectionId: existing.id,
        serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
        toolName: GOOGLE_DRIVE_PUBLICATION_TOOL_NAME,
        actionName: GOOGLE_DRIVE_PUBLICATION_CREATE_ACTION,
        policy: "ask",
      });
    }
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
        scope: grantedScopes.join(" "),
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
      ...(outputDestination ? { outputDestination } : {}),
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
          grantedScopes,
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
          grantedScopes,
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
    if (targetState === "paused") {
      await deauthorizeGoogleDriveConnectionSources(
        deps,
        existing,
        input.subjectId,
        "connection_paused",
        existing.version,
      );
    }
    await setGoogleDriveScheduleStatus(
      deps,
      input.workspaceId,
      input.connectionId,
      targetState === "active" ? "active" : "paused",
    );
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

  if (input.payload.action === "pause") {
    await deauthorizeGoogleDriveConnectionSources(
      deps,
      existing,
      input.subjectId,
      "connection_paused",
      existing.version + 1,
    );
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
        await setGoogleDriveScheduleStatus(
          deps,
          input.workspaceId,
          input.connectionId,
          targetState === "active" ? "active" : "paused",
        );
        return converged;
      }
    }
    throw new HTTPException(409, { message: "Google Drive connection changed; try again" });
  }
  await setGoogleDriveScheduleStatus(
    deps,
    input.workspaceId,
    input.connectionId,
    targetState === "active" ? "active" : "paused",
  );
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
    await deauthorizeGoogleDriveConnectionSources(
      deps,
      input.connection,
      input.subjectId,
      "connection_disconnected",
      input.connection.version + 1,
    );
    const disconnected = await disconnectConnectionIdempotently(deps.db, {
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
    await setGoogleDriveScheduleStatus(deps, input.workspaceId, input.connection.id, "paused");
    return disconnected;
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

async function setGoogleDriveScheduleStatus(
  deps: ApiRouteDeps,
  workspaceId: string,
  connectionId: string,
  status: "active" | "paused",
): Promise<void> {
  await forEachGoogleDriveConnectionTask(deps, workspaceId, connectionId, async (task) => {
    if (knowledgeSourceScheduleControl(task).connectionPaused === (status === "paused")) return;
    const previous = await captureScheduledTaskRestoreState(deps.db, task);
    const updated = await updateScheduledTask(deps.db, workspaceId, task.id, {
      metadata: {
        ...task.metadata,
        knowledgeSourceSync: {
          ...knowledgeSourceScheduleControl(task),
          connectionPaused: status === "paused",
        },
      },
    });
    await syncUpdatedScheduledTask({
      db: deps.db,
      workflowClient: deps.workflowClient,
      previous,
      task: updated,
    });
  });
}

async function deauthorizeGoogleDriveConnectionSources(
  deps: ApiRouteDeps,
  connection: GoogleDriveConnectionRecord,
  subjectId: string,
  reasonCode: string,
  authorityVersion: number,
): Promise<void> {
  await forEachGoogleDriveConnectionTask(
    deps,
    connection.workspaceId,
    connection.id,
    async (task) => {
      if (task.action.initiatingSubjectId !== subjectId) return;
      const resolved = await getKnowledgeSourceForSyncAuthority(deps.db, {
        accountId: task.accountId,
        workspaceId: task.workspaceId,
        sourceId: task.action.sourceId,
        initiatingSubjectId: subjectId,
      });
      if (!resolved || resolved.source.lifecycleState !== "active") return;
      await deauthorizeKnowledgeSourceRetrieval(deps.db, {
        accountId: task.accountId,
        workspaceId: task.workspaceId,
        sourceId: task.action.sourceId,
        audience: task.action.destination,
        operationId: `google-drive-deauthorize:${connection.id}:${authorityVersion}:${task.action.sourceId}:${reasonCode}`,
        reasonCode,
        actor: {
          kind: "human",
          subjectId,
          initiatingHumanSubjectId: subjectId,
        },
      });
    },
  );
}

async function forEachGoogleDriveConnectionTask(
  deps: ApiRouteDeps,
  workspaceId: string,
  connectionId: string,
  fn: (task: ScheduledTask & { action: { kind: "knowledge_source_sync" } }) => Promise<void>,
): Promise<void> {
  const tasks = await listKnowledgeSourceSyncTasksForConnection(deps.db, workspaceId, connectionId);
  for (const task of tasks) {
    await fn(task);
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
  await requireGoogleDriveApiConnection(deps, connection, input.subjectId);
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

export async function browseGoogleDriveFacetSource(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    subjectId: string;
    capabilityId: string;
    instanceKey: string;
    facetKey: string;
    parentId: string;
    pageToken?: string | undefined;
  },
) {
  const context = await requireGoogleDriveIntegrationFacet(deps, input);
  return await browseGoogleDrive(deps, {
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    connectionId: context.connection.id,
    parentId: input.parentId,
    ...(input.pageToken ? { pageToken: input.pageToken } : {}),
  });
}

export async function saveGoogleDriveFacetSource(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    capabilityId: string;
    instanceKey: string;
    facetKey: string;
    payload: unknown;
    canManageOrganizationDestination: boolean;
    canManageWorkspaceDestination: boolean;
    canManagePersonalDestination: boolean;
  },
): Promise<IntegrationFacetMutationResult> {
  const parsedPayload = SaveGoogleDriveIntegrationSourceRequest.safeParse(input.payload);
  if (!parsedPayload.success) {
    throw new HTTPException(400, { message: "invalid Google Drive source selection" });
  }
  const payload = parsedPayload.data;
  const requestedDestination = bindGoogleDriveDocumentDestination(input, payload);
  const requestedSources = payload.sources.map((source) => ({
    ...source,
    id: validDriveId(source.id, "source.id"),
  }));
  const requestedConfig = googleDriveFacetConfig(requestedSources, requestedDestination, payload);
  const replayed = await replayCompletedIntegrationFacetOperation<IntegrationFacetMutationResult>(
    deps.db,
    {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      capabilityId: input.capabilityId,
      instanceKey: input.instanceKey,
      facetKey: input.facetKey,
      idempotencyKey: payload.idempotencyKey,
      kind: "configure",
      expectedRequestDigest: (result) => {
        const displayName = integrationFacetReceiptDisplayName(result);
        if (displayName === null) return "invalid-integration-facet-receipt";
        return integrationFacetConfigureRequestDigest({
          capabilityId: input.capabilityId,
          instanceKey: input.instanceKey,
          facetKey: input.facetKey,
          displayName,
          config: requestedConfig,
          ...(payload.expectedVersion !== undefined
            ? { expectedVersion: payload.expectedVersion }
            : {}),
        });
      },
    },
  );
  if (replayed) return IntegrationFacetMutationResult.parse(replayed);
  const context = await requireGoogleDriveIntegrationFacet(deps, input);
  googleDriveDocumentDestination(input, payload);
  await verifyGoogleDriveSources(deps, {
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    connectionId: context.connection.id,
    sources: requestedSources,
  });
  return IntegrationFacetMutationResult.parse(
    await configureIntegrationFacet(deps.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      capabilityId: input.capabilityId,
      instanceKey: input.instanceKey,
      facetKey: input.facetKey,
      displayName:
        context.facet.binding?.displayName ?? `${input.instanceKey} — Google Drive content`,
      config: requestedConfig,
      ...(payload.expectedVersion !== undefined
        ? { expectedVersion: payload.expectedVersion }
        : {}),
      idempotencyKey: payload.idempotencyKey,
    }),
  );
}

function integrationFacetReceiptDisplayName(result: Record<string, unknown>): string | null {
  const binding = result.binding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return null;
  const bindingRecord = binding as Record<string, unknown>;
  return typeof bindingRecord.displayName === "string" ? bindingRecord.displayName : null;
}

export async function saveGoogleDriveSource(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    connectionId: string;
    grant: AccessGrant;
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
  const documentDestination = googleDriveDocumentDestination(input, payload);
  const verifiedSources = await verifyGoogleDriveSources(deps, {
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    connectionId: input.connectionId,
    sources: payload.sources,
  });
  const latest =
    (await getConnectionMetadata(
      deps.db,
      input.workspaceId,
      input.connectionId,
      input.subjectId,
    )) ?? existing;
  const latestMetadata = await requireGoogleDriveSourceConnection(deps, latest, input.subjectId);
  const previousSources =
    latestMetadata.selectedSources ??
    (latestMetadata.selectedSource ? [latestMetadata.selectedSource] : []);
  const updated = await transitionConnectionState(deps.db, {
    workspaceId: input.workspaceId,
    connectionId: latest.id,
    visibleToSubjectId: input.subjectId,
    expectedVersion: latest.version,
    metadata: GoogleDriveConnectionMetadata.parse({
      ...latestMetadata,
      documentDestination,
      selectedSource: null,
      selectedSources: verifiedSources.map((verified) => {
        const previous = previousSources.find((source) => source.id === verified.id);
        return {
          id: verified.id,
          name: verified.name,
          mimeType: verified.mimeType,
          driveId: verified.driveId,
          destination: documentDestination,
          syncCadence: payload.syncCadence,
          syncEnabled: payload.syncEnabled,
          configGeneration: (previous?.configGeneration ?? 0) + 1,
          readPolicy: payload.readPolicy,
          selectedAt: new Date().toISOString(),
        };
      }),
    }),
    updatedBySubjectId: input.subjectId,
  });
  if (!updated) {
    throw new HTTPException(409, { message: "Google Drive connection changed; try again" });
  }
  await materializeGoogleDriveKnowledgeSchedules(deps, {
    ...input,
    connection: updated,
    metadata: GoogleDriveConnectionMetadata.parse(updated.metadata),
    previouslySelectedSourceIds: new Set(
      (
        latestMetadata.selectedSources ??
        (latestMetadata.selectedSource ? [latestMetadata.selectedSource] : [])
      ).map((source) => source.id),
    ),
    previouslyEnabledSourceIds: new Set(
      (
        latestMetadata.selectedSources ??
        (latestMetadata.selectedSource ? [latestMetadata.selectedSource] : [])
      )
        .filter((source) => source.syncEnabled)
        .map((source) => source.id),
    ),
  });
  return updated;
}

async function verifyPickedGoogleDriveOutputDestination(
  accessToken: string,
  rawPickedFileIds: string | undefined,
  fetchImpl: FetchLike,
) {
  const pickedFileIds = uniqueStrings((rawPickedFileIds ?? "").split(","));
  if (pickedFileIds.length !== 1) {
    throw new GoogleDriveCallbackError("output_folder_required");
  }
  const folderId = validDriveId(pickedFileIds[0]!, "picked_file_ids");
  const url = new URL(`${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(folderId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "id,name,mimeType,driveId,trashed,capabilities(canAddChildren)");
  const response = await providerFetch(fetchImpl, url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GoogleDriveCallbackError("output_folder_unavailable");
  }
  const record = objectRecord(
    await readResponseJsonBounded<unknown>(
      response,
      GOOGLE_RESPONSE_MAX_BYTES,
      "Google Drive picked output folder",
    ),
  );
  const driveId = optionalString(record.driveId);
  const capabilities = objectRecord(record.capabilities);
  if (
    requiredString(record.id, "Google Drive folder id") !== folderId ||
    requiredString(record.mimeType, "Google Drive folder MIME type") !==
      GOOGLE_DRIVE_FOLDER_MIME_TYPE ||
    record.trashed === true ||
    capabilities.canAddChildren !== true
  ) {
    throw new GoogleDriveCallbackError("output_folder_unavailable");
  }
  return GoogleDriveOutputDestination.parse({
    folderId,
    folderName: requiredString(record.name, "Google Drive folder name"),
    driveId: driveId ?? null,
    location: driveId ? "shared_drive" : "my_drive",
    selectedAt: new Date().toISOString(),
  });
}

async function requireGoogleDriveIntegrationFacet(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    subjectId: string;
    capabilityId: string;
    instanceKey: string;
    facetKey: string;
  },
) {
  const instance = await listIntegrationInstanceFacets(
    deps.db,
    input.workspaceId,
    input.subjectId,
    input.capabilityId,
    input.instanceKey,
  );
  const facet = instance.facets.find(
    (candidate) => candidate.definition.facetKey === input.facetKey,
  );
  if (
    !facet ||
    facet.definition.kind !== "knowledge_source" ||
    facet.definition.capabilities.provider !== "google-drive"
  ) {
    throw new HTTPException(404, { message: "Google Drive knowledge source not found" });
  }
  if (!instance.connectionId) {
    throw new HTTPException(422, { message: "Google Drive Integration has no Connection" });
  }
  const connection = await getConnectionMetadata(
    deps.db,
    input.workspaceId,
    instance.connectionId,
    input.subjectId,
  );
  if (!connection) {
    throw new HTTPException(404, { message: "Google Drive Connection not found" });
  }
  await requireGoogleDriveApiConnection(deps, connection, input.subjectId);
  return { instance, facet, connection };
}

function googleDriveDocumentDestination(
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    canManageOrganizationDestination: boolean;
    canManageWorkspaceDestination: boolean;
    canManagePersonalDestination: boolean;
  },
  payload: {
    destination?: ConnectorDocumentDestinationSelection | undefined;
    targetScope?: "user" | "workspace" | "organization" | undefined;
  },
) {
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
  if (destinationSelection.authorityKind === "workspace" && !input.canManageWorkspaceDestination) {
    throw new HTTPException(403, { message: "missing permission: workspace:admin" });
  }
  if (destinationSelection.authorityKind === "personal" && !input.canManagePersonalDestination) {
    throw new HTTPException(403, { message: "personal destination requires the exact actor" });
  }
  return bindGoogleDriveDocumentDestination(input, payload);
}

function bindGoogleDriveDocumentDestination(
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
  },
  payload: {
    destination?: ConnectorDocumentDestinationSelection | undefined;
    targetScope?: "user" | "workspace" | "organization" | undefined;
  },
): ConnectorDocumentDestination {
  const destinationSelection: ConnectorDocumentDestinationSelection = payload.destination ?? {
    authorityKind: "workspace",
    collectionId: null,
  };
  return bindConnectorDocumentDestination(destinationSelection, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initiatingSubjectId: input.subjectId,
  });
}

function googleDriveFacetConfig(
  sources: ReadonlyArray<{
    id: string;
    name: string;
    mimeType: string;
    driveId: string | null;
  }>,
  documentDestination: ConnectorDocumentDestination,
  payload: {
    syncCadence: "manual" | "hourly" | "daily";
    readPolicy: "allow" | "ask" | "block";
  },
) {
  return GoogleDriveKnowledgeSourceConfig.parse({
    sources: sources.map((source) => ({
      id: source.id,
      name: source.name,
      mimeType: source.mimeType,
      ...(source.driveId ? { driveId: source.driveId } : {}),
      sourceKind:
        source.id === "root"
          ? "my_drive"
          : source.driveId === source.id
            ? "shared_drive"
            : "folder",
      includeDescendants: true,
    })),
    destination: {
      authorityKind: documentDestination.authorityKind,
      authorityAccountId: documentDestination.authorityAccountId,
      ...(documentDestination.authorityWorkspaceId
        ? { authorityWorkspaceId: documentDestination.authorityWorkspaceId }
        : {}),
      ...(documentDestination.authoritySubjectId
        ? { authoritySubjectId: documentDestination.authoritySubjectId }
        : {}),
      ...(documentDestination.collectionId
        ? { collectionId: documentDestination.collectionId }
        : {}),
    },
    syncCadence: payload.syncCadence,
    readPolicy: payload.readPolicy,
  });
}

async function verifyGoogleDriveSources(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    subjectId: string;
    connectionId: string;
    sources: Array<{ id: string; name: string; mimeType: string; driveId: string | null }>;
  },
): Promise<GoogleDriveBrowseItem[]> {
  const verifiedSources: GoogleDriveBrowseItem[] = [];
  for (const source of input.sources) {
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
  return verifiedSources;
}
async function materializeGoogleDriveKnowledgeSchedules(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    connectionId: string;
    grant: AccessGrant;
    connection: GoogleDriveConnectionRecord;
    metadata: ReturnType<typeof GoogleDriveConnectionMetadata.parse>;
    previouslySelectedSourceIds: Set<string>;
    previouslyEnabledSourceIds: Set<string>;
  },
): Promise<void> {
  const selectedSources = input.metadata.selectedSources ?? [];
  const enabledSources = selectedSources.filter((source) => source.syncEnabled);
  const enabledIds = new Set(enabledSources.map((source) => source.id));
  const connectionTasks = await listKnowledgeSourceSyncTasksForConnection(
    deps.db,
    input.workspaceId,
    input.connectionId,
  );
  const actor = {
    kind: "human" as const,
    subjectId: input.subjectId,
    initiatingHumanSubjectId: input.subjectId,
  };

  for (const selectedSource of enabledSources) {
    const explicitlyEnabled = !input.previouslyEnabledSourceIds.has(selectedSource.id);
    const identity = googleDriveKnowledgeSourceIdentity({
      googlePermissionId: input.metadata.googlePermissionId,
      googleEmail: input.metadata.googleEmail,
      source: selectedSource,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      connectionSubjectId: input.subjectId,
    });
    let source = null as Awaited<ReturnType<typeof upsertKnowledgeSource>> | null;
    let existingTask = null as (typeof connectionTasks)[number] | null;
    for (const task of connectionTasks) {
      if (task.action.kind !== "knowledge_source_sync") continue;
      const resolved = await getKnowledgeSourceForSyncAuthority(deps.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sourceId: task.action.sourceId,
        initiatingSubjectId: input.subjectId,
      });
      if (resolved?.source.externalSourceId !== identity.externalSourceId) continue;
      source = resolved.source;
      existingTask = task;
      break;
    }
    if (!source) {
      const provider = await upsertKnowledgeProvider(deps.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        scope: identity.scope,
        providerKey: identity.providerKey,
        externalTenantId: identity.externalTenantId,
        operationId: `google-drive-provider:${input.connectionId}`,
        actor,
      });
      source =
        (await getKnowledgeSourceByExternalIdentityForSyncAuthority(deps.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          providerId: provider.id,
          externalSourceId: identity.externalSourceId,
          initiatingSubjectId: input.subjectId,
        })) ??
        (await upsertKnowledgeSource(deps.db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          scope: identity.scope,
          providerId: provider.id,
          externalSourceId: identity.externalSourceId,
          sourceKind: identity.sourceKind,
          sourceUri: identity.sourceUri,
          operationId: `google-drive-source:${input.connectionId}:${identity.externalSourceId}`,
          actor,
        }));
    }
    if (source.lifecycleState !== "active") {
      if (!explicitlyEnabled) continue;
      const restored = await recordKnowledgeLifecycleEvent(deps.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        targetKind: "source",
        targetId: source.id,
        eventType: "restored",
        expectedGeneration: source.lifecycleGeneration,
        operationId: `google-drive-source-restore:${source.id}:${input.connection.version}`,
        reasonCode: "source_explicitly_reenabled",
        actor,
      });
      source = {
        ...source,
        lifecycleState: "active",
        lifecycleGeneration: restored.lifecycleGeneration,
      };
    }
    if (!source.currentAclGeneration) {
      await appendKnowledgeSourceAclVersion(deps.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sourceId: source.id,
        audience: identity.scope,
        expectedSourceLifecycleGeneration: source.lifecycleGeneration,
        expectedAclGeneration: 0,
        aclVersion: `google-drive-destination:${input.connection.version}`,
        agentAccess: false,
        operationId: `google-drive-source-acl:${source.id}`,
        reasonCode: "source_selected",
        actor,
      });
    }
    const action = {
      kind: "knowledge_source_sync" as const,
      sourceId: source.id,
      sourceGeneration: source.syncGeneration,
      sourceLifecycleGeneration: source.lifecycleGeneration,
      sourceConfigGeneration: selectedSource.configGeneration,
      controlWorkspaceId: input.workspaceId,
      providerCoordinationKey: `${identity.providerKey}:${identity.externalTenantId}:${selectedSource.driveId ?? "my-drive"}`,
      destination: identity.scope,
      initiatingSubjectId: input.subjectId,
      allDescendants: true,
      connection: {
        connectionId: input.connectionId,
        ownerSubjectId: input.subjectId,
        connectionVersion: input.connection.version,
        providerDomain: input.connection.providerDomain,
        kind: input.connection.kind,
      },
      limits: {
        ...configuredGoogleDriveSyncLimits(deps.settings),
        maxConcurrency: 4,
      },
    };
    const schedule = googleDriveSchedule(selectedSource.syncCadence);
    let task;
    if (existingTask) {
      const previous = await captureScheduledTaskRestoreState(deps.db, existingTask);
      task = await updateScheduledTask(deps.db, input.workspaceId, existingTask.id, {
        name: `Sync Google Drive: ${selectedSource.name}`,
        overlapPolicy: "buffer_one",
        action,
        metadata: {
          ...existingTask.metadata,
          connectorKind: "google_drive",
          connectionId: input.connectionId,
          externalSourceId: selectedSource.id,
          knowledgeSourceSync: {
            ...knowledgeSourceScheduleControl(existingTask),
            sourceEnabled: true,
            connectionPaused: false,
          },
        },
      });
      await syncUpdatedScheduledTask({
        db: deps.db,
        workflowClient: deps.workflowClient,
        previous,
        task,
      });
    } else {
      task = await createValidatedScheduledTask({
        settings: deps.settings,
        db: deps.db,
        objectStorage: deps.objectStorage,
        grant: input.grant,
        authorizationSurface: "http",
        sessionAuthorization: deps.sessionAuthorization,
        payload: {
          name: `Sync Google Drive: ${selectedSource.name}`,
          status: "active",
          schedule,
          overlapPolicy: "buffer_one",
          action,
          runMode: "new_session_per_run",
          targetSessionId: null,
          agentConfig: {
            prompt: "Knowledge source synchronization",
            resources: [],
            tools: [],
            metadata: {},
          },
          variableSetId: null,
          environmentId: null,
          rigId: null,
          metadata: {
            connectorKind: "google_drive",
            connectionId: input.connectionId,
            externalSourceId: selectedSource.id,
            knowledgeSourceSync: { sourceEnabled: true, connectionPaused: false },
          },
        },
      });
      await syncCreatedScheduledTask({ db: deps.db, workflowClient: deps.workflowClient, task });
    }
    const triggerToken = `source-save-${input.connection.version}`;
    await deps.workflowClient.triggerScheduledTask({
      task,
      agentRunUsageIdempotencyKey: `knowledge-source-sync:initial:${task.id}:${triggerToken}`,
      triggerWorkflowId: manualScheduledTaskTriggerWorkflowId(task.id, triggerToken),
      initiator: { kind: "subject", subjectId: input.subjectId },
      triggerType: existingTask ? "repair" : "initial",
    });
  }

  for (const task of connectionTasks) {
    if (task.action.kind !== "knowledge_source_sync") continue;
    const resolved = await getKnowledgeSourceForSyncAuthority(deps.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sourceId: task.action.sourceId,
      initiatingSubjectId: input.subjectId,
    });
    if (!resolved || enabledIds.has(resolved.source.externalSourceId)) continue;
    if (
      input.previouslySelectedSourceIds.has(resolved.source.externalSourceId) &&
      resolved.source.lifecycleState === "active"
    ) {
      await recordKnowledgeLifecycleEvent(deps.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        targetKind: "source",
        targetId: resolved.source.id,
        eventType: "deleted",
        expectedGeneration: resolved.source.lifecycleGeneration,
        operationId: `google-drive-source-deselect:${resolved.source.id}:${input.connection.version}`,
        reasonCode: "source_deselected",
        actor,
      });
    }
    const previous = await captureScheduledTaskRestoreState(deps.db, task);
    const disabled = await updateScheduledTask(deps.db, input.workspaceId, task.id, {
      metadata: {
        ...task.metadata,
        knowledgeSourceSync: {
          ...knowledgeSourceScheduleControl(task),
          sourceEnabled: false,
        },
      },
    });
    await syncUpdatedScheduledTask({
      db: deps.db,
      workflowClient: deps.workflowClient,
      previous,
      task: disabled,
    });
  }
}

export async function revokeKnowledgeSourceScheduleAuthorization(
  deps: ApiRouteDeps,
  input: { task: ScheduledTask; subjectId: string },
): Promise<void> {
  const { task } = input;
  if (task.action.kind !== "knowledge_source_sync") return;
  if (
    task.action.initiatingSubjectId !== input.subjectId ||
    task.action.connection.ownerSubjectId !== input.subjectId
  ) {
    throw new HTTPException(403, {
      message: "knowledge source schedule requires the exact initiating subject",
    });
  }
  if (task.metadata.connectorKind !== "google_drive") {
    throw new HTTPException(409, {
      message: "knowledge source schedule connector cannot be durably disabled",
    });
  }
  const externalSourceId =
    typeof task.metadata.externalSourceId === "string" ? task.metadata.externalSourceId.trim() : "";
  if (!externalSourceId) {
    throw new HTTPException(409, { message: "knowledge source schedule identity is incomplete" });
  }
  const connection = await getConnectionMetadata(
    deps.db,
    task.workspaceId,
    task.action.connection.connectionId,
    input.subjectId,
  );
  if (!connection) {
    throw new HTTPException(409, {
      message: "knowledge source connection is unavailable for durable disable",
    });
  }
  const metadata = requireGoogleDriveConnection(connection, input.subjectId);
  const sources =
    metadata.selectedSources ?? (metadata.selectedSource ? [metadata.selectedSource] : []);
  const selected = sources.find((source) => source.id === externalSourceId);
  let revocationVersion = connection.version;
  if (selected?.syncEnabled) {
    const updated = await transitionConnectionState(deps.db, {
      workspaceId: task.workspaceId,
      connectionId: connection.id,
      visibleToSubjectId: input.subjectId,
      expectedVersion: connection.version,
      metadata: GoogleDriveConnectionMetadata.parse({
        ...metadata,
        selectedSource: null,
        selectedSources: sources.map((source) =>
          source.id === externalSourceId
            ? {
                ...source,
                syncEnabled: false,
                configGeneration: source.configGeneration + 1,
              }
            : source,
        ),
      }),
      updatedBySubjectId: input.subjectId,
    });
    if (!updated) {
      throw new HTTPException(409, {
        message: "knowledge source connection changed; retry schedule deletion",
      });
    }
    revocationVersion = updated.version;
  }
  const resolved = await getKnowledgeSourceForSyncAuthority(deps.db, {
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    sourceId: task.action.sourceId,
    initiatingSubjectId: input.subjectId,
  });
  if (resolved?.source.lifecycleState === "active") {
    await recordKnowledgeLifecycleEvent(deps.db, {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      targetKind: "source",
      targetId: resolved.source.id,
      eventType: "deleted",
      expectedGeneration: resolved.source.lifecycleGeneration,
      operationId: `knowledge-schedule-delete:${task.id}:${revocationVersion}`,
      reasonCode: "schedule_deleted",
      actor: {
        kind: "human",
        subjectId: input.subjectId,
        initiatingHumanSubjectId: input.subjectId,
      },
    });
  }
}

function knowledgeSourceScheduleControl(task: ScheduledTask): {
  sourceEnabled: boolean;
  connectionPaused: boolean;
} {
  const value = task.metadata.knowledgeSourceSync;
  if (!value || typeof value !== "object") {
    return { sourceEnabled: true, connectionPaused: false };
  }
  const record = value as Record<string, unknown>;
  return {
    sourceEnabled: record.sourceEnabled !== false,
    connectionPaused: record.connectionPaused === true,
  };
}

function googleDriveSchedule(cadence: "manual" | "hourly" | "daily"): ScheduledTaskScheduleSpec {
  if (cadence === "manual") return { type: "manual" };
  if (cadence === "hourly") return { type: "interval", everySeconds: 3_600 };
  return { type: "calendar", timeZone: "UTC", hour: 0, minute: 0 };
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

function requireGoogleDriveOAuthCallbackUrl(settings: Settings): string {
  const callbackUrl = googleDriveOAuthCallbackUrl(settings.publicBaseUrl);
  if (!callbackUrl) {
    throw new HTTPException(503, {
      message: "Google Drive requires a canonical OPENGENI_PUBLIC_BASE_URL origin",
    });
  }
  return callbackUrl;
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

async function requireGoogleDriveApiConnection(
  deps: ApiRouteDeps,
  connection: GoogleDriveConnectionRecord,
  subjectId: string,
): Promise<GoogleDriveApiConnection> {
  const legacy = GoogleDriveConnectionMetadata.safeParse(connection.metadata);
  const integration = ApiIntegrationOAuthConnectionMetadata.safeParse(connection.metadata);
  const genericProviderDomain = integrationDefinitionProviderDomain(
    GOOGLE_DRIVE_INTEGRATION_DEFINITION,
  );
  const authority: GoogleDriveApiConnection | null =
    connection.kind === "oauth2" &&
    connection.subjectId === subjectId &&
    connection.providerDomain === GOOGLE_DRIVE_PROVIDER_DOMAIN &&
    legacy.success
      ? { kind: "legacy", connection, metadata: legacy.data }
      : connection.kind === "oauth2" &&
          (connection.subjectId === null || connection.subjectId === subjectId) &&
          connection.providerDomain === genericProviderDomain &&
          integration.success &&
          integration.data.credentialRole === API_INTEGRATION_OAUTH_CREDENTIAL_ROLE &&
          integration.data.providerFamily === "google" &&
          integration.data.authorizedDefinitionIds.includes(GOOGLE_DRIVE_INTEGRATION_DEFINITION.id)
        ? { kind: "integration", connection, metadata: integration.data }
        : null;
  if (!authority) {
    throw new HTTPException(422, { message: "Connection is not compatible with Google Drive" });
  }
  if (authority.kind === "legacy") {
    await requireGoogleDriveSourceConnection(deps, connection, subjectId);
    return authority;
  }
  if (connection.status === "revoked") {
    throw new HTTPException(409, { message: "Google Drive is disconnected" });
  }
  if (connection.status !== "active") {
    throw new HTTPException(401, { message: "Google Drive needs to be reconnected" });
  }
  if (!googleDriveScopesAllowCapability(connection.grantedScopes, "recursive_source_sync")) {
    await transitionConnectionState(deps.db, {
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      visibleToSubjectId: subjectId,
      expectedVersion: connection.version,
      status: "needs_reauth",
      metadata: connection.metadata,
      lastError: "google_drive_reconsent_required",
      updatedBySubjectId: subjectId,
    });
    throw new HTTPException(401, {
      message: "Google Drive needs permission re-consent for selected-source read access",
    });
  }
  return authority;
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
  const alreadyCurrent =
    connection.status === status &&
    metadata.lifecycle?.state === lifecycle.state &&
    metadata.lifecycle.recoverable === lifecycle.recoverable;
  if (lifecycle.state !== "active") {
    await deauthorizeGoogleDriveConnectionSources(
      deps,
      connection,
      subjectId,
      `connection_${lifecycle.state}`,
      connection.version + (alreadyCurrent ? 0 : 1),
    );
    await setGoogleDriveScheduleStatus(deps, connection.workspaceId, connection.id, "paused");
  }
  if (alreadyCurrent) {
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
  const accountId = requiredString(payload.accountId, "state.accountId");
  const workspaceId = requiredString(payload.workspaceId, "state.workspaceId");
  const subjectId = requiredString(payload.subjectId, "state.subjectId");
  const returnPath = requiredString(payload.returnPath, "state.returnPath");
  if (returnPath !== GOOGLE_DRIVE_RETURN_PATH(workspaceId)) {
    throw new HTTPException(400, { message: "invalid Google Drive OAuth return path" });
  }
  const connectionId = optionalString(payload.connectionId) ?? undefined;
  const connectionVersion = numberValue(payload.connectionVersion);
  const capabilityValue = optionalString(payload.capability);
  const capability = capabilityValue ?? "source_read";
  if (capability !== "source_read" && capability !== "publish") {
    throw new HTTPException(400, { message: "invalid Google Drive OAuth capability" });
  }
  if (
    (connectionVersion !== undefined && !Number.isInteger(connectionVersion)) ||
    Boolean(connectionId) !== Boolean(connectionVersion)
  ) {
    throw new HTTPException(400, { message: "invalid Google Drive reconnect state" });
  }
  return {
    accountId,
    workspaceId,
    subjectId,
    returnPath,
    encryptedPkceVerifier: requiredString(
      payload.encryptedPkceVerifier,
      "state.encryptedPkceVerifier",
    ),
    capability,
    ...(connectionId ? { connectionId, connectionVersion: connectionVersion! } : {}),
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
  const authority = await requireGoogleDriveApiConnection(deps, current, input.subjectId);
  const resolver = buildConnectionTokenResolver(deps.db, deps.settings, undefined, {
    ...(deps.googleDriveFetch ? { refreshTransport: { fetchImpl: deps.googleDriveFetch } } : {}),
    ...(authority.kind === "legacy"
      ? {
          transitionPermanentRefreshFailure: async (failure: PermanentConnectionRefreshFailure) =>
            await transitionGoogleDrivePermanentRefreshFailure(deps, failure),
        }
      : {}),
  });
  const resolve = async (forceRefresh: boolean) =>
    await resolver({
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      serverId: "google-drive-source-browser",
      toolName: input.label,
      connectionRef: {
        providerDomain: current.providerDomain,
        connectionId: input.connectionId,
        kind: "oauth2",
        subjectScope: current.subjectId ? "subject" : "workspace",
      },
      destinationUrl: input.url.toString(),
      forceRefresh,
    });
  const requireResolvedConnection = async (connectionVersion: number) => {
    const resolved = await getConnectionMetadata(
      deps.db,
      input.workspaceId,
      input.connectionId,
      input.subjectId,
    );
    if (!resolved || resolved.version !== connectionVersion) {
      throw new HTTPException(409, { message: "Google Drive connection changed; try again" });
    }
    await requireGoogleDriveApiConnection(deps, resolved, input.subjectId);
  };
  let credential = await resolve(false);
  if (credential.status !== "ok") {
    throw new HTTPException(401, { message: "Google Drive needs to be reconnected" });
  }
  let providerConnectionVersion = credential.connectionVersion;
  if (providerConnectionVersion === undefined) {
    throw new Error("Google Drive credential resolver omitted the connection version");
  }
  await requireResolvedConnection(providerConnectionVersion);
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
    await requireResolvedConnection(providerConnectionVersion);
    response = await providerFetch(fetchImpl, input.url, {
      headers: { ...credential.headers, accept: "application/json" },
    });
  }
  if (!response.ok) {
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      await transitionGoogleDriveApiFailure(deps, authority, {
        subjectId: input.subjectId,
        connectionVersion: providerConnectionVersion,
        lifecycle: googleDriveLifecycle("reconnect_required"),
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
      await transitionGoogleDriveApiFailure(deps, authority, {
        subjectId: input.subjectId,
        connectionVersion: providerConnectionVersion,
        lifecycle: googleDriveLifecycle("reconsent_required"),
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

async function transitionGoogleDriveApiFailure(
  deps: ApiRouteDeps,
  authority: GoogleDriveApiConnection,
  input: {
    subjectId: string;
    connectionVersion: number;
    lifecycle: GoogleDriveConnectionLifecycle;
    lastError: string;
  },
): Promise<void> {
  if (authority.kind === "legacy") {
    await transitionGoogleDriveProviderResponseFailure(deps, {
      workspaceId: authority.connection.workspaceId,
      subjectId: input.subjectId,
      connectionId: authority.connection.id,
      connectionVersion: input.connectionVersion,
      lifecycle: input.lifecycle,
      status: "needs_reauth",
      lastError: input.lastError,
    });
    return;
  }
  const latest = await getConnectionMetadata(
    deps.db,
    authority.connection.workspaceId,
    authority.connection.id,
    input.subjectId,
  );
  if (!latest || latest.version !== input.connectionVersion) return;
  await transitionConnectionState(deps.db, {
    workspaceId: latest.workspaceId,
    connectionId: latest.id,
    visibleToSubjectId: input.subjectId,
    expectedVersion: latest.version,
    status: "needs_reauth",
    metadata: latest.metadata,
    lastError: input.lastError,
    updatedBySubjectId: input.subjectId,
  });
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
