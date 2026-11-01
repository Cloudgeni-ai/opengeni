import {
  GOOGLE_DRIVE_NATIVE_RETIRED_MESSAGE,
  GOOGLE_DRIVE_NATIVE_RETIRED_REASON,
} from "@opengeni/contracts/google-drive-native-retirement";
import {
  withOrganizationIntegrationAcquisition,
  withOrganizationIntegrationPolicyFence,
} from "@opengeni/db/organization-integration-policy";
import { claimOAuthAcquisition, finishOAuthAcquisition } from "./oauth-client";
import {
  scheduledTaskKnowledgeSource,
  requireScheduledTaskKnowledgeSource,
  assertOrganizationIntegrationAllowed,
} from "@opengeni/contracts";
import { createHash, randomBytes } from "node:crypto";
import { ExternalActorContinuation } from "@opengeni/contracts/external-identities";
import { requireConnectOwnerAuthority } from "@opengeni/core";
import { googleDriveOAuthCallbackUrl, type Settings } from "@opengeni/config";
import type { ScheduledTask } from "@opengeni/contracts";
import {
  GOOGLE_DRIVE_CREDENTIAL_LABEL,
  GOOGLE_DRIVE_CREDENTIAL_ROLE,
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_PUBLICATION_CREATE_ACTION,
  GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
  GOOGLE_DRIVE_PUBLICATION_TOOL_NAME,
  GOOGLE_DRIVE_PROVIDER_DOMAIN,
  GOOGLE_DRIVE_READONLY_SCOPE,
  GoogleDriveConnectionLifecycle,
  GoogleDriveConnectionMetadata,
  GoogleDriveOAuthStartResponse,
  GoogleDriveOutputDestination,
  googleDriveOAuthScopeDecision,
  type GoogleDriveDisconnectRequest,
  type GoogleDriveLifecycleActionRequest,
  type GoogleDriveOAuthStartRequest,
} from "@opengeni/contracts/google-drive";
import {
  type ScheduledTaskRestoreState,
  requireEnvironmentEncryption,
  syncUpdatedScheduledTask,
} from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  deauthorizeKnowledgeSourceRetrieval,
  ConnectionDisconnectGenerationError,
  ConnectionDisconnectIdempotencyError,
  consumeIntegrationOAuthStateNonce,
  finishConnectOperation,
  getConnectAttempt,
  type Database,
  createConnection,
  decryptEnvironmentValue,
  disconnectConnectionIdempotently,
  encryptEnvironmentValue,
  ensureConnectorActionPolicyDefault,
  getConnectionMetadata,
  getKnowledgeSourceForSyncAuthority,
  listKnowledgeSourceSyncTasksForConnection,
  loadConnectionCredentialForBroker,
  transitionConnectionState,
  updateConnection,
  updateScheduledTask,
  withWorkspaceSubjectRls,
  recordKnowledgeLifecycleEvent,
  type DisconnectAuditActor,
} from "@opengeni/db";
import { createSignedState, readSignedState } from "@opengeni/github";
import { readResponseJsonBounded, type FetchLike } from "@opengeni/network";
import { HTTPException } from "hono/http-exception";
import {
  connectOwnerStateFields,
  personalOnlyConnectionPrincipalMessage,
  personalOwnerStateAccepted,
  personalOwnerVerifiedInState,
} from "../connection-ownership";
import {
  integrationBaseUrl,
  oauthStateFailureReturn,
  oauthStateTtlMs,
  requireIntegrationsStateSecret,
} from "./oauth-client";

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const GOOGLE_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const GOOGLE_REQUEST_TIMEOUT_MS = 10_000;
const GOOGLE_DRIVE_RETURN_PATH = (workspaceId: string) => `/workspaces/${workspaceId}/capabilities`;
/**
 * Flow discriminator for this connector's signed OAuth state.
 *
 * This state carries no `ownership` field and no provider identity - it is
 * personal-only by construction - so the `personalOwnerVerified` claim would
 * otherwise be its sole ownership gate. Its return path is also byte-identical
 * to the MCP OAuth start's, which signs that path from caller input, so a
 * caller's own MCP state could be presented here. Requiring an exact flow kind
 * binds a state to the flow that minted it.
 */
const GOOGLE_DRIVE_OAUTH_STATE_KIND = "google_drive_oauth";

type GoogleDriveOAuthState = {
  connectAttemptId?: string;
  externalContinuation?: ExternalActorContinuation;
  accountId: string;
  workspaceId: string;
  subjectId: string;
  /** Signed proof that a live managed human started this personal-only flow. */
  personalOwnerVerified: boolean;
  returnPath: string;
  encryptedPkceVerifier: string;
  capability: "source_read" | "publish";
  /** Server-verified Picker selection, carried only into the scope-upgrade step. */
  publishingFolderId?: string;
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
    connectAttemptId?: string;
    externalContinuation?: ExternalActorContinuation;
  },
): Promise<GoogleDriveOAuthStartResponse> {
  assertNativeGoogleDriveAvailable();
  await withOrganizationIntegrationAcquisition(deps.db, input, ["google-drive"], async () => {});
  requireGoogleDriveSettings(deps.settings);
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

  return googleDriveOAuthAuthorization(deps.settings, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    ...(input.connectAttemptId ? { connectAttemptId: input.connectAttemptId } : {}),
    ...(input.externalContinuation ? { externalContinuation: input.externalContinuation } : {}),
    // The route admits only a managed human, so reaching here is the proof; the
    // callback has no live principal and enforces exactly this claim.
    personalOwnerVerified: true,
    returnPath: GOOGLE_DRIVE_RETURN_PATH(input.workspaceId),
    capability: input.payload.capability,
    ...(existing ? { connectionId: existing.id, connectionVersion: existing.version } : {}),
  });
}

function googleDriveOAuthAuthorization(
  settings: Settings,
  authority: Omit<GoogleDriveOAuthState, "nonce" | "iat" | "encryptedPkceVerifier">,
): GoogleDriveOAuthStartResponse {
  const key = requireEnvironmentEncryption(settings);
  const verifier = randomBytes(48).toString("base64url");
  const {
    externalContinuation,
    accountId,
    workspaceId,
    subjectId,
    personalOwnerVerified,
    ...claims
  } = authority;
  const state = createSignedState(requireIntegrationsStateSecret(settings), {
    ...connectOwnerStateFields({ accountId, workspaceId, subjectId }, personalOwnerVerified),
    ...claims,
    kind: GOOGLE_DRIVE_OAUTH_STATE_KIND,
    ...(externalContinuation
      ? {
          encryptedExternalContinuation: encryptEnvironmentValue(
            key,
            JSON.stringify(ExternalActorContinuation.parse(externalContinuation)),
          ),
        }
      : {}),
    encryptedPkceVerifier: encryptEnvironmentValue(key, verifier),
  });
  const pickingFolder = authority.capability === "publish" && !authority.publishingFolderId;
  const authorizationUrl = new URL(GOOGLE_AUTHORIZATION_URL);
  authorizationUrl.searchParams.set("client_id", requireGoogleDriveSettings(settings).clientId);
  authorizationUrl.searchParams.set("redirect_uri", requireGoogleDriveOAuthCallbackUrl(settings));
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set(
    "scope",
    pickingFolder
      ? GOOGLE_DRIVE_FILE_SCOPE
      : authority.capability === "publish"
        ? `${GOOGLE_DRIVE_READONLY_SCOPE} ${GOOGLE_DRIVE_FILE_SCOPE}`
        : GOOGLE_DRIVE_READONLY_SCOPE,
  );
  authorizationUrl.searchParams.set("access_type", "offline");
  // Google's OAuth-integrated Picker permits drive.file alone. Incremental
  // authorization would import existing Drive/Gmail grants and reject it with
  // invalid_scope. Merge grants only in a separate ordinary OAuth request.
  authorizationUrl.searchParams.set("include_granted_scopes", pickingFolder ? "false" : "true");
  authorizationUrl.searchParams.set(
    "prompt",
    authority.capability === "publish" ? "consent" : "consent select_account",
  );
  if (pickingFolder) {
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
): Promise<{ redirectTo: string; exactReturn?: boolean }> {
  const redirectUri = requireGoogleDriveOAuthCallbackUrl(deps.settings);
  const baseUrl = integrationBaseUrl(deps.settings.publicBaseUrl, input.requestUrl);
  const returnBaseUrl = deps.settings.webBaseUrl?.replace(/\/+$/, "") ?? baseUrl;
  let state: GoogleDriveOAuthState | null = null;
  let exactReturnUrl: string | undefined;
  let operation: { attemptId: string; operationId: string; inputDigest: string } | undefined;
  let operationClaimed = false;
  let operationSettlementStarted = false;
  try {
    state = readGoogleDriveOAuthState(input.state, deps.settings);
    if (state.connectAttemptId) {
      const stored = await getConnectAttempt(deps.db, state, state.connectAttemptId);
      if (
        stored.attempt.providerId !==
          (state.capability === "publish" ? "google-drive-publish" : "google-drive-knowledge") ||
        stored.attempt.ownership !== "personal"
      )
        throw new GoogleDriveCallbackError("connection_conflict");
      exactReturnUrl = stored.returnUrl;
      operation = {
        attemptId: state.connectAttemptId,
        operationId: `oauth:${state.nonce}`,
        inputDigest: createHash("sha256").update(input.state!).digest("hex"),
      };
      const claim = await claimOAuthAcquisition(
        deps.db,
        state,
        {
          ...operation,
          expectedRevision: stored.attempt.revision,
          authorize: (tx, _attempt, origin) =>
            requireConnectOwnerAuthority(tx, state!, "connections:write", origin),
        },
        "google-drive",
        Boolean(input.code && !input.error),
      );
      if (claim.status === "replayed") {
        return { redirectTo: exactReturnUrl, exactReturn: true };
      }
      operationClaimed = true;
    }
    refuseRetiredGoogleDriveCallback();
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
      throw new GoogleDriveCallbackError("state_replayed");
    }
    if (operation && (input.error || !input.code)) {
      operationSettlementStarted = true;
      await finishConnectOperation(deps.db, state, {
        ...operation,
        authorize: (tx, _attempt, origin) =>
          requireConnectOwnerAuthority(tx, state!, "connections:write", origin),
        commit: async (_tx, current) => ({
          ...current,
          revision: current.revision + 1,
          state: input.error === "access_denied" ? "cancelled" : "failed",
          nextAction: { type: "none" },
          error: {
            code: input.error ? "provider_denied" : "missing_code",
            message: "Authorization was not completed. Start a new connection attempt.",
            retryable: false,
          },
        }),
      });
      return { redirectTo: exactReturnUrl!, exactReturn: true };
    }
    if (input.error) {
      throw new GoogleDriveCallbackError("provider_denied");
    }
    if (!input.code) {
      throw new GoogleDriveCallbackError("missing_code");
    }
    await withOrganizationIntegrationAcquisition(deps.db, state, ["google-drive"], async () => {});

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
      (state.publishingFolderId && !scopeDecision.capabilities.includes("recursive_source_sync"))
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
            state.publishingFolderId ?? input.pickedFileIds,
            fetchImpl,
          )
        : previousMetadata?.outputDestination;
    if (state.capability === "publish") {
      if (!existing) throw new GoogleDriveCallbackError("connection_conflict");
      if (!state.publishingFolderId) {
        // The file-only Picker credential must never replace the existing
        // recursive-read credential. Carry only its verified folder into a
        // fresh, single-use PKCE flow that obtains both capabilities.
        const { nonce: _nonce, iat: _iat, encryptedPkceVerifier: _verifier, ...authority } = state;
        const continuation = googleDriveOAuthAuthorization(deps.settings, {
          ...authority,
          publishingFolderId: outputDestination!.folderId,
        });
        if (operation) {
          const acceptedState = state;
          operationSettlementStarted = true;
          await finishOAuthAcquisition(
            deps.db,
            acceptedState,
            {
              ...operation,
              authorize: (tx, _attempt, origin) =>
                requireConnectOwnerAuthority(tx, acceptedState, "connections:write", origin),
              commit: async (_tx, current) => ({
                ...current,
                revision: current.revision + 1,
                state: "requires_user_action",
                nextAction: { type: "authorize", url: continuation.authorizationUrl },
              }),
            },
            "google-drive",
          );
        }
        return { redirectTo: continuation.authorizationUrl };
      }
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
    const acceptedState = state;
    const persist = async (tx: Database) => {
      // Capture the validated immutable callback state for delayed persistence.
      // eslint-disable-next-line no-shadow
      const state = acceptedState;
      if (state.capability === "publish" && existing)
        await ensureConnectorActionPolicyDefault(tx, {
          accountId: state.accountId,
          workspaceId: state.workspaceId,
          subjectId: state.subjectId,
          connectionId: existing.id,
          serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
          toolName: GOOGLE_DRIVE_PUBLICATION_TOOL_NAME,
          actionName: GOOGLE_DRIVE_PUBLICATION_CREATE_ACTION,
          policy: "ask",
        });
      return existing
        ? updateConnection(tx, {
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
        : createConnection(tx, {
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
    };
    if (operation) {
      operationSettlementStarted = true;
      await finishOAuthAcquisition(
        deps.db,
        acceptedState,
        {
          ...operation,
          authorize: (tx, _attempt, origin) =>
            requireConnectOwnerAuthority(tx, acceptedState, "connections:write", origin),
          commit: async (tx, current) => {
            const connection = await persist(tx);
            if (!connection) throw new GoogleDriveCallbackError("connection_conflict");
            return {
              ...current,
              revision: current.revision + 1,
              state: "complete",
              credentialsCommitted: true,
              nextAction: { type: "none" },
              account: {
                id: connection.id,
                version: connection.version,
                providerId: current.providerId,
                label: identity.emailAddress ?? identity.displayName,
                ownership: "personal",
                status: "connected",
              },
            };
          },
        },
        "google-drive",
      );
      return { redirectTo: exactReturnUrl!, exactReturn: true };
    }
    const connection = await withOrganizationIntegrationAcquisition(
      deps.db,
      acceptedState,
      ["google-drive"],
      async (tx) => {
        await requireGoogleDriveCallbackGrant({ ...deps, db: tx }, acceptedState);
        return persist(tx);
      },
    );
    if (!connection) {
      throw new GoogleDriveCallbackError("connection_conflict");
    }
    return {
      redirectTo: googleDriveReturnUrl(returnBaseUrl, state.returnPath, "connected", connection.id),
    };
  } catch (error) {
    if (
      state &&
      operation &&
      operationClaimed &&
      !operationSettlementStarted &&
      error instanceof GoogleDriveCallbackError &&
      [
        GOOGLE_DRIVE_NATIVE_RETIRED_REASON,
        "state_replayed",
        "scope_not_granted",
        "connection_conflict",
        "account_mismatch",
        "output_folder_required",
        "output_folder_unavailable",
        "refresh_token_missing",
        "identity_verification_failed",
      ].includes(error.reason)
    ) {
      // A definite validation rejection before persistence has no connection
      // effect. Record a terminal receipt so polling and replay can finish.
      // Transport failures and errors after settlement starts remain fenced:
      // their outcome may be unknown, so never overwrite or retry them here.
      const acceptedState = state;
      try {
        await finishConnectOperation(deps.db, acceptedState, {
          ...operation,
          authorize: (tx, _attempt, origin) =>
            requireConnectOwnerAuthority(tx, acceptedState, "connections:write", origin),
          commit: async (_tx, current) => ({
            ...current,
            revision: current.revision + 1,
            state: "failed",
            nextAction: { type: "none" },
            error: {
              code: error.reason,
              message:
                error.reason === GOOGLE_DRIVE_NATIVE_RETIRED_REASON
                  ? GOOGLE_DRIVE_NATIVE_RETIRED_MESSAGE
                  : "Authorization was not completed. Start a new connection attempt.",
              retryable: false,
            },
          }),
        });
      } catch {
        // Revoked authority or unavailable storage cannot authorize settlement.
        // Preserve the claim rather than manufacture a terminal outcome.
      }
    }
    if (exactReturnUrl) return { redirectTo: exactReturnUrl, exactReturn: true };
    // Reading the state is the first step, so no state means the link itself
    // was unusable: say whether it expired rather than blame configuration.
    const failure = state ? null : oauthStateFailureReturn(deps.settings, input.state);
    return {
      redirectTo: googleDriveReturnUrl(
        returnBaseUrl,
        state?.returnPath ?? failure!.returnPath,
        "error",
        failure?.reason ?? googleDriveErrorReason(error),
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
  if (input.payload.action === "resume") assertNativeGoogleDriveAvailable();
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

  const persist = (tx: Database) =>
    transitionConnectionState(tx, {
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
  const updated =
    input.payload.action === "resume"
      ? await withOrganizationIntegrationPolicyFence(
          deps.db,
          { accountId: existing.accountId, workspaceId: input.workspaceId },
          async (tx, policy) => {
            const current = await getConnectionMetadata(
              tx,
              input.workspaceId,
              input.connectionId,
              input.subjectId,
            );
            if (
              current?.status === "active" &&
              effectiveGoogleDriveLifecycle(
                current,
                requireGoogleDriveConnection(current, input.subjectId),
              ).state === "active"
            )
              return current;
            assertOrganizationIntegrationAllowed(policy, "google-drive");
            return persist(tx);
          },
        )
      : await persist(deps.db);
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
    /** Who disconnects: audited in the disconnect's transaction. */
    audit?: DisconnectAuditActor | null;
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
      audit: input.audit ?? null,
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
    const previous: ScheduledTaskRestoreState = { task: task };
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
      if (requireScheduledTaskKnowledgeSource(task).initiatingSubjectId !== subjectId) return;
      const resolved = await getKnowledgeSourceForSyncAuthority(deps.db, {
        accountId: task.accountId,
        workspaceId: task.workspaceId,
        sourceId: requireScheduledTaskKnowledgeSource(task).sourceId,
        initiatingSubjectId: subjectId,
      });
      if (!resolved || resolved.source.lifecycleState !== "active") return;
      await deauthorizeKnowledgeSourceRetrieval(deps.db, {
        accountId: task.accountId,
        workspaceId: task.workspaceId,
        sourceId: requireScheduledTaskKnowledgeSource(task).sourceId,
        audience: requireScheduledTaskKnowledgeSource(task).destination,
        operationId: `google-drive-deauthorize:${connection.id}:${authorityVersion}:${requireScheduledTaskKnowledgeSource(task).sourceId}:${reasonCode}`,
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
  fn: (task: ScheduledTask) => Promise<void>,
): Promise<void> {
  const tasks = await listKnowledgeSourceSyncTasksForConnection(deps.db, workspaceId, connectionId);
  for (const task of tasks) {
    await fn(task);
  }
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

export async function preflightKnowledgeSourceScheduleAuthorization(
  deps: ApiRouteDeps,
  input: { task: ScheduledTask; subjectId: string },
): Promise<void> {
  const { task } = input;
  if (!scheduledTaskKnowledgeSource(task)) return;
  if (
    requireScheduledTaskKnowledgeSource(task).initiatingSubjectId !== input.subjectId ||
    requireScheduledTaskKnowledgeSource(task).connection.ownerSubjectId !== input.subjectId
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
  // A deselected/disconnected source still owns a retained task that must be
  // deletable. The row-locked task revision below freezes this descriptor;
  // cleanup mutates only its exact accepted generations.
}

export async function revokeKnowledgeSourceScheduleAuthorization(
  deps: ApiRouteDeps,
  input: { task: ScheduledTask; subjectId: string },
): Promise<void> {
  const { task } = input;
  if (!scheduledTaskKnowledgeSource(task)) return;
  if (
    requireScheduledTaskKnowledgeSource(task).initiatingSubjectId !== input.subjectId ||
    requireScheduledTaskKnowledgeSource(task).connection.ownerSubjectId !== input.subjectId
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
  await cleanupKnowledgeSourceScheduleAuthorization(deps, {
    taskId: task.id,
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    connectionId: requireScheduledTaskKnowledgeSource(task).connection.connectionId,
    connectionVersion: requireScheduledTaskKnowledgeSource(task).connection.connectionVersion,
    sourceId: requireScheduledTaskKnowledgeSource(task).sourceId,
    sourceLifecycleGeneration: requireScheduledTaskKnowledgeSource(task).sourceLifecycleGeneration,
    sourceConfigGeneration: requireScheduledTaskKnowledgeSource(task).sourceConfigGeneration,
    externalSourceId,
    subjectId: input.subjectId,
  });
}

export async function cleanupKnowledgeSourceScheduleAuthorization(
  deps: ApiRouteDeps,
  input: {
    taskId: string;
    accountId: string;
    workspaceId: string;
    connectionId: string;
    connectionVersion: number;
    sourceId: string;
    sourceLifecycleGeneration: number;
    sourceConfigGeneration: number;
    externalSourceId: string;
    subjectId: string;
  },
): Promise<void> {
  const resolvedBeforeLock = await getKnowledgeSourceForSyncAuthority(deps.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    initiatingSubjectId: input.subjectId,
  });
  if (
    resolvedBeforeLock?.source.lifecycleState !== "active" ||
    resolvedBeforeLock.source.lifecycleGeneration !== input.sourceLifecycleGeneration
  ) {
    return;
  }
  await withWorkspaceSubjectRls(deps.db, input.workspaceId, input.subjectId, async (tx) => {
    const connection = await getConnectionMetadata(
      tx,
      input.workspaceId,
      input.connectionId,
      input.subjectId,
    );
    let revocationVersion = input.connectionVersion;
    if (connection) {
      const metadata = requireGoogleDriveConnection(connection, input.subjectId);
      const sources =
        metadata.selectedSources ?? (metadata.selectedSource ? [metadata.selectedSource] : []);
      revocationVersion = connection.version;
      const updated = await transitionConnectionState(tx, {
        workspaceId: input.workspaceId,
        connectionId: connection.id,
        visibleToSubjectId: input.subjectId,
        expectedVersion: connection.version,
        metadata: GoogleDriveConnectionMetadata.parse({
          ...metadata,
          selectedSource: null,
          selectedSources: sources.map((source) =>
            source.id === input.externalSourceId
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
    const resolved = await getKnowledgeSourceForSyncAuthority(tx, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      initiatingSubjectId: input.subjectId,
    });
    if (
      resolved?.source.lifecycleState !== "active" ||
      resolved.source.lifecycleGeneration !== input.sourceLifecycleGeneration
    ) {
      throw new HTTPException(409, {
        message: "knowledge source changed; retry schedule deletion",
      });
    }
    await recordKnowledgeLifecycleEvent(tx, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      targetKind: "source",
      targetId: resolved.source.id,
      eventType: "deleted",
      expectedGeneration: resolved.source.lifecycleGeneration,
      operationId: `knowledge-schedule-delete:${input.taskId}:${revocationVersion}`,
      reasonCode: "schedule_deleted",
      actor: {
        kind: "human",
        subjectId: input.subjectId,
        initiatingHumanSubjectId: input.subjectId,
      },
    });
  });
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

function requireGoogleDriveSettings(_settings: Settings): {
  clientId: string;
  clientSecret: string;
} {
  throw new HTTPException(410, { message: GOOGLE_DRIVE_NATIVE_RETIRED_MESSAGE });
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
  // Reject a state minted by any other flow before reading anything else. A
  // pre-cutover state carries no kind and is refused; that is the same bounded
  // `oauthStateTtlMs` window the personal-owner claim already fails closed on,
  // so this adds no new breakage.
  if (payload.kind !== GOOGLE_DRIVE_OAUTH_STATE_KIND) {
    throw new HTTPException(400, { message: "invalid Google Drive OAuth state" });
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
  const publishingFolderId = optionalString(payload.publishingFolderId) ?? undefined;
  if (
    payload.publishingFolderId !== undefined &&
    (!publishingFolderId ||
      publishingFolderId.length > 512 ||
      capability !== "publish" ||
      !connectionId)
  ) {
    throw new HTTPException(400, { message: "invalid Google Drive publishing state" });
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
    personalOwnerVerified: personalOwnerVerifiedInState(payload),
    ...(typeof payload.connectAttemptId === "string"
      ? { connectAttemptId: payload.connectAttemptId }
      : {}),
    ...(typeof payload.encryptedExternalContinuation === "string"
      ? {
          externalContinuation: ExternalActorContinuation.parse(
            JSON.parse(
              decryptEnvironmentValue(
                requireEnvironmentEncryption(settings),
                payload.encryptedExternalContinuation,
              ),
            ),
          ),
        }
      : {}),
    returnPath,
    encryptedPkceVerifier: requiredString(
      payload.encryptedPkceVerifier,
      "state.encryptedPkceVerifier",
    ),
    capability,
    ...(publishingFolderId ? { publishingFolderId } : {}),
    ...(connectionId ? { connectionId, connectionVersion: connectionVersion! } : {}),
    nonce: requiredString(payload.nonce, "state.nonce"),
    iat,
  };
}

async function requireGoogleDriveCallbackGrant(
  deps: ApiRouteDeps,
  state: GoogleDriveOAuthState,
): Promise<void> {
  // This connector is personal-only by construction: its start request carries
  // no ownership and the callback always writes `subjectId: state.subjectId`.
  // A state minted before the start-side principal fence existed carries no
  // `personalOwnerVerified` claim and must not land a personal Connection.
  if (
    !personalOwnerStateAccepted({
      ownership: "personal",
      subjectId: state.subjectId,
      personalOwnerVerified: state.personalOwnerVerified,
    })
  ) {
    throw new HTTPException(422, {
      message: personalOnlyConnectionPrincipalMessage("Google Drive"),
    });
  }
  await requireConnectOwnerAuthority(deps.db, state, "connections:write");
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

function assertNativeGoogleDriveAvailable(): void {
  throw new HTTPException(410, { message: GOOGLE_DRIVE_NATIVE_RETIRED_MESSAGE });
}

function refuseRetiredGoogleDriveCallback(): void {
  throw new GoogleDriveCallbackError(GOOGLE_DRIVE_NATIVE_RETIRED_REASON);
}
