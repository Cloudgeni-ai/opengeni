import { IntegrationProtocolError } from "./types";
import { isRecord } from "@opengeni/contracts/values";

export interface IntegrationDefinitionOAuth2Authentication {
  readonly kind: "oauth2";
  readonly provider: "google" | "microsoft";
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
  readonly tokenPlacement: {
    readonly carrier: "header";
    readonly name: "Authorization";
    readonly prefix: "Bearer ";
  };
}

export type IntegrationDefinitionSource =
  | Readonly<{
      kind: "google_discovery";
      url: string;
    }>
  | Readonly<{
      kind: "openapi";
      url: string;
      operationPathPrefixes?: readonly string[];
      /** Exact reviewed operations; never admit newly added provider methods implicitly. */
      operationAllowlist?: readonly Readonly<{
        path: string;
        method: "get" | "post" | "patch";
        /** Provider metadata often omits delegated scopes; bind the reviewed requirement. */
        requiredScopes?: readonly string[];
        /** Support the opaque continuation token without accepting arbitrary URLs. */
        odataSkipToken?: boolean;
        /**
         * A reviewed provider action that only reads (for example a POST search).
         * Only this reviewed list can relax the HTTP-method safety default.
         */
        readOnly?: true;
        /**
         * For a reviewed read-only Microsoft Search operation: the only entity
         * types a request may name. Other requests are rejected before any
         * credential is resolved, so other granted scopes stay behind their tools.
         */
        searchEntityTypes?: readonly string[];
        /** Reviewed guidance that replaces the provider's generic description. */
        description?: string;
      }>[];
      excludedOperationPathPrefixes?: readonly string[];
      /** Expose JSON bodies without expanding the provider entity graph. */
      schemaMode?: "provider_validated_json";
    }>;

export interface IntegrationDefinition {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly protocol: "openapi";
  readonly provider: Readonly<{
    id: "google" | "microsoft";
    domain: string;
  }>;
  readonly source: IntegrationDefinitionSource;
  readonly baseUrl: string;
  readonly authentication: IntegrationDefinitionOAuth2Authentication;
  readonly healthCheck?: Readonly<{
    operationKey: string;
    arguments: Readonly<Record<string, unknown>>;
  }>;
  readonly facets: readonly IntegrationFacetDefinition[];
  /**
   * @deprecated Retained for source compatibility. Provider recommendations
   * never prevent an authorized user from choosing Allow, Ask, or Block.
   */
  readonly autoApproval?: Readonly<{
    forbiddenOperationKeys: readonly string[] | "all";
  }>;
}

export interface IntegrationFacetDefinition {
  readonly facetKey: string;
  readonly kind: "knowledge_source" | "inbound_trigger" | "delivery_destination" | "identity_link";
  readonly configSchema: Readonly<Record<string, unknown>>;
  readonly capabilities: Readonly<Record<string, unknown>>;
}

const accountIdentityFacet = (provider: "google" | "microsoft"): IntegrationFacetDefinition => ({
  facetKey: "account-identity",
  kind: "identity_link",
  configSchema: { type: "object", properties: {}, additionalProperties: false },
  capabilities: {
    provider,
    connectionRequired: true,
    identity: "connected_account",
  },
});

const driveKnowledgeFacet = (
  provider: "google-drive" | "microsoft-onedrive",
): IntegrationFacetDefinition => ({
  facetKey: "drive-content",
  kind: "knowledge_source",
  configSchema: {
    type: "object",
    required: ["sources", "destination", "syncCadence", "readPolicy"],
    properties: {
      sources: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          required: ["id", "name", "mimeType", "sourceKind", "includeDescendants"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 512 },
            name: { type: "string", minLength: 1, maxLength: 1024 },
            mimeType: { type: "string", minLength: 1, maxLength: 256 },
            driveId: { type: "string", minLength: 1, maxLength: 512 },
            sourceKind: {
              type: "string",
              enum:
                provider === "google-drive"
                  ? ["my_drive", "shared_drive", "folder"]
                  : ["my_drive", "shared_library", "folder"],
            },
            includeDescendants: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      destination: {
        type: "object",
        required: ["authorityKind", "authorityAccountId"],
        properties: {
          authorityKind: {
            type: "string",
            enum: ["organization", "workspace", "personal"],
          },
          authorityAccountId: { type: "string", minLength: 1, maxLength: 128 },
          authorityWorkspaceId: { type: "string", minLength: 1, maxLength: 128 },
          authoritySubjectId: { type: "string", minLength: 1, maxLength: 512 },
          collectionId: { type: "string", minLength: 1, maxLength: 512 },
        },
        additionalProperties: false,
      },
      syncCadence: { type: "string", enum: ["manual", "hourly", "daily"] },
      readPolicy: { type: "string", enum: ["allow", "ask", "block"] },
    },
    additionalProperties: false,
  },
  capabilities: {
    provider,
    connectionRequired: true,
    sync: "incremental",
    cursor: provider === "google-drive" ? "page_token" : "delta_link",
  },
});

const mailboxFacets = (
  provider: "microsoft-outlook-mail",
): readonly IntegrationFacetDefinition[] => [
  {
    facetKey: "mail-inbox",
    kind: "inbound_trigger",
    configSchema: {
      type: "object",
      properties: {
        folder: { type: "string", minLength: 1, maxLength: 256 },
        unreadOnly: { type: "boolean" },
      },
      additionalProperties: false,
    },
    capabilities: {
      provider,
      connectionRequired: true,
      delivery: "poll",
      cursor: "delta_link",
    },
  },
  {
    facetKey: "mail-delivery",
    kind: "delivery_destination",
    configSchema: {
      type: "object",
      properties: {
        fromAlias: { type: "string", minLength: 1, maxLength: 512 },
        saveToSent: { type: "boolean" },
      },
      additionalProperties: false,
    },
    capabilities: {
      provider,
      connectionRequired: true,
      delivery: "email",
    },
  },
  accountIdentityFacet("microsoft"),
];

const googleDiscoveryUrl = (service: string, version: string): string =>
  `https://www.googleapis.com/discovery/v1/apis/${service}/${version}/rest`;

const googleOAuth = (scopes: readonly string[]): IntegrationDefinitionOAuth2Authentication => ({
  kind: "oauth2",
  provider: "google",
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: ["openid", "email", "profile", ...scopes],
  tokenPlacement: { carrier: "header", name: "Authorization", prefix: "Bearer " },
});

export const GOOGLE_DRIVE_INTEGRATION_DEFINITION: IntegrationDefinition = {
  id: "google-drive",
  name: "Google Drive",
  summary: "Files, folders, permissions, and shared drives.",
  protocol: "openapi",
  provider: { id: "google", domain: "www.googleapis.com" },
  source: { kind: "google_discovery", url: googleDiscoveryUrl("drive", "v3") },
  baseUrl: "https://www.googleapis.com/drive/v3/",
  authentication: googleOAuth(["https://www.googleapis.com/auth/drive"]),
  healthCheck: {
    operationKey: "drive.about.get",
    arguments: { query: { fields: "user" } },
  },
  facets: [driveKnowledgeFacet("google-drive"), accountIdentityFacet("google")],
};

export const MICROSOFT_GRAPH_OPENAPI_URL =
  "https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/master/openapi/v1.0/openapi.yaml";
export const MICROSOFT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

const microsoftOAuth = (scopes: readonly string[]): IntegrationDefinitionOAuth2Authentication => ({
  kind: "oauth2",
  provider: "microsoft",
  authorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  scopes: ["offline_access", "User.Read", ...scopes],
  tokenPlacement: { carrier: "header", name: "Authorization", prefix: "Bearer " },
});

export const MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION: IntegrationDefinition = {
  id: "microsoft-outlook-mail",
  name: "Outlook Mail",
  summary: "Messages, folders, attachments, settings, and sending mail.",
  protocol: "openapi",
  provider: { id: "microsoft", domain: "graph.microsoft.com" },
  source: {
    kind: "openapi",
    url: MICROSOFT_GRAPH_OPENAPI_URL,
    schemaMode: "provider_validated_json",
    operationPathPrefixes: [
      "/me/messages",
      "/me/mailFolders",
      "/me/sendMail",
      "/me/getMailTips",
      "/me/inferenceClassification",
      "/me/mailboxSettings",
      "/me/outlook",
    ],
  },
  baseUrl: MICROSOFT_GRAPH_BASE_URL,
  authentication: microsoftOAuth(["Mail.ReadWrite", "Mail.Send", "MailboxSettings.ReadWrite"]),
  facets: mailboxFacets("microsoft-outlook-mail"),
};

export const MICROSOFT_OUTLOOK_CALENDAR_INTEGRATION_DEFINITION: IntegrationDefinition = {
  id: "microsoft-outlook-calendar",
  name: "Outlook Calendar",
  summary: "Calendars, events, availability, and scheduling.",
  protocol: "openapi",
  provider: { id: "microsoft", domain: "graph.microsoft.com" },
  source: {
    kind: "openapi",
    url: MICROSOFT_GRAPH_OPENAPI_URL,
    schemaMode: "provider_validated_json",
    operationPathPrefixes: [
      "/me/calendar",
      "/me/calendars",
      "/me/calendarGroups",
      "/me/calendarView",
      "/me/events",
      "/me/reminderView",
    ],
  },
  baseUrl: MICROSOFT_GRAPH_BASE_URL,
  authentication: microsoftOAuth(["Calendars.ReadWrite"]),
  facets: [
    {
      facetKey: "calendar-events",
      kind: "inbound_trigger",
      configSchema: {
        type: "object",
        properties: {
          calendarId: { type: "string", minLength: 1, maxLength: 512 },
          lookaheadDays: { type: "integer", minimum: 1, maximum: 365 },
        },
        additionalProperties: false,
      },
      capabilities: {
        provider: "microsoft-outlook-calendar",
        connectionRequired: true,
        delivery: "poll",
        cursor: "delta_link",
      },
    },
    {
      facetKey: "calendar-delivery",
      kind: "delivery_destination",
      configSchema: {
        type: "object",
        properties: {
          calendarId: { type: "string", minLength: 1, maxLength: 512 },
        },
        additionalProperties: false,
      },
      capabilities: {
        provider: "microsoft-outlook-calendar",
        connectionRequired: true,
        delivery: "calendar_event",
      },
    },
    accountIdentityFacet("microsoft"),
  ],
};

export const MICROSOFT_OUTLOOK_CONTACTS_INTEGRATION_DEFINITION: IntegrationDefinition = {
  id: "microsoft-outlook-contacts",
  name: "Outlook Contacts",
  summary: "Contacts, contact folders, and people suggestions.",
  protocol: "openapi",
  provider: { id: "microsoft", domain: "graph.microsoft.com" },
  source: {
    kind: "openapi",
    url: MICROSOFT_GRAPH_OPENAPI_URL,
    schemaMode: "provider_validated_json",
    operationPathPrefixes: ["/me/contacts", "/me/contactFolders", "/me/people"],
  },
  baseUrl: MICROSOFT_GRAPH_BASE_URL,
  authentication: microsoftOAuth(["Contacts.ReadWrite", "People.Read"]),
  facets: [accountIdentityFacet("microsoft")],
};

export const MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION: IntegrationDefinition = {
  id: "microsoft-onedrive",
  name: "OneDrive",
  summary: "Drives, files, folders, sharing links, and permissions.",
  protocol: "openapi",
  provider: { id: "microsoft", domain: "graph.microsoft.com" },
  source: {
    kind: "openapi",
    url: MICROSOFT_GRAPH_OPENAPI_URL,
    schemaMode: "provider_validated_json",
    operationPathPrefixes: ["/me/drive", "/me/drives", "/drives", "/shares"],
    // Excel's nested workbook API is a separate surface, not file management.
    excludedOperationPathPrefixes: ["/drives/{drive-id}/items/{driveItem-id}/workbook"],
  },
  baseUrl: MICROSOFT_GRAPH_BASE_URL,
  authentication: microsoftOAuth(["Files.ReadWrite.All"]),
  facets: [driveKnowledgeFacet("microsoft-onedrive"), accountIdentityFacet("microsoft")],
};

const SHAREPOINT_SCOPE = ["Sites.ReadWrite.All"] as const;
/** Mail, calendar and chat entities stay behind their own reviewed tools. */
const SHAREPOINT_SEARCH_ENTITY_TYPES = ["driveItem", "listItem", "list", "site", "drive"] as const;

/**
 * Delegated work/school SharePoint access. OneDrive stays on personal-account
 * compatible file scopes, so site discovery, lists and search live here.
 */
export const MICROSOFT_SHAREPOINT_INTEGRATION_DEFINITION: IntegrationDefinition = {
  id: "microsoft-sharepoint",
  name: "SharePoint",
  summary: "Find SharePoint sites, browse document libraries and lists, and search content.",
  protocol: "openapi",
  provider: { id: "microsoft", domain: "graph.microsoft.com" },
  source: {
    kind: "openapi",
    url: MICROSOFT_GRAPH_OPENAPI_URL,
    schemaMode: "provider_validated_json",
    // No site, list or page administration, permission changes or tenant-wide enumeration.
    operationAllowlist: [
      {
        path: "/search/query",
        method: "post",
        readOnly: true,
        searchEntityTypes: SHAREPOINT_SEARCH_ENTITY_TYPES,
        requiredScopes: SHAREPOINT_SCOPE,
        description:
          'Search SharePoint and OneDrive files, lists and sites the signed-in person can access. Send {"requests":[{"entityTypes":["driveItem"],"query":{"queryString":"..."},"from":0,"size":25}]}. Use entityTypes driveItem for files, listItem for list items, site for sites, list for lists and libraries; combine driveItem, listItem and list in one request if needed, but search site separately. KQL is supported in queryString (for example filetype:docx or path:"https://contoso.sharepoint.com/sites/hr"). Page with from and size. Only driveItem, listItem, list, site and drive can be searched here.',
      },
      {
        path: "/sites",
        method: "get",
        odataSkipToken: true,
        requiredScopes: SHAREPOINT_SCOPE,
        description:
          "Find SharePoint sites by keyword with $search (for example $search=marketing). Returns sites the signed-in person can access.",
      },
      {
        path: "/me/followedSites",
        method: "get",
        odataSkipToken: true,
        requiredScopes: SHAREPOINT_SCOPE,
      },
      { path: "/sites/{site-id}", method: "get", requiredScopes: SHAREPOINT_SCOPE },
      {
        path: "/sites/{site-id}/getByPath(path='{path}')",
        method: "get",
        requiredScopes: SHAREPOINT_SCOPE,
        description:
          "Resolve a SharePoint site URL. For https://contoso.sharepoint.com/sites/hr, use site-id contoso.sharepoint.com and path /sites/hr. If that fails, find the site by keyword with the site search instead.",
      },
      {
        path: "/sites/{site-id}/sites",
        method: "get",
        odataSkipToken: true,
        requiredScopes: SHAREPOINT_SCOPE,
      },
      { path: "/sites/{site-id}/drive", method: "get", requiredScopes: SHAREPOINT_SCOPE },
      {
        path: "/sites/{site-id}/drives",
        method: "get",
        odataSkipToken: true,
        requiredScopes: SHAREPOINT_SCOPE,
      },
      {
        path: "/sites/{site-id}/lists",
        method: "get",
        odataSkipToken: true,
        requiredScopes: SHAREPOINT_SCOPE,
      },
      { path: "/sites/{site-id}/lists/{list-id}", method: "get", requiredScopes: SHAREPOINT_SCOPE },
      {
        path: "/sites/{site-id}/lists/{list-id}/items",
        method: "get",
        odataSkipToken: true,
        requiredScopes: SHAREPOINT_SCOPE,
        description:
          "List items in a SharePoint list. Use $expand=fields to include column values, and $filter on fields/<column> only for indexed columns.",
      },
      {
        path: "/sites/{site-id}/lists/{list-id}/items",
        method: "post",
        requiredScopes: SHAREPOINT_SCOPE,
        description:
          'Create an item in a SharePoint list. Send {"fields":{"Title":"...","<Column>":"..."}} using the list\'s internal column names.',
      },
      {
        path: "/sites/{site-id}/lists/{list-id}/items/{listItem-id}",
        method: "get",
        requiredScopes: SHAREPOINT_SCOPE,
      },
      {
        path: "/sites/{site-id}/lists/{list-id}/items/{listItem-id}/fields",
        method: "patch",
        requiredScopes: SHAREPOINT_SCOPE,
        description:
          "Update column values of a SharePoint list item. Send only the changed columns by internal name.",
      },
      {
        path: "/sites/{site-id}/pages",
        method: "get",
        odataSkipToken: true,
        requiredScopes: SHAREPOINT_SCOPE,
      },
      { path: "/drives/{drive-id}/root", method: "get", requiredScopes: SHAREPOINT_SCOPE },
      {
        path: "/drives/{drive-id}/items/{driveItem-id}",
        method: "get",
        requiredScopes: SHAREPOINT_SCOPE,
        description:
          "Read a file or folder in a document library. A file's response includes @microsoft.graph.downloadUrl, a short-lived pre-authenticated link: download the file bytes from it directly, without credentials.",
      },
      {
        path: "/drives/{drive-id}/items/{driveItem-id}/children",
        method: "get",
        odataSkipToken: true,
        requiredScopes: SHAREPOINT_SCOPE,
        description:
          "List files and folders in a document library folder. Use driveItem-id root for the library's top level.",
      },
      {
        path: "/drives/{drive-id}/search(q='{q}')",
        method: "get",
        requiredScopes: SHAREPOINT_SCOPE,
      },
    ],
  },
  baseUrl: MICROSOFT_GRAPH_BASE_URL,
  authentication: {
    ...microsoftOAuth([...SHAREPOINT_SCOPE]),
    authorizationUrl: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
  },
  facets: [accountIdentityFacet("microsoft")],
};

/** Delegated work/school account access. Message sends use the connected human. */
export const MICROSOFT_TEAMS_INTEGRATION_DEFINITION: IntegrationDefinition = {
  id: "microsoft-teams",
  name: "Microsoft Teams",
  summary: "Read teams, channels and chats, and send messages as your connected Microsoft account.",
  protocol: "openapi",
  provider: { id: "microsoft", domain: "graph.microsoft.com" },
  source: {
    kind: "openapi",
    url: MICROSOFT_GRAPH_OPENAPI_URL,
    schemaMode: "provider_validated_json",
    // No tenant-wide export, membership/admin changes, app installation, or beta search.
    operationAllowlist: [
      {
        path: "/me/joinedTeams",
        method: "get",
        odataSkipToken: true,
        requiredScopes: ["Team.ReadBasic.All"],
      },
      { path: "/teams/{team-id}", method: "get", requiredScopes: ["Team.ReadBasic.All"] },
      {
        path: "/teams/{team-id}/channels",
        method: "get",
        odataSkipToken: true,
        requiredScopes: ["Channel.ReadBasic.All"],
      },
      {
        path: "/teams/{team-id}/channels/{channel-id}",
        method: "get",
        requiredScopes: ["Channel.ReadBasic.All"],
      },
      {
        path: "/teams/{team-id}/channels/{channel-id}/messages",
        method: "get",
        odataSkipToken: true,
        requiredScopes: ["ChannelMessage.Read.All"],
      },
      {
        path: "/teams/{team-id}/channels/{channel-id}/messages",
        method: "post",
        requiredScopes: ["ChannelMessage.Send"],
      },
      {
        path: "/teams/{team-id}/channels/{channel-id}/messages/{chatMessage-id}",
        method: "get",
        requiredScopes: ["ChannelMessage.Read.All"],
      },
      {
        path: "/teams/{team-id}/channels/{channel-id}/messages/{chatMessage-id}/replies",
        method: "get",
        odataSkipToken: true,
        requiredScopes: ["ChannelMessage.Read.All"],
      },
      {
        path: "/teams/{team-id}/channels/{channel-id}/messages/{chatMessage-id}/replies",
        method: "post",
        requiredScopes: ["ChannelMessage.Send"],
      },
      {
        path: "/teams/{team-id}/channels/{channel-id}/messages/{chatMessage-id}/replies/{chatMessage-id1}",
        method: "get",
        requiredScopes: ["ChannelMessage.Read.All"],
      },
      { path: "/chats", method: "get", odataSkipToken: true, requiredScopes: ["Chat.Read"] },
      { path: "/chats/{chat-id}", method: "get", requiredScopes: ["Chat.Read"] },
      {
        path: "/chats/{chat-id}/messages",
        method: "get",
        odataSkipToken: true,
        requiredScopes: ["Chat.Read"],
      },
      { path: "/chats/{chat-id}/messages", method: "post", requiredScopes: ["ChatMessage.Send"] },
      {
        path: "/chats/{chat-id}/messages/{chatMessage-id}",
        method: "get",
        requiredScopes: ["Chat.Read"],
      },
    ],
  },
  baseUrl: MICROSOFT_GRAPH_BASE_URL,
  authentication: {
    ...microsoftOAuth([
      "Team.ReadBasic.All",
      "Channel.ReadBasic.All",
      "ChannelMessage.Read.All",
      "ChannelMessage.Send",
      "Chat.Read",
      "ChatMessage.Send",
    ]),
    authorizationUrl: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
  },
  facets: [accountIdentityFacet("microsoft")],
};

/** Rollout never grants provider authority; the normal connection fences still apply. */
export function isIntegrationDefinitionEnabled(
  definitionId: string,
  rollout: {
    teamsEnabled?: boolean;
    teamsAllowedWorkspaceIds?: readonly string[];
    workspaceId?: string;
  } = {},
): boolean {
  return (
    definitionId !== "microsoft-teams" ||
    rollout.teamsEnabled === true ||
    (!!rollout.workspaceId &&
      rollout.teamsAllowedWorkspaceIds?.includes(rollout.workspaceId) === true)
  );
}

export const CORE_INTEGRATION_DEFINITIONS: readonly IntegrationDefinition[] = [
  MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION,
  MICROSOFT_OUTLOOK_CALENDAR_INTEGRATION_DEFINITION,
  MICROSOFT_OUTLOOK_CONTACTS_INTEGRATION_DEFINITION,
  MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION,
  MICROSOFT_SHAREPOINT_INTEGRATION_DEFINITION,
  MICROSOFT_TEAMS_INTEGRATION_DEFINITION,
];

export function integrationDefinitionById(id: string): IntegrationDefinition | undefined {
  return CORE_INTEGRATION_DEFINITIONS.find((definition) => definition.id === id);
}

/**
 * Reviewed `"<method> <path>"` keys that read despite a non-GET method. Only
 * a reviewed definition can supply these; provider documents cannot.
 */
export function integrationDefinitionReadOnlyOperations(
  definition: IntegrationDefinition,
): ReadonlyMap<string, Readonly<{ searchEntityTypes?: readonly string[] }>> {
  if (definition.source.kind !== "openapi" || !definition.source.operationAllowlist) {
    return new Map();
  }
  return new Map(
    definition.source.operationAllowlist
      .filter((entry) => entry.readOnly === true)
      .map((entry) => [
        `${entry.method} ${entry.path}`,
        entry.searchEntityTypes ? { searchEntityTypes: [...entry.searchEntityTypes] } : {},
      ]),
  );
}

export function integrationDefinitionProviderDomain(definition: IntegrationDefinition): string {
  return definition.provider.domain;
}

export function integrationFacetDefinitions(
  definitionId: string | null | undefined,
): readonly IntegrationFacetDefinition[] {
  return definitionId ? (integrationDefinitionById(definitionId)?.facets ?? []) : [];
}

export function filterOpenApiDocumentForDefinition(
  document: Record<string, unknown>,
  definition: IntegrationDefinition,
): Record<string, unknown> {
  if (
    definition.source.kind !== "openapi" ||
    (!definition.source.operationPathPrefixes?.length && !definition.source.operationAllowlist)
  ) {
    return document;
  }
  const operationPathPrefixes = definition.source.operationPathPrefixes;
  const operationAllowlist = definition.source.operationAllowlist;
  const excludedOperationPathPrefixes = definition.source.excludedOperationPathPrefixes ?? [];
  if (!isRecord(document.paths)) {
    throw new IntegrationProtocolError("openapi_paths", "OpenAPI document has no paths object");
  }
  const paths = Object.fromEntries(
    Object.entries(document.paths)
      .filter(
        ([path]) =>
          (!operationPathPrefixes?.length ||
            operationPathPrefixes.some(
              (prefix) => path === prefix || path.startsWith(`${prefix}/`),
            )) &&
          !excludedOperationPathPrefixes.some(
            (prefix) => path === prefix || path.startsWith(`${prefix}/`),
          ),
      )
      .flatMap(([path, item]) => {
        if (!operationAllowlist) return [[path, item]];
        if (!isRecord(item)) return [];
        const selected = operationAllowlist.filter((entry) => entry.path === path);
        const operations = Object.fromEntries(
          selected
            .filter(({ method }) => isRecord(item[method]))
            .map(({ method, requiredScopes, odataSkipToken, description }) => {
              const operation = item[method] as Record<string, unknown>;
              if (operation.$ref)
                throw new IntegrationProtocolError(
                  "integration_definition_reference",
                  "Reviewed operations must be inline OpenAPI operations",
                );
              const { servers: _servers, ...reviewed } = operation;
              return [
                method,
                {
                  ...reviewed,
                  // Reviewed guidance is long; keep a short name when the provider has no summary.
                  ...(description
                    ? {
                        description,
                        ...(typeof reviewed.summary === "string" && reviewed.summary
                          ? {}
                          : { summary: `${method.toUpperCase()} ${path}` }),
                      }
                    : {}),
                  ...(odataSkipToken
                    ? {
                        parameters: [
                          ...(Array.isArray(reviewed.parameters) ? reviewed.parameters : []),
                          {
                            name: "$skiptoken",
                            in: "query",
                            required: false,
                            description:
                              "Opaque $skiptoken from the previous response @odata.nextLink, URL-decoded once. Keep the same resource and other query values. Never supply the full URL.",
                            schema: { type: "string", minLength: 1, maxLength: 16384 },
                          },
                        ],
                      }
                    : {}),
                  ...(requiredScopes ? { security: [{ delegated: [...requiredScopes] }] } : {}),
                },
              ];
            }),
        );
        if (Object.keys(operations).length === 0) return [];
        // Preserve shared parameters and descriptions, but do not allow a path $ref
        // to reintroduce unreviewed methods or a provider override of the API origin.
        return [
          [
            path,
            {
              ...(item.parameters ? { parameters: item.parameters } : {}),
              ...(item.summary ? { summary: item.summary } : {}),
              ...(item.description ? { description: item.description } : {}),
              ...operations,
            },
          ],
        ];
      }),
  );
  if (Object.keys(paths).length === 0) {
    throw new IntegrationProtocolError(
      "integration_definition_empty",
      `${definition.name} did not match any operations in the supplied OpenAPI document`,
    );
  }
  return {
    ...document,
    paths,
    servers: [{ url: definition.baseUrl }],
  };
}

export function googleDiscoveryToOpenApi(discovery: unknown): Record<string, unknown> {
  if (!isRecord(discovery)) {
    throw new IntegrationProtocolError(
      "google_discovery_shape",
      "Google Discovery document is invalid",
    );
  }
  const rootUrl = stringValue(discovery.rootUrl) ?? stringValue(discovery.baseUrl);
  const servicePath = stringValue(discovery.servicePath) ?? "";
  if (!rootUrl || !URL.canParse(rootUrl)) {
    throw new IntegrationProtocolError(
      "google_discovery_server",
      "Google Discovery document has no valid root URL",
    );
  }
  const paths: Record<string, unknown> = {};
  collectGoogleMethods(discovery, discovery.methods, paths);
  collectGoogleResources(discovery, discovery.resources, paths);
  if (Object.keys(paths).length === 0) {
    throw new IntegrationProtocolError(
      "google_discovery_empty",
      "Google Discovery document exposes no methods",
    );
  }
  const scopes =
    isRecord(discovery.auth) && isRecord(discovery.auth.oauth2)
      ? discovery.auth.oauth2.scopes
      : undefined;
  const scopeMap = isRecord(scopes)
    ? Object.fromEntries(
        Object.entries(scopes).map(([scope, value]) => [
          scope,
          isRecord(value) && typeof value.description === "string" ? value.description : "",
        ]),
      )
    : {};
  return {
    openapi: "3.1.0",
    info: {
      title: stringValue(discovery.title) ?? stringValue(discovery.name) ?? "Google API",
      description: stringValue(discovery.description) ?? "Google Discovery API",
      version: stringValue(discovery.version) ?? "v1",
    },
    servers: [{ url: new URL(servicePath, rootUrl).toString() }],
    paths,
    components: {
      schemas: Object.fromEntries(
        Object.entries(isRecord(discovery.schemas) ? discovery.schemas : {}).map(
          ([name, schema]) => [name, convertGoogleSchema(schema)],
        ),
      ),
      securitySchemes: {
        googleOAuth2: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
              tokenUrl: "https://oauth2.googleapis.com/token",
              scopes: scopeMap,
            },
          },
        },
      },
    },
    security: Object.keys(scopeMap).length > 0 ? [{ googleOAuth2: [] }] : [],
  };
}

function collectGoogleResources(
  document: Record<string, unknown>,
  value: unknown,
  paths: Record<string, unknown>,
): void {
  if (!isRecord(value)) return;
  for (const resource of Object.values(value)) {
    if (!isRecord(resource)) continue;
    collectGoogleMethods(document, resource.methods, paths);
    collectGoogleResources(document, resource.resources, paths);
  }
}

function collectGoogleMethods(
  document: Record<string, unknown>,
  value: unknown,
  paths: Record<string, unknown>,
): void {
  if (!isRecord(value)) return;
  for (const [fallbackId, rawMethod] of Object.entries(value)) {
    if (!isRecord(rawMethod)) continue;
    const path = stringValue(rawMethod.path);
    const httpMethod = stringValue(rawMethod.httpMethod)?.toLowerCase();
    if (!path || !httpMethod) continue;
    const parameters = Object.entries(isRecord(rawMethod.parameters) ? rawMethod.parameters : {})
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([name, rawParameter]): Record<string, unknown>[] => {
        if (!isRecord(rawParameter)) return [];
        const location = rawParameter.location === "path" ? "path" : "query";
        return [
          {
            name,
            in: location,
            required: location === "path" || rawParameter.required === true,
            ...(stringValue(rawParameter.description)
              ? { description: stringValue(rawParameter.description) }
              : {}),
            schema: convertGoogleSchema(rawParameter),
          },
        ];
      });
    const requestRef = isRecord(rawMethod.request)
      ? stringValue(rawMethod.request.$ref)
      : undefined;
    const responseRef = isRecord(rawMethod.response)
      ? stringValue(rawMethod.response.$ref)
      : undefined;
    const operation: Record<string, unknown> = {
      operationId: stringValue(rawMethod.id) ?? fallbackId,
      // Discovery descriptions are often full documentation paragraphs. Keep
      // them as descriptions and use the stable method identity for the short
      // Opengeni tool display name.
      summary: stringValue(rawMethod.id) ?? fallbackId,
      description: stringValue(rawMethod.description),
      parameters,
      responses: {
        "200": {
          description: "Successful response",
          ...(responseRef
            ? {
                content: {
                  "application/json": {
                    schema: { $ref: `#/components/schemas/${escapeJsonPointer(responseRef)}` },
                  },
                },
              }
            : {}),
        },
      },
      ...(Array.isArray(rawMethod.scopes) && rawMethod.scopes.length > 0
        ? { security: [{ googleOAuth2: rawMethod.scopes }] }
        : {}),
    };
    if (requestRef) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${escapeJsonPointer(requestRef)}` },
          },
        },
      };
    }
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const existing = isRecord(paths[normalizedPath]) ? paths[normalizedPath] : {};
    paths[normalizedPath] = { ...existing, [httpMethod]: operation };
  }
}

function convertGoogleSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (!isRecord(value) || depth > 20) return {};
  if (typeof value.$ref === "string") {
    return { $ref: `#/components/schemas/${escapeJsonPointer(value.$ref)}` };
  }
  const result: Record<string, unknown> = {};
  const type = stringValue(value.type);
  if (type) result.type = type === "any" ? undefined : type;
  for (const key of [
    "description",
    "format",
    "pattern",
    "minimum",
    "maximum",
    "default",
  ] as const) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  if (Array.isArray(value.enum)) result.enum = value.enum;
  if (isRecord(value.properties)) {
    result.type = result.type ?? "object";
    result.properties = Object.fromEntries(
      Object.entries(value.properties).map(([name, schema]) => [
        name,
        convertGoogleSchema(schema, depth + 1),
      ]),
    );
  }
  if (value.items !== undefined) {
    result.type = result.type ?? "array";
    result.items = convertGoogleSchema(value.items, depth + 1);
  }
  if (value.additionalProperties !== undefined) {
    result.additionalProperties =
      value.additionalProperties === true
        ? true
        : convertGoogleSchema(value.additionalProperties, depth + 1);
  }
  if (Array.isArray(value.required)) result.required = value.required;
  return Object.fromEntries(Object.entries(result).filter(([, entry]) => entry !== undefined));
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
