import type {
  ApiIntegrationInstallationSummary,
  ApiIntegrationPreview,
  ApiIntegrationSource,
  ConnectionMetadata,
  ConnectionOwnership,
  CreateConnectionRequest,
} from "@/types";

export type CustomApiProtocol = "auto" | "openapi" | "graphql";
export type CustomApiAuthMethod = "bearer" | "basic" | "api_key";
export type CustomApiIntent = "create" | "update" | "reconnect";
export type CustomApiPhase =
  | "source"
  | "previewing"
  | "review"
  | "auth"
  | "creating_connection"
  | "installing";

export type CustomApiDraft = {
  url: string;
  advanced: boolean;
  protocol: CustomApiProtocol;
  openApiUrl: string;
  baseUrl: string;
  graphqlEndpoint: string;
  graphqlName: string;
  displayName: string;
  ownership: ConnectionOwnership;
  connectionMode: "new" | "existing";
  existingConnectionId: string;
  accountLabel: string;
  authMethod: CustomApiAuthMethod;
  credentialName: string;
  credentialCarrier: "header" | "query" | "cookie";
  credentialValue: string;
  username: string;
  password: string;
};

export type CustomApiFlowState = {
  open: boolean;
  phase: CustomApiPhase;
  intent: CustomApiIntent;
  draft: CustomApiDraft;
  preview: ApiIntegrationPreview | null;
  selectedTools: string[];
  connection: ConnectionMetadata | null;
  editingInstance: ApiIntegrationInstallationSummary | null;
  error: string | null;
};

export type CustomApiFlowAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "new"; draft?: Partial<CustomApiDraft> }
  | {
      type: "edit";
      intent: Exclude<CustomApiIntent, "create">;
      instance: ApiIntegrationInstallationSummary;
      connection: ConnectionMetadata | null;
    }
  | { type: "draft"; patch: Partial<CustomApiDraft> }
  | { type: "phase"; phase: CustomApiPhase; error?: string | null }
  | { type: "preview"; preview: ApiIntegrationPreview; connection?: ConnectionMetadata | null }
  | { type: "preview_error"; message: string; authenticationMayBeRequired: boolean }
  | { type: "connection"; connection: ConnectionMetadata }
  | { type: "tools"; selectedTools: string[] }
  | { type: "reset" };

export function emptyCustomApiDraft(): CustomApiDraft {
  return {
    url: "",
    advanced: false,
    protocol: "auto",
    openApiUrl: "",
    baseUrl: "",
    graphqlEndpoint: "",
    graphqlName: "",
    displayName: "",
    ownership: "personal",
    connectionMode: "new",
    existingConnectionId: "",
    accountLabel: "",
    authMethod: "bearer",
    credentialName: "Authorization",
    credentialCarrier: "header",
    credentialValue: "",
    username: "",
    password: "",
  };
}

export function initialCustomApiFlowState(): CustomApiFlowState {
  return {
    open: false,
    phase: "source",
    intent: "create",
    draft: emptyCustomApiDraft(),
    preview: null,
    selectedTools: [],
    connection: null,
    editingInstance: null,
    error: null,
  };
}

export function customApiFlowReducer(
  state: CustomApiFlowState,
  action: CustomApiFlowAction,
): CustomApiFlowState {
  switch (action.type) {
    case "open":
      return { ...state, open: true };
    case "close":
      return { ...state, open: false };
    case "new":
      return {
        ...initialCustomApiFlowState(),
        open: true,
        draft: { ...emptyCustomApiDraft(), ...action.draft },
      };
    case "edit": {
      const draft = customApiDraftForInstance(action.instance);
      return {
        ...initialCustomApiFlowState(),
        open: true,
        phase: action.intent === "reconnect" ? "auth" : "source",
        intent: action.intent,
        draft: {
          ...draft,
          connectionMode: action.intent === "reconnect" ? "new" : "existing",
          existingConnectionId: action.connection?.id ?? "",
          ownership: action.instance.ownership === "personal" ? "personal" : "workspace",
          accountLabel: `${action.instance.displayName} credential`,
        },
        connection: action.intent === "update" ? action.connection : null,
        editingInstance: action.instance,
      };
    }
    case "draft":
      return { ...state, draft: { ...state.draft, ...action.patch } };
    case "phase":
      return {
        ...state,
        phase: action.phase,
        ...(action.phase === "previewing" ? { preview: null, selectedTools: [] } : {}),
        error: action.error === undefined ? state.error : action.error,
      };
    case "preview": {
      const availableTools = action.preview.tools
        .filter((tool) => !tool.deprecated)
        .map((tool) => tool.id);
      const availableToolSet = new Set(availableTools);
      const selectedTools = state.editingInstance
        ? state.editingInstance.allowedTools.filter((tool) => availableToolSet.has(tool))
        : availableTools;
      return {
        ...state,
        phase: "review",
        preview: action.preview,
        selectedTools,
        connection: action.connection === undefined ? state.connection : action.connection,
        draft: {
          ...state.draft,
          displayName: state.draft.displayName.trim() || action.preview.name,
        },
        error: null,
      };
    }
    case "preview_error":
      return {
        ...state,
        phase: action.authenticationMayBeRequired ? "auth" : "source",
        error: action.message,
      };
    case "connection":
      return {
        ...state,
        connection: action.connection,
        draft: {
          ...state.draft,
          connectionMode: "existing",
          existingConnectionId: action.connection.id,
          credentialValue: "",
          username: "",
          password: "",
        },
        error: null,
      };
    case "tools":
      return { ...state, selectedTools: [...action.selectedTools] };
    case "reset":
      return initialCustomApiFlowState();
  }
}

export function customApiSourceFromDraft(draft: CustomApiDraft): ApiIntegrationSource {
  if (draft.protocol === "openapi") {
    const url = normalizeCustomApiUrl(draft.openApiUrl || draft.url);
    const baseUrl = optionalCustomApiUrl(draft.baseUrl);
    return { kind: "openapi", url, ...(baseUrl ? { baseUrl } : {}) };
  }
  if (draft.protocol === "graphql") {
    const endpoint = normalizeCustomApiUrl(draft.graphqlEndpoint || draft.url);
    const name = draft.graphqlName.trim();
    return { kind: "graphql", endpoint, ...(name ? { name } : {}) };
  }
  const url = normalizeCustomApiUrl(draft.url);
  const baseUrl = optionalCustomApiUrl(draft.baseUrl);
  return { kind: "auto", url, ...(baseUrl ? { baseUrl } : {}) };
}

export function customApiDraftForInstance(
  instance: ApiIntegrationInstallationSummary,
): CustomApiDraft {
  const draft = emptyCustomApiDraft();
  if (instance.protocol === "graphql") {
    return {
      ...draft,
      advanced: true,
      protocol: "graphql",
      url: instance.baseUrl,
      graphqlEndpoint: instance.baseUrl,
      graphqlName: instance.displayName,
      displayName: instance.displayName,
    };
  }
  return {
    ...draft,
    advanced: true,
    protocol: "openapi",
    url: instance.sourceUrl ?? instance.baseUrl,
    openApiUrl: instance.sourceUrl ?? instance.baseUrl,
    baseUrl: instance.baseUrl,
    displayName: instance.displayName,
  };
}

export function normalizeCustomApiUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter an API URL or domain.");
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Custom APIs must use HTTP or HTTPS.");
  }
  url.hash = "";
  return url.toString();
}

function optionalCustomApiUrl(value: string): string | undefined {
  return value.trim() ? normalizeCustomApiUrl(value) : undefined;
}

export function customApiProviderDomain(draft: CustomApiDraft): string {
  const source = customApiSourceFromDraft(draft);
  const value =
    source.kind === "graphql"
      ? source.endpoint
      : source.kind === "openapi" || source.kind === "auto"
        ? source.url
        : (() => {
            throw new Error("A provider preset is not a custom API source.");
          })();
  return new URL(value).hostname.toLowerCase();
}

export function customApiAuthenticationMayBeRequired(
  source: ApiIntegrationSource,
  error: unknown,
): boolean {
  if (source.kind !== "graphql" && source.kind !== "auto") return false;
  const message = error instanceof Error ? error.message : String(error);
  return /graphql|introspection|supported openapi document/i.test(message);
}

export function connectionOwnership(connection: ConnectionMetadata): ConnectionOwnership {
  return connection.subjectId ? "personal" : "workspace";
}

export function compatibleCustomApiConnections(
  connections: ConnectionMetadata[] | null,
  providerDomain: string,
  ownership: ConnectionOwnership,
  preview: ApiIntegrationPreview | null,
  authMethod: CustomApiAuthMethod = "bearer",
): ConnectionMetadata[] {
  if (!connections) return [];
  const compatibleKinds = compatibleConnectionKinds(preview, authMethod);
  return connections.filter(
    (connection) =>
      connection.status === "active" &&
      connection.providerDomain.toLowerCase() === providerDomain.toLowerCase() &&
      connectionOwnership(connection) === ownership &&
      compatibleKinds.has(connection.kind),
  );
}

function compatibleConnectionKinds(
  preview: ApiIntegrationPreview | null,
  authMethod: CustomApiAuthMethod,
): ReadonlySet<ConnectionMetadata["kind"]> {
  if (!preview) {
    return authMethod === "bearer"
      ? new Set<ConnectionMetadata["kind"]>(["api_key", "oauth2"])
      : new Set<ConnectionMetadata["kind"]>(["api_key"]);
  }
  if (preview.auth.kind === "oauth2") {
    return new Set<ConnectionMetadata["kind"]>(["oauth2"]);
  }
  if (preview.auth.kind === "api_key" || preview.auth.kind === "http") {
    return new Set<ConnectionMetadata["kind"]>(["api_key"]);
  }
  return new Set<ConnectionMetadata["kind"]>();
}

export function customApiInstallValidationError(state: CustomApiFlowState): string | null {
  if (!state.preview) return "Preview the API before installing.";
  if (state.preview.auth.kind !== "none" && !state.connection) {
    return "Connect an account before installing this API.";
  }
  if (!state.draft.displayName.trim()) return "Enter an instance label before installing.";
  if (state.selectedTools.length === 0) {
    return "Select at least one tool before installing. An empty selection is never treated as all tools.";
  }
  return null;
}

export function customApiAuthenticationStepRequired(state: CustomApiFlowState): boolean {
  if (state.phase === "auth") return true;
  return Boolean(state.preview && state.preview.auth.kind !== "none" && !state.connection);
}

export function customApiConnectionLabel(connection: ConnectionMetadata): string {
  const metadata = connection.metadata;
  for (const key of [
    "credentialLabel",
    "providerDisplayName",
    "providerEmail",
    "accountLabel",
    "name",
  ]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const ownership = connection.subjectId ? "Personal" : "Workspace";
  const created = new Date(connection.createdAt);
  const date = Number.isNaN(created.getTime())
    ? "existing credential"
    : created.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return `${ownership} ${connection.kind === "oauth2" ? "token" : "credential"} · ${date}`;
}

export function customApiConnectionRequest(input: {
  preview: ApiIntegrationPreview | null;
  draft: CustomApiDraft;
  providerDomain: string;
}): CreateConnectionRequest {
  const { preview, draft, providerDomain } = input;
  const label =
    draft.accountLabel.trim() || `${draft.displayName.trim() || providerDomain} credential`;
  if (preview?.auth.kind === "oauth2") {
    const accessToken = requiredSecret(draft.credentialValue, "Enter the bearer access token.");
    return {
      providerDomain,
      kind: "oauth2",
      ownership: draft.ownership,
      credential: { access_token: accessToken, token_type: "Bearer" },
      grantedScopes: [...preview.auth.scopes],
      metadata: { credentialLabel: label, credentialRole: "api_integration_manual" },
    };
  }

  const placement = credentialPlacement(preview, draft);
  return {
    providerDomain,
    kind: "api_key",
    ownership: draft.ownership,
    credential: { placements: [placement] },
    grantedScopes: [],
    metadata: {
      credentialLabel: label,
      credentialRole: "api_integration_manual",
      authentication: draft.authMethod,
    },
  };
}

function credentialPlacement(
  preview: ApiIntegrationPreview | null,
  draft: CustomApiDraft,
): { carrier: "header" | "query" | "cookie"; name: string; value: string; prefix?: string } {
  if (preview?.auth.kind === "api_key") {
    return {
      carrier: preview.auth.carrier,
      name: preview.auth.name,
      value: requiredSecret(draft.credentialValue, `Enter the ${preview.auth.name} value.`),
    };
  }
  if (preview?.auth.kind === "http") {
    const scheme = preview.auth.scheme.trim();
    if (/^basic$/i.test(scheme)) return basicPlacement(draft);
    return {
      carrier: "header",
      name: "Authorization",
      value: requiredSecret(draft.credentialValue, `Enter the ${scheme} credential.`),
      prefix: `${/^bearer$/i.test(scheme) ? "Bearer" : scheme} `,
    };
  }
  if (draft.authMethod === "basic") return basicPlacement(draft);
  if (draft.authMethod === "api_key") {
    const name = draft.credentialName.trim();
    if (!name) throw new Error("Enter the credential name.");
    return {
      carrier: draft.credentialCarrier,
      name,
      value: requiredSecret(draft.credentialValue, "Enter the API credential value."),
    };
  }
  return {
    carrier: "header",
    name: "Authorization",
    value: requiredSecret(draft.credentialValue, "Enter the bearer token."),
    prefix: "Bearer ",
  };
}

function basicPlacement(draft: CustomApiDraft) {
  const username = draft.username.trim();
  if (!username) throw new Error("Enter the HTTP Basic username.");
  const password = requiredSecret(draft.password, "Enter the HTTP Basic password.");
  return {
    carrier: "header" as const,
    name: "Authorization",
    value: utf8Base64(`${username}:${password}`),
    prefix: "Basic ",
  };
}

function requiredSecret(value: string, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function customApiPreviewDiff(
  instance: ApiIntegrationInstallationSummary | null,
  preview: ApiIntegrationPreview,
): {
  digestChanged: boolean;
  addedTools: string[];
  removedTools: string[];
  unchangedTools: number;
} | null {
  if (!instance) return null;
  const before = new Set(instance.allowedTools);
  const after = new Set(preview.tools.filter((tool) => !tool.deprecated).map((tool) => tool.id));
  return {
    digestChanged: instance.contentSha256 !== preview.contentSha256,
    addedTools: [...after].filter((tool) => !before.has(tool)).sort(),
    removedTools: [...before].filter((tool) => !after.has(tool)).sort(),
    unchangedTools: [...after].filter((tool) => before.has(tool)).length,
  };
}
