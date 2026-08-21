import type { Settings } from "@opengeni/config";
import type { AccessGrant, ScheduledTask, ScheduledTaskScheduleSpec } from "@opengeni/contracts";
import {
  ATLASSIAN_CREDENTIAL_LABEL,
  ATLASSIAN_CREDENTIAL_ROLE,
  ATLASSIAN_PROVIDER_DOMAIN,
  ATLASSIAN_REQUIRED_SCOPES,
  AtlassianBrowseItem,
  AtlassianBrowseResponse,
  AtlassianConnectionLifecycle,
  AtlassianConnectionMetadata,
  AtlassianOAuthStartResponse,
  SaveAtlassianSourcesRequest,
  atlassianScopesAllowRead,
  type AtlassianDisconnectRequest,
  type AtlassianLifecycleActionRequest,
  type AtlassianOAuthStartRequest,
  type AtlassianSelectedSource,
} from "@opengeni/contracts/atlassian";
import {
  bindConnectorDocumentDestination,
  type ConnectorDocumentDestinationSelection,
} from "@opengeni/contracts/connector-destinations";
import {
  captureScheduledTaskRestoreState,
  createValidatedScheduledTask,
  hasPermission,
  manualScheduledTaskTriggerWorkflowId,
  requireEnvironmentEncryption,
  syncCreatedScheduledTask,
  syncUpdatedScheduledTask,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  appendKnowledgeSourceAclVersion,
  buildConnectionTokenResolver,
  ConnectionDisconnectGenerationError,
  ConnectionDisconnectIdempotencyError,
  consumeIntegrationOAuthStateNonce,
  createConnection,
  deauthorizeKnowledgeSourceRetrieval,
  disconnectConnectionIdempotently,
  encryptEnvironmentValue,
  getConnectionMetadata,
  getKnowledgeSourceByExternalIdentityForSyncAuthority,
  getKnowledgeSourceForSyncAuthority,
  getWorkspaceGrant,
  listKnowledgeSourceSyncTasksForConnection,
  loadConnectionCredentialForBroker,
  recordKnowledgeLifecycleEvent,
  transitionConnectionState,
  updateConnection,
  updateScheduledTask,
  upsertKnowledgeProvider,
  upsertKnowledgeSource,
  withWorkspaceSubjectRls,
} from "@opengeni/db";
import { atlassianKnowledgeSourceIdentity } from "@opengeni/documents/atlassian";
import { createSignedState, readSignedState } from "@opengeni/github";
import { readResponseJsonBounded, type FetchLike } from "@opengeni/network";
import { HTTPException } from "hono/http-exception";
import {
  personalOnlyConnectionPrincipalMessage,
  personalOwnerStateAccepted,
  personalOwnerVerifiedInState,
  PERSONAL_OWNER_VERIFIED_STATE_CLAIM,
} from "../connection-ownership";
import {
  integrationBaseUrl,
  oauthStateTtlMs,
  requireIntegrationsStateSecret,
} from "./oauth-client";

/**
 * Flow discriminator for this connector's signed OAuth state. See the matching
 * constant in `google-drive.ts`: this state carries no `ownership` field and no
 * provider identity, and its return path is byte-identical to one the MCP OAuth
 * start signs from caller input, so the flow kind is what binds a state here.
 */
const ATLASSIAN_OAUTH_STATE_KIND = "atlassian_oauth";
const ATLASSIAN_AUTHORIZATION_URL = "https://auth.atlassian.com/authorize";
const ATLASSIAN_TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const ATLASSIAN_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";
const ATLASSIAN_PROFILE_URL = "https://api.atlassian.com/me";
const ATLASSIAN_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ATLASSIAN_REQUEST_TIMEOUT_MS = 15_000;
const ATLASSIAN_RETURN_PATH = (workspaceId: string) => `/workspaces/${workspaceId}/capabilities`;

type AtlassianOAuthState = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  /** Signed proof that a live managed human started this personal-only flow. */
  personalOwnerVerified: boolean;
  returnPath: string;
  connectionId?: string;
  connectionVersion?: number;
  nonce: string;
  iat: number;
};

type AtlassianConnectionRecord = NonNullable<Awaited<ReturnType<typeof getConnectionMetadata>>>;
type AtlassianSite = {
  cloudId: string;
  name: string;
  url: string;
  products: Array<"jira" | "confluence">;
};

export async function startAtlassianOAuth(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    requestUrl: string;
    payload: AtlassianOAuthStartRequest;
  },
): Promise<AtlassianOAuthStartResponse> {
  const oauth = requireAtlassianSettings(deps.settings);
  const existing = input.payload.connectionId
    ? await getConnectionMetadata(
        deps.db,
        input.workspaceId,
        input.payload.connectionId,
        input.subjectId,
      )
    : null;
  if (input.payload.connectionId && !existing) {
    throw new HTTPException(404, { message: "Atlassian connection not found" });
  }
  if (existing) requireAtlassianConnection(existing, input.subjectId);

  const baseUrl = integrationBaseUrl(deps.settings.publicBaseUrl, input.requestUrl);
  const redirectUri = `${baseUrl}/v1/integrations/atlassian/callback`;
  const state = createSignedState(requireIntegrationsStateSecret(deps.settings), {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    kind: ATLASSIAN_OAUTH_STATE_KIND,
    // The route admits only a managed human, so reaching here is the proof; the
    // callback has no live principal and enforces exactly this claim.
    [PERSONAL_OWNER_VERIFIED_STATE_CLAIM]: true,
    returnPath: ATLASSIAN_RETURN_PATH(input.workspaceId),
    ...(existing ? { connectionId: existing.id, connectionVersion: existing.version } : {}),
  });
  const url = new URL(ATLASSIAN_AUTHORIZATION_URL);
  url.searchParams.set("audience", ATLASSIAN_PROVIDER_DOMAIN);
  url.searchParams.set("client_id", oauth.clientId);
  url.searchParams.set("scope", ATLASSIAN_REQUIRED_SCOPES.join(" "));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("prompt", "consent");
  return AtlassianOAuthStartResponse.parse({
    authorizationUrl: url.toString(),
    expiresAt: new Date(Date.now() + oauthStateTtlMs).toISOString(),
  });
}

export async function completeAtlassianOAuthCallback(
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
  let state: AtlassianOAuthState | null = null;
  try {
    state = readAtlassianOAuthState(input.state, deps.settings);
    await requireCallbackGrant(deps, state);
    const consumed = await consumeIntegrationOAuthStateNonce(deps.db, {
      accountId: state.accountId,
      workspaceId: state.workspaceId,
      subjectId: state.subjectId,
      nonce: state.nonce,
      expiresAt: new Date(state.iat * 1000 + oauthStateTtlMs),
      now: new Date(),
    });
    if (!consumed) throw new AtlassianCallbackError("state_reused");
    if (input.error) throw new AtlassianCallbackError("provider_denied");
    if (!input.code) throw new AtlassianCallbackError("missing_code");

    const oauth = requireAtlassianSettings(deps.settings);
    const redirectUri = `${baseUrl}/v1/integrations/atlassian/callback`;
    const fetchImpl = deps.atlassianFetch ?? fetch;
    const token = await exchangeAuthorizationCode(fetchImpl, {
      code: input.code,
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      redirectUri,
    });
    if (!atlassianScopesAllowRead(token.scopes)) {
      throw new AtlassianCallbackError("scope_not_granted");
    }
    const [profile, sites] = await Promise.all([
      fetchAtlassianProfile(fetchImpl, token.accessToken),
      fetchAccessibleSites(fetchImpl, token.accessToken),
    ]);
    if (sites.length === 0) throw new AtlassianCallbackError("no_accessible_sites");
    await requireCallbackGrant(deps, state);

    const existing = state.connectionId
      ? await getConnectionMetadata(deps.db, state.workspaceId, state.connectionId, state.subjectId)
      : null;
    if (state.connectionId && !existing) throw new AtlassianCallbackError("connection_conflict");
    if (existing) {
      const previous = requireAtlassianConnection(existing, state.subjectId);
      if (existing.version !== state.connectionVersion) {
        throw new AtlassianCallbackError("connection_conflict");
      }
      if (previous.atlassianAccountId !== profile.accountId) {
        throw new AtlassianCallbackError("account_mismatch");
      }
    }
    const previousMetadata = existing ? AtlassianConnectionMetadata.parse(existing.metadata) : null;
    let refreshToken = token.refreshToken;
    if (!refreshToken && existing) {
      const previousCredential = await loadConnectionCredentialForBroker(deps.db, deps.settings, {
        workspaceId: state.workspaceId,
        connectionId: existing.id,
        providerDomain: ATLASSIAN_PROVIDER_DOMAIN,
        kind: "oauth2",
        subjectId: state.subjectId,
        allowSubjectOwned: true,
      });
      refreshToken = optionalString(previousCredential?.credential.refresh_token) ?? undefined;
    }
    if (!refreshToken) throw new AtlassianCallbackError("refresh_token_missing");

    const credentialEncrypted = encryptEnvironmentValue(
      requireEnvironmentEncryption(deps.settings),
      JSON.stringify({
        access_token: token.accessToken,
        refresh_token: refreshToken,
        token_type: token.tokenType,
        expires_at: token.expiresAt.toISOString(),
        scope: token.scopes.join(" "),
        token_endpoint: ATLASSIAN_TOKEN_URL,
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        token_endpoint_auth_method: "client_secret_post",
        token_request_encoding: "json",
      }),
    );
    const metadata = AtlassianConnectionMetadata.parse({
      credentialRole: ATLASSIAN_CREDENTIAL_ROLE,
      credentialLabel: ATLASSIAN_CREDENTIAL_LABEL,
      atlassianAccountId: profile.accountId,
      displayName: profile.displayName,
      email: profile.email,
      sites,
      verifiedAt: new Date().toISOString(),
      accessMode: "readonly",
      lifecycle: lifecycle("active"),
      ...(previousMetadata?.documentDestination
        ? { documentDestination: previousMetadata.documentDestination }
        : {}),
      selectedSources: previousMetadata?.selectedSources ?? [],
    });
    const connection = existing
      ? await updateConnection(deps.db, {
          workspaceId: state.workspaceId,
          connectionId: existing.id,
          visibleToSubjectId: state.subjectId,
          expectedVersion: existing.version,
          subjectId: state.subjectId,
          providerDomain: ATLASSIAN_PROVIDER_DOMAIN,
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
          providerDomain: ATLASSIAN_PROVIDER_DOMAIN,
          kind: "oauth2",
          credentialEncrypted,
          grantedScopes: token.scopes,
          expiresAt: token.expiresAt,
          metadata,
          createdBySubjectId: state.subjectId,
        });
    if (!connection) throw new AtlassianCallbackError("connection_conflict");
    return {
      redirectTo: returnUrl(returnBaseUrl, state.returnPath, "connected", connection.id),
    };
  } catch (error) {
    return {
      redirectTo: returnUrl(
        returnBaseUrl,
        state?.returnPath ?? "/integrations",
        "error",
        errorReason(error),
      ),
    };
  }
}

export async function browseAtlassianSources(
  deps: ApiRouteDeps,
  input: { workspaceId: string; subjectId: string; connectionId: string },
) {
  const connection = await getConnectionMetadata(
    deps.db,
    input.workspaceId,
    input.connectionId,
    input.subjectId,
  );
  if (!connection) throw new HTTPException(404, { message: "Atlassian connection not found" });
  const metadata = requireUsableConnection(connection, input.subjectId);
  const groups = await Promise.all(
    metadata.sites.flatMap((site) =>
      site.products.map(async (product) =>
        product === "jira"
          ? await browseJiraProjects(deps, input, site)
          : await browseConfluenceSpaces(deps, input, site),
      ),
    ),
  );
  const current =
    (await getConnectionMetadata(
      deps.db,
      input.workspaceId,
      input.connectionId,
      input.subjectId,
    )) ?? connection;
  return AtlassianBrowseResponse.parse({
    connection: current,
    items: groups
      .flat()
      .sort(
        (left, right) =>
          left.siteName.localeCompare(right.siteName) ||
          left.kind.localeCompare(right.kind) ||
          left.name.localeCompare(right.name),
      ),
  });
}

export async function searchAtlassianLive(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    subjectId: string;
    connectionId: string;
    query: string;
    product?: "jira" | "confluence" | undefined;
    limit: number;
  },
) {
  const connection = await getConnectionMetadata(
    deps.db,
    input.workspaceId,
    input.connectionId,
    input.subjectId,
  );
  if (!connection) throw new HTTPException(404, { message: "Atlassian connection not found" });
  const metadata = requireUsableConnection(connection, input.subjectId);
  const query = input.query.trim();
  if (!query || query.length > 500)
    throw new HTTPException(400, { message: "invalid search query" });
  const jiraSources = metadata.selectedSources.filter(
    (source) => source.kind === "jira_project" && input.product !== "confluence",
  );
  const confluenceSources = metadata.selectedSources.filter(
    (source) => source.kind === "confluence_space" && input.product !== "jira",
  );
  const results = await Promise.all([
    ...groupSourcesByCloudId(jiraSources).map(async ([cloudId, sources]) => {
      const url = new URL(
        `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/search/jql`,
      );
      url.searchParams.set(
        "jql",
        `project in (${sources.map((source) => jqlString(source.key)).join(",")}) AND text ~ ${jqlString(query)} ORDER BY updated DESC`,
      );
      url.searchParams.set("maxResults", String(input.limit));
      url.searchParams.set("fields", "summary,project,status,issuetype,updated");
      const payload = objectRecord(
        await atlassianApiRequest(deps, { ...input, url, label: "Jira live search" }),
      );
      return (Array.isArray(payload.issues) ? payload.issues : []).map((raw) => {
        const row = objectRecord(raw);
        const fields = objectRecord(row.fields);
        const project = objectRecord(fields.project);
        const key = requiredString(row.key, "issue.key");
        const source = sources.find(
          (candidate) => candidate.resourceId === optionalString(project.id),
        );
        return {
          kind: "jira_issue" as const,
          id: requiredString(row.id, "issue.id"),
          key,
          title: requiredString(fields.summary, "issue.summary"),
          sourceId: source?.id ?? null,
          sourceName: source?.name ?? optionalString(project.name),
          status: optionalString(objectRecord(fields.status).name),
          updatedAt: optionalString(fields.updated),
          url: new URL(
            `/browse/${encodeURIComponent(key)}`,
            source?.siteUrl ?? sources[0]!.siteUrl,
          ).toString(),
        };
      });
    }),
    ...groupSourcesByCloudId(confluenceSources).map(async ([cloudId, sources]) => {
      const url = new URL(
        `https://api.atlassian.com/ex/confluence/${encodeURIComponent(cloudId)}/wiki/rest/api/search`,
      );
      url.searchParams.set(
        "cql",
        `type=page AND space in (${sources.map((source) => cqlString(source.key)).join(",")}) AND text ~ ${cqlString(query)}`,
      );
      url.searchParams.set("limit", String(input.limit));
      url.searchParams.set("expand", "content.space");
      const payload = objectRecord(
        await atlassianApiRequest(deps, { ...input, url, label: "Confluence live search" }),
      );
      const base = optionalString(objectRecord(payload._links).base) ?? sources[0]!.siteUrl;
      return (Array.isArray(payload.results) ? payload.results : []).map((raw) => {
        const row = objectRecord(raw);
        const content = objectRecord(row.content);
        const space = objectRecord(content.space);
        const source = sources.find((candidate) => candidate.key === optionalString(space.key));
        const webUi = optionalString(objectRecord(content._links).webui);
        return {
          kind: "confluence_page" as const,
          id: requiredString(content.id, "page.id"),
          key: null,
          title: requiredString(content.title, "page.title"),
          sourceId: source?.id ?? null,
          sourceName: source?.name ?? optionalString(space.name),
          status: null,
          updatedAt: optionalString(objectRecord(row.lastModified).when),
          url: webUi ? new URL(webUi, base).toString() : (source?.siteUrl ?? base),
        };
      });
    }),
  ]);
  return results.flat().slice(0, input.limit);
}

export async function getAtlassianLiveItem(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    subjectId: string;
    connectionId: string;
    kind: "jira_issue" | "confluence_page";
    id: string;
  },
) {
  const connection = await getConnectionMetadata(
    deps.db,
    input.workspaceId,
    input.connectionId,
    input.subjectId,
  );
  if (!connection) throw new HTTPException(404, { message: "Atlassian connection not found" });
  const metadata = requireUsableConnection(connection, input.subjectId);
  if (input.kind === "jira_issue") {
    for (const [cloudId, sources] of groupSourcesByCloudId(
      metadata.selectedSources.filter((source) => source.kind === "jira_project"),
    )) {
      const url = new URL(
        `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/issue/${encodeURIComponent(input.id)}`,
      );
      url.searchParams.set(
        "fields",
        "summary,description,project,status,issuetype,priority,assignee,reporter,labels,created,updated",
      );
      try {
        const issue = objectRecord(
          await atlassianApiRequest(deps, { ...input, url, label: "Jira live issue" }),
        );
        const fields = objectRecord(issue.fields);
        const source = sources.find(
          (candidate) => candidate.resourceId === optionalString(objectRecord(fields.project).id),
        );
        if (!source) continue;
        const comments = await readJiraLiveComments(deps, input, cloudId);
        return {
          kind: "jira_issue" as const,
          id: requiredString(issue.id, "issue.id"),
          key: requiredString(issue.key, "issue.key"),
          title: requiredString(fields.summary, "issue.summary"),
          source: { id: source.id, name: source.name, siteName: source.siteName },
          status: optionalString(objectRecord(fields.status).name),
          issueType: optionalString(objectRecord(fields.issuetype).name),
          priority: optionalString(objectRecord(fields.priority).name),
          assignee: optionalString(objectRecord(fields.assignee).displayName),
          reporter: optionalString(objectRecord(fields.reporter).displayName),
          labels: Array.isArray(fields.labels)
            ? fields.labels.filter((value): value is string => typeof value === "string")
            : [],
          createdAt: optionalString(fields.created),
          updatedAt: optionalString(fields.updated),
          description: adfText(fields.description),
          comments,
          url: new URL(
            `/browse/${encodeURIComponent(requiredString(issue.key, "issue.key"))}`,
            source.siteUrl,
          ).toString(),
        };
      } catch (error) {
        if (error instanceof HTTPException && error.status === 404) continue;
        throw error;
      }
    }
    throw new HTTPException(404, { message: "Jira issue is outside the selected projects" });
  }

  for (const [cloudId, sources] of groupSourcesByCloudId(
    metadata.selectedSources.filter((source) => source.kind === "confluence_space"),
  )) {
    const url = new URL(
      `https://api.atlassian.com/ex/confluence/${encodeURIComponent(cloudId)}/wiki/api/v2/pages/${encodeURIComponent(input.id)}`,
    );
    url.searchParams.set("body-format", "storage");
    try {
      const page = objectRecord(
        await atlassianApiRequest(deps, { ...input, url, label: "Confluence live page" }),
      );
      const source = sources.find(
        (candidate) => candidate.resourceId === optionalString(page.spaceId),
      );
      if (!source) continue;
      const comments = await readConfluenceLiveComments(deps, input, cloudId);
      const webUi = optionalString(objectRecord(page._links).webui);
      return {
        kind: "confluence_page" as const,
        id: requiredString(page.id, "page.id"),
        title: requiredString(page.title, "page.title"),
        source: { id: source.id, name: source.name, siteName: source.siteName },
        status: optionalString(page.status),
        createdAt: optionalString(page.createdAt),
        updatedAt: optionalString(objectRecord(page.version).createdAt),
        content: optionalString(objectRecord(objectRecord(page.body).storage).value) ?? "",
        comments,
        url: webUi
          ? new URL(webUi.startsWith("/wiki/") ? webUi : `/wiki${webUi}`, source.siteUrl).toString()
          : source.siteUrl,
      };
    } catch (error) {
      if (error instanceof HTTPException && error.status === 404) continue;
      throw error;
    }
  }
  throw new HTTPException(404, { message: "Confluence page is outside the selected spaces" });
}

export async function saveAtlassianSources(
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
  const parsed = SaveAtlassianSourcesRequest.safeParse(input.payload);
  if (!parsed.success) {
    throw new HTTPException(400, { message: "invalid Atlassian source selection" });
  }
  const existing = await getConnectionMetadata(
    deps.db,
    input.workspaceId,
    input.connectionId,
    input.subjectId,
  );
  if (!existing) throw new HTTPException(404, { message: "Atlassian connection not found" });
  const metadata = requireUsableConnection(existing, input.subjectId);
  const destinationSelection: ConnectorDocumentDestinationSelection = parsed.data.destination;
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
  const destination = bindConnectorDocumentDestination(destinationSelection, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initiatingSubjectId: input.subjectId,
  });

  const available = (await browseAtlassianSources(deps, input)).items;
  const availableById = new Map(available.map((source) => [source.id, source]));
  const verified = parsed.data.sources.map((source) => {
    const current = availableById.get(source.id);
    if (
      !current ||
      current.cloudId !== source.cloudId ||
      current.resourceId !== source.resourceId ||
      current.key !== source.key ||
      current.name !== source.name ||
      current.kind !== source.kind
    ) {
      throw new HTTPException(409, {
        message: "An Atlassian source changed while it was selected; reload the list",
      });
    }
    return current;
  });
  const previousSources = metadata.selectedSources;
  const updated = await transitionConnectionState(deps.db, {
    workspaceId: input.workspaceId,
    connectionId: existing.id,
    visibleToSubjectId: input.subjectId,
    expectedVersion: existing.version,
    metadata: AtlassianConnectionMetadata.parse({
      ...metadata,
      documentDestination: destination,
      selectedSources: verified.map((source) => ({
        ...source,
        destination,
        syncCadence: parsed.data.syncCadence,
        syncEnabled: parsed.data.syncEnabled,
        configGeneration:
          (previousSources.find((previous) => previous.id === source.id)?.configGeneration ?? 0) +
          1,
        readPolicy: parsed.data.readPolicy,
        selectedAt: new Date().toISOString(),
      })),
    }),
    updatedBySubjectId: input.subjectId,
  });
  if (!updated) throw new HTTPException(409, { message: "Atlassian connection changed" });
  await materializeSchedules(deps, {
    ...input,
    connection: updated,
    metadata: AtlassianConnectionMetadata.parse(updated.metadata),
    previousSources,
  });
  return updated;
}

export async function transitionAtlassianLifecycle(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    subjectId: string;
    connectionId: string;
    payload: AtlassianLifecycleActionRequest;
  },
) {
  const connection = await getConnectionMetadata(
    deps.db,
    input.workspaceId,
    input.connectionId,
    input.subjectId,
  );
  if (!connection) throw new HTTPException(404, { message: "Atlassian connection not found" });
  const metadata = requireAtlassianConnection(connection, input.subjectId);
  if (connection.version !== input.payload.expectedVersion) {
    throw new HTTPException(409, { message: "Atlassian connection changed" });
  }
  const target = input.payload.action === "pause" ? "paused" : "active";
  if (target === "active" && connection.status !== "active") {
    throw new HTTPException(409, { message: "Reconnect Atlassian before resuming" });
  }
  if (target === "paused") {
    await deauthorizeConnectionSources(deps, connection, input.subjectId, "connection_paused");
  }
  const updated = await transitionConnectionState(deps.db, {
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    visibleToSubjectId: input.subjectId,
    expectedVersion: connection.version,
    metadata: AtlassianConnectionMetadata.parse({ ...metadata, lifecycle: lifecycle(target) }),
    updatedBySubjectId: input.subjectId,
  });
  if (!updated) throw new HTTPException(409, { message: "Atlassian connection changed" });
  await setSchedulePause(deps, input.workspaceId, input.connectionId, target === "paused");
  return updated;
}

export async function disconnectAtlassian(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    subjectId: string;
    connection: AtlassianConnectionRecord;
    payload: AtlassianDisconnectRequest;
  },
) {
  const metadata = requireAtlassianConnection(input.connection, input.subjectId);
  try {
    await deauthorizeConnectionSources(
      deps,
      input.connection,
      input.subjectId,
      "connection_disconnected",
    );
    const disconnected = await disconnectConnectionIdempotently(deps.db, {
      accountId: input.connection.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      connectionId: input.connection.id,
      expectedVersion: input.payload.expectedVersion,
      idempotencyKey: input.payload.idempotencyKey,
      metadata: AtlassianConnectionMetadata.parse({
        ...metadata,
        lifecycle: lifecycle("disconnected"),
      }),
      lastError: null,
      updatedBySubjectId: input.subjectId,
    });
    await setSchedulePause(deps, input.workspaceId, input.connection.id, true);
    return disconnected;
  } catch (error) {
    if (error instanceof ConnectionDisconnectIdempotencyError) {
      throw new HTTPException(409, { message: "Atlassian disconnect key was already used" });
    }
    if (error instanceof ConnectionDisconnectGenerationError) {
      throw new HTTPException(409, { message: "Atlassian connection changed" });
    }
    throw error;
  }
}

export async function preflightAtlassianScheduleAuthorization(
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
  const externalSourceId = optionalString(task.metadata.externalSourceId);
  if (!externalSourceId) {
    throw new HTTPException(409, { message: "Atlassian schedule identity is incomplete" });
  }
  // Current connector attachment is not deletion authority. The frozen task
  // revision and generation-fenced cleanup descriptor are.
}

export async function revokeAtlassianScheduleAuthorization(
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
  const externalSourceId = optionalString(task.metadata.externalSourceId);
  if (!externalSourceId) {
    throw new HTTPException(409, { message: "Atlassian schedule identity is incomplete" });
  }
  await cleanupAtlassianScheduleAuthorization(deps, {
    taskId: task.id,
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    connectionId: task.action.connection.connectionId,
    connectionVersion: task.action.connection.connectionVersion,
    sourceId: task.action.sourceId,
    sourceLifecycleGeneration: task.action.sourceLifecycleGeneration,
    sourceConfigGeneration: task.action.sourceConfigGeneration,
    externalSourceId,
    subjectId: input.subjectId,
  });
}

export async function cleanupAtlassianScheduleAuthorization(
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
    let authorityVersion = input.connectionVersion;
    if (connection) {
      const metadata = requireAtlassianConnection(connection, input.subjectId);
      authorityVersion = connection.version;
      const updated = await transitionConnectionState(tx, {
        workspaceId: input.workspaceId,
        connectionId: connection.id,
        visibleToSubjectId: input.subjectId,
        expectedVersion: connection.version,
        metadata: AtlassianConnectionMetadata.parse({
          ...metadata,
          selectedSources: metadata.selectedSources.map((source) =>
            source.id === input.externalSourceId
              ? { ...source, syncEnabled: false, configGeneration: source.configGeneration + 1 }
              : source,
          ),
        }),
        updatedBySubjectId: input.subjectId,
      });
      if (!updated) throw new HTTPException(409, { message: "Atlassian connection changed" });
      authorityVersion = updated.version;
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
      throw new HTTPException(409, { message: "Atlassian knowledge source changed" });
    }
    await recordKnowledgeLifecycleEvent(tx, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      targetKind: "source",
      targetId: resolved.source.id,
      eventType: "deleted",
      expectedGeneration: resolved.source.lifecycleGeneration,
      operationId: `atlassian-schedule-delete:${input.taskId}:${authorityVersion}`,
      reasonCode: "schedule_deleted",
      actor: {
        kind: "human",
        subjectId: input.subjectId,
        initiatingHumanSubjectId: input.subjectId,
      },
    });
  });
}

async function materializeSchedules(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    connectionId: string;
    grant: AccessGrant;
    connection: AtlassianConnectionRecord;
    metadata: ReturnType<typeof AtlassianConnectionMetadata.parse>;
    previousSources: AtlassianSelectedSource[];
  },
): Promise<void> {
  const enabledSources = input.metadata.selectedSources.filter((source) => source.syncEnabled);
  const enabledIds = new Set(enabledSources.map((source) => source.id));
  const previouslyEnabled = new Set(
    input.previousSources.filter((source) => source.syncEnabled).map((source) => source.id),
  );
  const tasks = await listKnowledgeSourceSyncTasksForConnection(
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
    const identity = atlassianKnowledgeSourceIdentity({
      source: selectedSource,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      connectionSubjectId: input.subjectId,
    });
    let source = null as Awaited<ReturnType<typeof upsertKnowledgeSource>> | null;
    let existingTask: (typeof tasks)[number] | null = null;
    for (const task of tasks) {
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
        operationId: `atlassian-provider:${input.connectionId}:${identity.externalTenantId}`,
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
          operationId: `atlassian-source:${input.connectionId}:${identity.externalSourceId}`,
          actor,
        }));
    }
    if (source.lifecycleState !== "active") {
      if (previouslyEnabled.has(selectedSource.id)) continue;
      const restored = await recordKnowledgeLifecycleEvent(deps.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        targetKind: "source",
        targetId: source.id,
        eventType: "restored",
        expectedGeneration: source.lifecycleGeneration,
        operationId: `atlassian-source-restore:${source.id}:${input.connection.version}`,
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
        aclVersion: `atlassian-destination:${input.connection.version}`,
        agentAccess: false,
        operationId: `atlassian-source-acl:${source.id}`,
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
      providerCoordinationKey: `atlassian:${selectedSource.cloudId}:${selectedSource.kind}`,
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
        maxItems: 1_000,
        maxBytes: 250_000_000,
        maxFileBytes: 5_000_000,
        maxProviderRequests: 2_000,
        maxElapsedSeconds: 300,
        maxConcurrency: 4,
        maxFailureDetails: 25,
      },
    };
    let task;
    if (existingTask) {
      const previous = await captureScheduledTaskRestoreState(deps.db, existingTask);
      task = await updateScheduledTask(deps.db, input.workspaceId, existingTask.id, {
        name: `Sync ${selectedSource.kind === "jira_project" ? "Jira" : "Confluence"}: ${selectedSource.name}`,
        schedule: atlassianSchedule(selectedSource.syncCadence),
        overlapPolicy: "buffer_one",
        action,
        metadata: {
          ...existingTask.metadata,
          connectorKind: "atlassian",
          connectionId: input.connectionId,
          externalSourceId: selectedSource.id,
          knowledgeSourceSync: { sourceEnabled: true, connectionPaused: false },
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
          name: `Sync ${selectedSource.kind === "jira_project" ? "Jira" : "Confluence"}: ${selectedSource.name}`,
          status: "active",
          schedule: atlassianSchedule(selectedSource.syncCadence),
          overlapPolicy: "buffer_one",
          action,
          runMode: "new_session_per_run",
          targetSessionId: null,
          connectionAuthorities: [],
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
            connectorKind: "atlassian",
            connectionId: input.connectionId,
            externalSourceId: selectedSource.id,
            knowledgeSourceSync: { sourceEnabled: true, connectionPaused: false },
          },
        },
      });
      await syncCreatedScheduledTask({ db: deps.db, workflowClient: deps.workflowClient, task });
    }
    const token = `source-save-${input.connection.version}`;
    await deps.workflowClient.triggerScheduledTask({
      task,
      agentRunUsageIdempotencyKey: `knowledge-source-sync:initial:${task.id}:${token}`,
      triggerWorkflowId: manualScheduledTaskTriggerWorkflowId(task.id, token),
      initiator: { kind: "subject", subjectId: input.subjectId },
      triggerType: existingTask ? "repair" : "initial",
    });
  }

  for (const task of tasks) {
    if (task.action.kind !== "knowledge_source_sync") continue;
    const resolved = await getKnowledgeSourceForSyncAuthority(deps.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sourceId: task.action.sourceId,
      initiatingSubjectId: input.subjectId,
    });
    if (!resolved || enabledIds.has(resolved.source.externalSourceId)) continue;
    if (resolved.source.lifecycleState === "active") {
      await recordKnowledgeLifecycleEvent(deps.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        targetKind: "source",
        targetId: resolved.source.id,
        eventType: "deleted",
        expectedGeneration: resolved.source.lifecycleGeneration,
        operationId: `atlassian-source-deselect:${resolved.source.id}:${input.connection.version}`,
        reasonCode: "source_deselected",
        actor,
      });
    }
    const previous = await captureScheduledTaskRestoreState(deps.db, task);
    const disabled = await updateScheduledTask(deps.db, input.workspaceId, task.id, {
      metadata: {
        ...task.metadata,
        knowledgeSourceSync: { sourceEnabled: false, connectionPaused: false },
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

async function browseJiraProjects(
  deps: ApiRouteDeps,
  input: { workspaceId: string; subjectId: string; connectionId: string },
  site: AtlassianSite,
): Promise<AtlassianBrowseItem[]> {
  const items: AtlassianBrowseItem[] = [];
  let startAt = 0;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(
      `https://api.atlassian.com/ex/jira/${encodeURIComponent(site.cloudId)}/rest/api/3/project/search`,
    );
    url.searchParams.set("startAt", String(startAt));
    url.searchParams.set("maxResults", "100");
    url.searchParams.set("orderBy", "name");
    const payload = objectRecord(
      await atlassianApiRequest(deps, { ...input, url, label: "Jira projects" }),
    );
    const values = Array.isArray(payload.values) ? payload.values : [];
    for (const raw of values) {
      const row = objectRecord(raw);
      const resourceId = optionalString(row.id);
      const key = optionalString(row.key);
      const name = optionalString(row.name);
      if (!resourceId || !key || !name) continue;
      items.push({
        id: `jira_project:${site.cloudId}:${resourceId}`,
        cloudId: site.cloudId,
        siteName: site.name,
        siteUrl: site.url,
        resourceId,
        key,
        name,
        kind: "jira_project",
        description: null,
        webUrl: new URL(
          `/jira/software/c/projects/${encodeURIComponent(key)}`,
          site.url,
        ).toString(),
      });
    }
    if (payload.isLast === true || values.length === 0) break;
    startAt += values.length;
  }
  return items;
}

async function browseConfluenceSpaces(
  deps: ApiRouteDeps,
  input: { workspaceId: string; subjectId: string; connectionId: string },
  site: AtlassianSite,
): Promise<AtlassianBrowseItem[]> {
  const items: AtlassianBrowseItem[] = [];
  let url = new URL(
    `https://api.atlassian.com/ex/confluence/${encodeURIComponent(site.cloudId)}/wiki/api/v2/spaces?limit=100`,
  );
  for (let page = 0; page < 20; page += 1) {
    const payload = objectRecord(
      await atlassianApiRequest(deps, { ...input, url, label: "Confluence spaces" }),
    );
    const results = Array.isArray(payload.results) ? payload.results : [];
    for (const raw of results) {
      const row = objectRecord(raw);
      if (!isSelectableConfluenceSpaceType(row.type)) continue;
      const resourceId = optionalString(row.id);
      const key = optionalString(row.key);
      const name = optionalString(row.name);
      if (!resourceId || !key || !name) continue;
      items.push({
        id: `confluence_space:${site.cloudId}:${resourceId}`,
        cloudId: site.cloudId,
        siteName: site.name,
        siteUrl: site.url,
        resourceId,
        key,
        name,
        kind: "confluence_space",
        description: optionalString(objectRecord(row.description).plain?.toString()),
        webUrl: new URL(`/wiki/spaces/${encodeURIComponent(key)}`, site.url).toString(),
      });
    }
    const next = optionalString(objectRecord(payload._links).next);
    if (!next) break;
    url = confluenceNextUrl(site.cloudId, next);
  }
  return items;
}

export function isSelectableConfluenceSpaceType(value: unknown): boolean {
  return optionalString(value) !== "personal";
}

export function confluenceNextUrl(cloudId: string, next: string): URL {
  const apiBase = `https://api.atlassian.com/ex/confluence/${encodeURIComponent(cloudId)}`;
  const candidate = new URL(next, `${apiBase}/`);
  if (candidate.origin !== "https://api.atlassian.com") {
    throw new Error("Confluence pagination crossed the Atlassian API origin");
  }
  if (next.startsWith("/wiki/")) return new URL(`${apiBase}${next}`);
  if (!candidate.pathname.startsWith(`/ex/confluence/${encodeURIComponent(cloudId)}/`)) {
    throw new Error("Confluence pagination crossed the selected site boundary");
  }
  return candidate;
}

async function atlassianApiRequest(
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
  if (!current) throw new HTTPException(404, { message: "Atlassian connection not found" });
  requireUsableConnection(current, input.subjectId);
  const resolver = buildConnectionTokenResolver(deps.db, deps.settings, undefined, {
    ...(deps.atlassianFetch ? { refreshTransport: { fetchImpl: deps.atlassianFetch } } : {}),
  });
  const resolve = async (forceRefresh: boolean) =>
    await resolver({
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      serverId: "atlassian-source-browser",
      toolName: input.label,
      connectionRef: {
        providerDomain: ATLASSIAN_PROVIDER_DOMAIN,
        connectionId: input.connectionId,
        kind: "oauth2",
        subjectScope: "subject",
      },
      destinationUrl: input.url.toString(),
      forceRefresh,
    });
  let credential = await resolve(false);
  if (credential.status !== "ok") {
    throw new HTTPException(401, { message: "Atlassian needs to be reconnected" });
  }
  const fetchImpl = deps.atlassianFetch ?? fetch;
  let response = await providerFetch(fetchImpl, input.url, {
    headers: { ...credential.headers, accept: "application/json" },
  });
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    credential = await resolve(true);
    if (credential.status !== "ok") {
      throw new HTTPException(401, { message: "Atlassian needs to be reconnected" });
    }
    response = await providerFetch(fetchImpl, input.url, {
      headers: { ...credential.headers, accept: "application/json" },
    });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const status = response.status === 403 ? 403 : response.status === 404 ? 404 : 502;
    throw new HTTPException(status, {
      message:
        response.status === 403
          ? "Atlassian denied access to this source"
          : response.status === 404
            ? "Atlassian content was not found"
            : "Atlassian is temporarily unavailable",
    });
  }
  return await readResponseJsonBounded<unknown>(
    response,
    ATLASSIAN_MAX_RESPONSE_BYTES,
    input.label,
  );
}

async function exchangeAuthorizationCode(
  fetchImpl: FetchLike,
  input: { code: string; clientId: string; clientSecret: string; redirectUri: string },
) {
  const response = await providerFetch(fetchImpl, ATLASSIAN_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
  });
  if (!response.ok) throw new AtlassianCallbackError("token_exchange_failed");
  const payload = objectRecord(
    await readResponseJsonBounded<unknown>(
      response,
      ATLASSIAN_MAX_RESPONSE_BYTES,
      "Atlassian token response",
    ),
  );
  const accessToken = optionalString(payload.access_token);
  const refreshToken = optionalString(payload.refresh_token);
  const expiresIn = numberValue(payload.expires_in);
  if (!accessToken || !expiresIn) throw new AtlassianCallbackError("token_exchange_failed");
  return {
    accessToken,
    refreshToken: refreshToken ?? undefined,
    tokenType: optionalString(payload.token_type) ?? "Bearer",
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scopes: uniqueStrings((optionalString(payload.scope) ?? "").split(/\s+/)),
  };
}

async function fetchAtlassianProfile(fetchImpl: FetchLike, accessToken: string) {
  const response = await providerFetch(fetchImpl, ATLASSIAN_PROFILE_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!response.ok) throw new AtlassianCallbackError("identity_verification_failed");
  const payload = objectRecord(
    await readResponseJsonBounded<unknown>(
      response,
      ATLASSIAN_MAX_RESPONSE_BYTES,
      "Atlassian profile response",
    ),
  );
  const accountId = optionalString(payload.account_id);
  const displayName = optionalString(payload.name) ?? optionalString(payload.nickname);
  if (!accountId || !displayName) throw new AtlassianCallbackError("identity_verification_failed");
  return { accountId, displayName, email: optionalString(payload.email) };
}

async function fetchAccessibleSites(
  fetchImpl: FetchLike,
  accessToken: string,
): Promise<AtlassianSite[]> {
  const response = await providerFetch(fetchImpl, ATLASSIAN_RESOURCES_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!response.ok) throw new AtlassianCallbackError("site_verification_failed");
  const payload = await readResponseJsonBounded<unknown>(
    response,
    ATLASSIAN_MAX_RESPONSE_BYTES,
    "Atlassian accessible resources",
  );
  if (!Array.isArray(payload)) throw new AtlassianCallbackError("site_verification_failed");
  const merged = new Map<string, AtlassianSite>();
  for (const raw of payload) {
    const row = objectRecord(raw);
    const cloudId = optionalString(row.id);
    const name = optionalString(row.name);
    const url = optionalString(row.url);
    const scopes = Array.isArray(row.scopes)
      ? row.scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
    if (!cloudId || !name || !url) continue;
    const products: Array<"jira" | "confluence"> = [];
    if (scopes.some((scope) => scope.includes(":jira") || scope.includes("jira-")))
      products.push("jira");
    if (scopes.some((scope) => scope.includes(":confluence") || scope.includes("confluence-"))) {
      products.push("confluence");
    }
    if (products.length === 0) continue;
    const key = `${cloudId}:${url}`;
    const previous = merged.get(key);
    merged.set(key, {
      cloudId,
      name,
      url: new URL(url).toString(),
      products: [...new Set([...(previous?.products ?? []), ...products])],
    });
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function deauthorizeConnectionSources(
  deps: ApiRouteDeps,
  connection: AtlassianConnectionRecord,
  subjectId: string,
  reasonCode: string,
): Promise<void> {
  const tasks = await listKnowledgeSourceSyncTasksForConnection(
    deps.db,
    connection.workspaceId,
    connection.id,
  );
  for (const task of tasks) {
    if (task.action.kind !== "knowledge_source_sync") continue;
    const resolved = await getKnowledgeSourceForSyncAuthority(deps.db, {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      sourceId: task.action.sourceId,
      initiatingSubjectId: subjectId,
    });
    if (!resolved || resolved.source.lifecycleState !== "active") continue;
    await deauthorizeKnowledgeSourceRetrieval(deps.db, {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      sourceId: task.action.sourceId,
      audience: task.action.destination,
      operationId: `atlassian-deauthorize:${connection.id}:${connection.version + 1}:${task.action.sourceId}:${reasonCode}`,
      reasonCode,
      actor: { kind: "human", subjectId, initiatingHumanSubjectId: subjectId },
    });
  }
}

async function setSchedulePause(
  deps: ApiRouteDeps,
  workspaceId: string,
  connectionId: string,
  paused: boolean,
): Promise<void> {
  const tasks = await listKnowledgeSourceSyncTasksForConnection(deps.db, workspaceId, connectionId);
  for (const task of tasks) {
    const previous = await captureScheduledTaskRestoreState(deps.db, task);
    const control = objectRecord(task.metadata.knowledgeSourceSync);
    const updated = await updateScheduledTask(deps.db, workspaceId, task.id, {
      metadata: {
        ...task.metadata,
        knowledgeSourceSync: { ...control, connectionPaused: paused },
      },
    });
    await syncUpdatedScheduledTask({
      db: deps.db,
      workflowClient: deps.workflowClient,
      previous,
      task: updated,
    });
  }
}

function requireAtlassianConnection(connection: AtlassianConnectionRecord, subjectId: string) {
  const metadata = AtlassianConnectionMetadata.safeParse(connection.metadata);
  if (
    connection.subjectId !== subjectId ||
    connection.providerDomain !== ATLASSIAN_PROVIDER_DOMAIN ||
    connection.kind !== "oauth2" ||
    !metadata.success
  ) {
    throw new HTTPException(422, { message: "connection is not this user's Atlassian account" });
  }
  return metadata.data;
}

function requireUsableConnection(connection: AtlassianConnectionRecord, subjectId: string) {
  const metadata = requireAtlassianConnection(connection, subjectId);
  if (
    connection.status !== "active" ||
    (metadata.lifecycle?.state && metadata.lifecycle.state !== "active")
  ) {
    throw new HTTPException(409, { message: "Atlassian must be reconnected or resumed" });
  }
  if (!atlassianScopesAllowRead(connection.grantedScopes)) {
    throw new HTTPException(401, { message: "Atlassian needs permission re-consent" });
  }
  return metadata;
}

function readAtlassianOAuthState(raw: string | undefined, settings: Settings): AtlassianOAuthState {
  if (!raw) throw new HTTPException(400, { message: "missing Atlassian OAuth state" });
  const payload = readSignedState(raw, requireIntegrationsStateSecret(settings)) as Record<
    string,
    unknown
  > | null;
  if (!payload) throw new HTTPException(400, { message: "invalid Atlassian OAuth state" });
  const iat = numberValue(payload.iat);
  const now = Math.floor(Date.now() / 1000);
  if (iat === undefined || now < iat || now - iat > oauthStateTtlMs / 1_000) {
    throw new HTTPException(400, { message: "expired Atlassian OAuth state" });
  }
  // Reject a state minted by any other flow before reading anything else. A
  // pre-cutover state carries no kind and is refused; that is the same bounded
  // `oauthStateTtlMs` window the personal-owner claim already fails closed on.
  if (payload.kind !== ATLASSIAN_OAUTH_STATE_KIND) {
    throw new HTTPException(400, { message: "invalid Atlassian OAuth state" });
  }
  const accountId = requiredString(payload.accountId, "state.accountId");
  const workspaceId = requiredString(payload.workspaceId, "state.workspaceId");
  const subjectId = requiredString(payload.subjectId, "state.subjectId");
  const returnPath = requiredString(payload.returnPath, "state.returnPath");
  if (returnPath !== ATLASSIAN_RETURN_PATH(workspaceId)) {
    throw new HTTPException(400, { message: "invalid Atlassian OAuth return path" });
  }
  const connectionId = optionalString(payload.connectionId) ?? undefined;
  const connectionVersion = numberValue(payload.connectionVersion);
  if (Boolean(connectionId) !== Boolean(connectionVersion)) {
    throw new HTTPException(400, { message: "invalid Atlassian reconnect state" });
  }
  return {
    accountId,
    workspaceId,
    subjectId,
    personalOwnerVerified: personalOwnerVerifiedInState(payload),
    returnPath,
    ...(connectionId ? { connectionId, connectionVersion: connectionVersion! } : {}),
    nonce: requiredString(payload.nonce, "state.nonce"),
    iat,
  };
}

async function requireCallbackGrant(deps: ApiRouteDeps, state: AtlassianOAuthState): Promise<void> {
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
      message: personalOnlyConnectionPrincipalMessage("Atlassian"),
    });
  }
  const grant = await getWorkspaceGrant(deps.db, state.subjectId, state.workspaceId);
  if (
    !grant ||
    grant.accountId !== state.accountId ||
    !hasPermission(grant.permissions, "connections:write")
  ) {
    throw new HTTPException(403, { message: "Atlassian OAuth subject no longer has access" });
  }
}

function requireAtlassianSettings(settings: Settings) {
  const clientId = settings.atlassianClientId?.trim();
  const clientSecret = settings.atlassianClientSecret?.trim();
  if (!clientId || !clientSecret) {
    throw new HTTPException(503, {
      message:
        "Atlassian requires OPENGENI_ATLASSIAN_CLIENT_ID and OPENGENI_ATLASSIAN_CLIENT_SECRET",
    });
  }
  return { clientId, clientSecret };
}

function lifecycle(state: AtlassianConnectionLifecycle["state"]): AtlassianConnectionLifecycle {
  return AtlassianConnectionLifecycle.parse({
    state,
    recoverable: state !== "app_removed",
    observedAt: new Date().toISOString(),
  });
}

function atlassianSchedule(cadence: "manual" | "hourly" | "daily"): ScheduledTaskScheduleSpec {
  if (cadence === "manual") return { type: "manual" };
  if (cadence === "hourly") return { type: "interval", everySeconds: 3_600 };
  return { type: "calendar", timeZone: "UTC", hour: 0, minute: 0 };
}

async function providerFetch(fetchImpl: FetchLike, url: string | URL, init: RequestInit) {
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(ATLASSIAN_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new HTTPException(502, { message: "Atlassian is temporarily unavailable" });
  }
}

function returnUrl(base: string, path: string, status: "connected" | "error", value: string) {
  const url = new URL(path, base);
  url.searchParams.set("atlassian", status);
  url.searchParams.set(status === "connected" ? "connectionId" : "reason", value);
  return url.toString();
}

function errorReason(error: unknown): string {
  if (error instanceof AtlassianCallbackError) return error.reason;
  if (error instanceof HTTPException) return `http_${error.status}`;
  return "connection_failed";
}

class AtlassianCallbackError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "AtlassianCallbackError";
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
  const result = optionalString(value);
  if (!result) throw new HTTPException(400, { message: `${label} is invalid` });
  return result;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function groupSourcesByCloudId(
  sources: AtlassianSelectedSource[],
): Array<[string, AtlassianSelectedSource[]]> {
  const grouped = new Map<string, AtlassianSelectedSource[]>();
  for (const source of sources) {
    grouped.set(source.cloudId, [...(grouped.get(source.cloudId) ?? []), source]);
  }
  return [...grouped.entries()];
}

function jqlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function cqlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function readJiraLiveComments(
  deps: ApiRouteDeps,
  input: { workspaceId: string; subjectId: string; connectionId: string; id: string },
  cloudId: string,
) {
  const comments: Array<{ author: string | null; createdAt: string | null; body: string }> = [];
  let startAt = 0;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(
      `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/issue/${encodeURIComponent(input.id)}/comment`,
    );
    url.searchParams.set("startAt", String(startAt));
    url.searchParams.set("maxResults", "100");
    url.searchParams.set("orderBy", "created");
    const payload = objectRecord(
      await atlassianApiRequest(deps, { ...input, url, label: "Jira live comments" }),
    );
    const rows = Array.isArray(payload.comments) ? payload.comments : [];
    for (const raw of rows) {
      const row = objectRecord(raw);
      comments.push({
        author: optionalString(objectRecord(row.author).displayName),
        createdAt: optionalString(row.created),
        body: adfText(row.body),
      });
    }
    const total = numberValue(payload.total) ?? comments.length;
    if (comments.length >= total || rows.length === 0) break;
    startAt += rows.length;
  }
  return comments;
}

async function readConfluenceLiveComments(
  deps: ApiRouteDeps,
  input: { workspaceId: string; subjectId: string; connectionId: string; id: string },
  cloudId: string,
) {
  const comments: Array<{ createdAt: string | null; content: string }> = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(
      `https://api.atlassian.com/ex/confluence/${encodeURIComponent(cloudId)}/wiki/api/v2/pages/${encodeURIComponent(input.id)}/footer-comments`,
    );
    url.searchParams.set("body-format", "storage");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const payload = objectRecord(
      await atlassianApiRequest(deps, { ...input, url, label: "Confluence live comments" }),
    );
    for (const raw of Array.isArray(payload.results) ? payload.results : []) {
      const row = objectRecord(raw);
      comments.push({
        createdAt: optionalString(objectRecord(row.version).createdAt),
        content: optionalString(objectRecord(objectRecord(row.body).storage).value) ?? "",
      });
    }
    const next = optionalString(objectRecord(payload._links).next);
    if (!next) break;
    const nextUrl = confluenceNextUrl(cloudId, next);
    cursor = nextUrl.searchParams.get("cursor");
    if (!cursor) break;
  }
  return comments;
}

function adfText(value: unknown): string {
  const node = objectRecord(value);
  if (node.type === "text") return typeof node.text === "string" ? node.text : "";
  const children = Array.isArray(node.content) ? node.content.map(adfText).join("") : "";
  if (node.type === "paragraph" || node.type === "heading" || node.type === "listItem") {
    return `${children.trim()}\n`;
  }
  if (node.type === "hardBreak") return "\n";
  return children;
}
