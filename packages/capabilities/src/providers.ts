import { IntegrationProtocolError } from "./types";

export interface OAuthProviderPreset {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
  readonly tokenPlacement: {
    readonly carrier: "header";
    readonly name: "Authorization";
    readonly prefix: "Bearer ";
  };
}

export interface OpenApiProviderPreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly family: "google" | "microsoft";
  readonly sourceFormat: "google-discovery" | "openapi";
  readonly sourceUrl: string;
  readonly baseUrl: string;
  readonly oauth: OAuthProviderPreset;
  readonly pathPrefixes?: readonly string[];
  readonly healthOperation?: string;
  readonly healthArgs?: Readonly<Record<string, unknown>>;
}

const googleDiscoveryUrl = (service: string, version: string): string =>
  `https://www.googleapis.com/discovery/v1/apis/${service}/${version}/rest`;

const googleOAuth = (scopes: readonly string[]): OAuthProviderPreset => ({
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: ["openid", "email", "profile", ...scopes],
  tokenPlacement: { carrier: "header", name: "Authorization", prefix: "Bearer " },
});

export const GOOGLE_DRIVE_PRESET: OpenApiProviderPreset = {
  id: "google-drive",
  name: "Google Drive",
  summary: "Files, folders, permissions, and shared drives.",
  family: "google",
  sourceFormat: "google-discovery",
  sourceUrl: googleDiscoveryUrl("drive", "v3"),
  baseUrl: "https://www.googleapis.com/drive/v3/",
  oauth: googleOAuth(["https://www.googleapis.com/auth/drive"]),
  healthOperation: "drive.about.get",
  healthArgs: { query: { fields: "user" } },
};

export const GOOGLE_GMAIL_PRESET: OpenApiProviderPreset = {
  id: "google-gmail",
  name: "Gmail",
  summary: "Messages, threads, labels, drafts, and sending mail.",
  family: "google",
  sourceFormat: "google-discovery",
  sourceUrl: googleDiscoveryUrl("gmail", "v1"),
  baseUrl: "https://gmail.googleapis.com/",
  oauth: googleOAuth(["https://mail.google.com/"]),
  healthOperation: "gmail.users.labels.list",
  healthArgs: { path: { userId: "me" } },
};

export const MICROSOFT_GRAPH_OPENAPI_URL =
  "https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/master/openapi/v1.0/openapi.yaml";
export const MICROSOFT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

const microsoftOAuth = (scopes: readonly string[]): OAuthProviderPreset => ({
  authorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  scopes: ["offline_access", "User.Read", ...scopes],
  tokenPlacement: { carrier: "header", name: "Authorization", prefix: "Bearer " },
});

export const MICROSOFT_OUTLOOK_MAIL_PRESET: OpenApiProviderPreset = {
  id: "microsoft-outlook-mail",
  name: "Outlook Mail",
  summary: "Messages, folders, attachments, settings, and sending mail.",
  family: "microsoft",
  sourceFormat: "openapi",
  sourceUrl: MICROSOFT_GRAPH_OPENAPI_URL,
  baseUrl: MICROSOFT_GRAPH_BASE_URL,
  oauth: microsoftOAuth(["Mail.ReadWrite", "Mail.Send", "MailboxSettings.ReadWrite"]),
  pathPrefixes: [
    "/me/messages",
    "/me/mailFolders",
    "/me/sendMail",
    "/me/getMailTips",
    "/me/inferenceClassification",
    "/me/mailboxSettings",
    "/me/outlook",
  ],
};

export const MICROSOFT_OUTLOOK_CALENDAR_PRESET: OpenApiProviderPreset = {
  id: "microsoft-outlook-calendar",
  name: "Outlook Calendar",
  summary: "Calendars, events, availability, and scheduling.",
  family: "microsoft",
  sourceFormat: "openapi",
  sourceUrl: MICROSOFT_GRAPH_OPENAPI_URL,
  baseUrl: MICROSOFT_GRAPH_BASE_URL,
  oauth: microsoftOAuth(["Calendars.ReadWrite"]),
  pathPrefixes: [
    "/me/calendar",
    "/me/calendars",
    "/me/calendarGroups",
    "/me/calendarView",
    "/me/events",
    "/me/findMeetingTimes",
    "/me/reminderView",
  ],
};

export const MICROSOFT_OUTLOOK_CONTACTS_PRESET: OpenApiProviderPreset = {
  id: "microsoft-outlook-contacts",
  name: "Outlook Contacts",
  summary: "Contacts, contact folders, and people suggestions.",
  family: "microsoft",
  sourceFormat: "openapi",
  sourceUrl: MICROSOFT_GRAPH_OPENAPI_URL,
  baseUrl: MICROSOFT_GRAPH_BASE_URL,
  oauth: microsoftOAuth(["Contacts.ReadWrite", "People.Read.All"]),
  pathPrefixes: ["/me/contacts", "/me/contactFolders", "/me/people"],
};

export const MICROSOFT_ONEDRIVE_PRESET: OpenApiProviderPreset = {
  id: "microsoft-onedrive",
  name: "OneDrive",
  summary: "Drives, files, folders, sharing links, and permissions.",
  family: "microsoft",
  sourceFormat: "openapi",
  sourceUrl: MICROSOFT_GRAPH_OPENAPI_URL,
  baseUrl: MICROSOFT_GRAPH_BASE_URL,
  oauth: microsoftOAuth(["Files.ReadWrite.All", "Sites.ReadWrite.All"]),
  pathPrefixes: ["/me/drive", "/me/drives", "/me/followedSites", "/drives", "/shares"],
};

export const CORE_PROVIDER_PRESETS: readonly OpenApiProviderPreset[] = [
  GOOGLE_DRIVE_PRESET,
  GOOGLE_GMAIL_PRESET,
  MICROSOFT_OUTLOOK_MAIL_PRESET,
  MICROSOFT_OUTLOOK_CALENDAR_PRESET,
  MICROSOFT_OUTLOOK_CONTACTS_PRESET,
  MICROSOFT_ONEDRIVE_PRESET,
];

export function providerPresetById(id: string): OpenApiProviderPreset | undefined {
  return CORE_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function providerDomainForPreset(preset: OpenApiProviderPreset): string {
  return new URL(preset.baseUrl).hostname.toLowerCase();
}

export function filterOpenApiDocumentForPreset(
  document: Record<string, unknown>,
  preset: OpenApiProviderPreset,
): Record<string, unknown> {
  if (!preset.pathPrefixes?.length) return document;
  if (!isRecord(document.paths)) {
    throw new IntegrationProtocolError("openapi_paths", "OpenAPI document has no paths object");
  }
  const paths = Object.fromEntries(
    Object.entries(document.paths).filter(([path]) =>
      preset.pathPrefixes!.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)),
    ),
  );
  if (Object.keys(paths).length === 0) {
    throw new IntegrationProtocolError(
      "provider_preset_empty",
      `${preset.name} did not match any operations in the supplied OpenAPI document`,
    );
  }
  return {
    ...document,
    paths,
    ...(preset.baseUrl ? { servers: [{ url: preset.baseUrl }] } : {}),
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
    const parameters = Object.entries(
      isRecord(rawMethod.parameters) ? rawMethod.parameters : {},
    ).flatMap(([name, rawParameter]): Record<string, unknown>[] => {
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
      summary: stringValue(rawMethod.description) ?? stringValue(rawMethod.id) ?? fallbackId,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
