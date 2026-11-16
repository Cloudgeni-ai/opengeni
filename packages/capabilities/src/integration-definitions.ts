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
      /**
       * The reviewed document actually read, when `url` names a moving
       * document (a branch head). `url` stays the installation identity; the
       * document is fetched from `pinned.url` and must match `pinned.sha256`,
       * so a provider's upstream change can't silently change the tools.
       */
      pinned?: Readonly<{ url: string; sha256: string }>;
      operationPathPrefixes?: readonly string[];
      /** Exact reviewed operations; never admit newly added provider methods implicitly. */
      operationAllowlist?: readonly Readonly<{
        path: string;
        method: "get" | "post" | "patch" | "put" | "delete";
        /**
         * A reviewed operation id, which names the tool. Lets one provider
         * operation back a second reviewed tool with its own request path.
         */
        operationId?: string;
        /** Reviewed short name that replaces the provider's summary. */
        summary?: string;
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
        /**
         * The path actually sent when the provider's documented form fails.
         * The operation keeps its tool ID when the provider names it with an
         * operationId (otherwise the ID follows method and path). `{+name}`
         * expands a path parameter as a path: `/` is kept and each segment is
         * encoded once, an already percent-encoded segment as it is, for
         * example Graph's colon form `/sites/{site-id}:/{+path}`.
         * Path parameters follow the request path: one it doesn't name is
         * dropped, and one only it names is added as a required string.
         */
        requestPath?: string;
        /** Descriptions for path parameters only the request path names. */
        pathParameterDescriptions?: Readonly<Record<string, string>>;
        /** Query parameters the provider documents but rejects for this operation. */
        omitQueryParameters?: readonly string[];
      }>[];
      excludedOperationPathPrefixes?: readonly string[];
      /**
       * Opt-in generic access to the rest of the provider's API under these
       * path prefixes: a tool that finds operations in the reviewed document
       * and a read and a change tool that call one of them by path, for
       * operations the reviewed tools don't cover. The change tool always
       * needs approval by default.
       */
      genericPathScope?: Readonly<{
        prefixes: readonly string[];
        excludedPrefixes?: readonly string[];
      }>;
      /**
       * Reviewed summary and description for operations selected by prefix,
       * keyed `"<method> <path>"`, where the provider's text describes a
       * different operation.
       */
      operationText?: Readonly<
        Record<string, Readonly<{ summary?: string; description?: string }>>
      >;
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
  readonly kind: "inbound_trigger" | "delivery_destination" | "identity_link";
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
  facets: [accountIdentityFacet("google")],
};

export const MICROSOFT_GRAPH_OPENAPI_URL =
  "https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/master/openapi/v1.0/openapi.yaml";
/**
 * The reviewed Graph description the built-ins are compiled from. Update it
 * with scripts/graph-openapi-pin.ts --diff, which prints the
 * operation changes each definition would see.
 */
export const MICROSOFT_GRAPH_OPENAPI_PIN = {
  url: "https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/ab170ed19a075b7b9df5a95bc4e08d9d49af56bd/openapi/v1.0/openapi.yaml",
  sha256: "eed44b45dd36f8489aabdffedd9de6e2f4e7613c1c7b2d884845e59652d489ff",
} as const;
export const MICROSOFT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

const microsoftOAuth = (scopes: readonly string[]): IntegrationDefinitionOAuth2Authentication => ({
  kind: "oauth2",
  provider: "microsoft",
  authorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  scopes: ["offline_access", "User.Read", ...scopes],
  tokenPlacement: { carrier: "header", name: "Authorization", prefix: "Bearer " },
});

type ReviewedOperation = NonNullable<
  Extract<IntegrationDefinitionSource, { kind: "openapi" }>["operationAllowlist"]
>[number];

/**
 * Read-only colleague lookup in the work or school directory, shared by the
 * work-account integrations so it is available whichever of them is connected.
 * Microsoft requires User.Read.All for any manager lookup, so only a connection
 * with that permission gets the manager tools.
 */
const directoryLookupOperations = (
  directoryScope: "User.ReadBasic.All" | "User.Read.All",
): readonly ReviewedOperation[] => {
  const full = directoryScope === "User.Read.All";
  const select = full
    ? "id,displayName,mail,userPrincipalName,jobTitle,department,officeLocation"
    : "id,displayName,mail,userPrincipalName";
  const fields = full
    ? "Profiles include job title, department and office."
    : "This connection reads basic profiles: name, email and sign-in name.";
  const manager: readonly ReviewedOperation[] = full
    ? [
        {
          path: "/users/{user-id}/manager",
          method: "get",
          requiredScopes: ["User.Read.All"],
          description:
            "Read a colleague's manager. user-id is the id from the directory search or the person's sign-in email. A 404 means no manager is set.",
        },
        {
          path: "/me/manager",
          method: "get",
          requiredScopes: ["User.Read.All"],
          description: "Read the signed-in person's manager. A 404 means no manager is set.",
        },
      ]
    : [];
  return [
    {
      path: "/users",
      method: "get",
      odataSkipToken: true,
      requiredScopes: [directoryScope],
      description: `Find colleagues in the organization's directory. Search by name or email with $search="displayName:anna" OR "mail:anna" and send the header ConsistencyLevel: eventual whenever $search is used. Use $select=${select} and $top to keep results small. ${fields}`,
    },
    {
      path: "/users/{user-id}",
      method: "get",
      requiredScopes: [directoryScope],
      description: `Read a colleague's directory profile. user-id is the id from the directory search or the person's sign-in email (userPrincipalName). ${fields}`,
    },
    {
      path: "/users/{user-id}/directReports",
      method: "get",
      odataSkipToken: true,
      requiredScopes: [directoryScope],
      description:
        "List the people who report directly to a colleague. user-id is the id from the directory search or the person's sign-in email.",
    },
    {
      path: "/me/directReports",
      method: "get",
      odataSkipToken: true,
      requiredScopes: [directoryScope],
      description: "List the people who report directly to the signed-in person.",
    },
    ...manager,
  ];
};

const MAIL_SCOPE = ["Mail.ReadWrite"] as const;
const MAIL_SEND_SCOPE = ["Mail.Send"] as const;
const MAILBOX_SETTINGS_SCOPE = ["MailboxSettings.ReadWrite"] as const;
const RECIPIENTS_EXAMPLE = '"toRecipients":[{"emailAddress":{"address":"..."}}]';

/** Prefixes behind the generic find and call tools (the earlier tool scope). */
const OUTLOOK_MAIL_PATH_PREFIXES = [
  "/me/messages",
  "/me/mailFolders",
  "/me/sendMail",
  "/me/getMailTips",
  "/me/inferenceClassification",
  "/me/mailboxSettings",
  "/me/outlook",
] as const;

export const MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION: IntegrationDefinition = {
  id: "microsoft-outlook-mail",
  name: "Outlook Mail",
  summary: "Messages, folders, attachments, settings, and sending mail.",
  protocol: "openapi",
  provider: { id: "microsoft", domain: "graph.microsoft.com" },
  source: {
    kind: "openapi",
    url: MICROSOFT_GRAPH_OPENAPI_URL,
    pinned: MICROSOFT_GRAPH_OPENAPI_PIN,
    schemaMode: "provider_validated_json",
    operationAllowlist: [
      {
        path: "/me/messages",
        method: "get",
        summary: "List messages",
        requiredScopes: MAIL_SCOPE,
        description:
          "List messages in the signed-in person's mailbox, across folders. Search with $search=\"words\" (it can't be combined with $filter or $orderby), filter with $filter, pick fields with $select, and page with $top and $skip or @odata.nextLink.",
      },
      {
        path: "/me/messages/{message-id}",
        method: "get",
        summary: "Get message",
        requiredScopes: MAIL_SCOPE,
        description: "Read one message in the signed-in person's mailbox by its id.",
      },
      {
        path: "/me/sendMail",
        method: "post",
        summary: "Send mail",
        requiredScopes: MAIL_SEND_SCOPE,
        description: `Send a new message right away as the signed-in person. Send {"message":{"subject":"...","body":{"contentType":"Text","content":"..."},${RECIPIENTS_EXAMPLE}},"saveToSentItems":true}.`,
      },
      {
        path: "/me/messages",
        method: "post",
        summary: "Create draft message",
        requiredScopes: MAIL_SCOPE,
        description:
          "Create a new email draft in the signed-in person's Drafts folder without sending it. Send it later with the send draft tool.",
      },
      {
        path: "/me/messages/{message-id}",
        method: "patch",
        summary: "Update message",
        requiredScopes: MAIL_SCOPE,
        description:
          "Update a message's properties, such as a draft's subject, body or recipients, or mark it read with {\"isRead\":true}.",
      },
      {
        path: "/me/messages/{message-id}/send",
        method: "post",
        summary: "Send draft",
        requiredScopes: MAIL_SEND_SCOPE,
        description: "Send an existing draft by its id.",
      },
      {
        path: "/me/messages/{message-id}",
        method: "delete",
        summary: "Delete message",
        requiredScopes: MAIL_SCOPE,
        description: "Delete one message by its id; it moves to Deleted Items.",
      },
      {
        path: "/me/messages/{message-id}/reply",
        method: "post",
        summary: "Reply",
        requiredScopes: MAIL_SEND_SCOPE,
        description:
          'Reply to the sender of a message right away. Send {"comment":"..."} with the reply text.',
      },
      {
        path: "/me/messages/{message-id}/replyAll",
        method: "post",
        summary: "Reply all",
        requiredScopes: MAIL_SEND_SCOPE,
        description:
          'Reply to the sender and all recipients of a message right away. Send {"comment":"..."} with the reply text.',
      },
      {
        path: "/me/messages/{message-id}/forward",
        method: "post",
        summary: "Forward",
        requiredScopes: MAIL_SEND_SCOPE,
        description: `Forward a message right away. Send {${RECIPIENTS_EXAMPLE},"comment":"..."}.`,
      },
      {
        path: "/me/messages/{message-id}/createReply",
        method: "post",
        summary: "Create reply draft",
        requiredScopes: MAIL_SCOPE,
        description:
          "Create a draft reply to a message's sender, to edit and then send with the send draft tool.",
      },
      {
        path: "/me/messages/{message-id}/createReplyAll",
        method: "post",
        summary: "Create reply-all draft",
        requiredScopes: MAIL_SCOPE,
        description:
          "Create a draft reply to a message's sender and all recipients, to edit and then send with the send draft tool.",
      },
      {
        path: "/me/messages/{message-id}/createForward",
        method: "post",
        summary: "Create forward draft",
        requiredScopes: MAIL_SCOPE,
        description:
          "Create a draft forward of a message, to add recipients and then send with the send draft tool.",
      },
      {
        path: "/me/messages/{message-id}/move",
        method: "post",
        summary: "Move message",
        requiredScopes: MAIL_SCOPE,
        description:
          'Move a message to another folder. Send {"destinationId":"..."} with a folder id or a well-known name such as inbox, archive or deleteditems. Returns the moved message with its new id.',
      },
      {
        path: "/me/messages/{message-id}/copy",
        method: "post",
        summary: "Copy message",
        requiredScopes: MAIL_SCOPE,
        description:
          'Copy a message to another folder. Send {"destinationId":"..."} with a folder id or a well-known name.',
      },
      {
        path: "/me/messages/{message-id}/attachments",
        method: "get",
        summary: "List attachments",
        requiredScopes: MAIL_SCOPE,
        description:
          "List a message's attachments. File attachments include their content as base64 contentBytes; use $select=id,name,contentType,size to list them without content.",
      },
      {
        path: "/me/messages/{message-id}/attachments/{attachment-id}",
        method: "get",
        summary: "Get attachment",
        requiredScopes: MAIL_SCOPE,
        description:
          "Read one attachment of a message. A file attachment's contentBytes holds its content, base64-encoded.",
      },
      {
        path: "/me/messages/{message-id}/attachments",
        method: "post",
        summary: "Add attachment",
        requiredScopes: MAIL_SCOPE,
        description:
          'Attach a file under 3 MB to a draft. Send {"@odata.type":"#microsoft.graph.fileAttachment","name":"...","contentBytes":"<base64>"}.',
      },
      {
        path: "/me/mailFolders",
        method: "get",
        summary: "List mail folders",
        requiredScopes: MAIL_SCOPE,
        description:
          "List the top-level mail folders with their ids and item counts. Well-known names such as inbox, sentitems, drafts, archive and deleteditems work wherever a folder id is asked for.",
      },
      {
        path: "/me/mailFolders/{mailFolder-id}",
        method: "get",
        summary: "Get mail folder",
        requiredScopes: MAIL_SCOPE,
        description: "Read one mail folder by its id or well-known name, such as inbox.",
      },
      {
        path: "/me/mailFolders/{mailFolder-id}/childFolders",
        method: "get",
        summary: "List child folders",
        requiredScopes: MAIL_SCOPE,
        description: "List the folders inside a mail folder.",
      },
      {
        path: "/me/mailFolders/{mailFolder-id}/messages",
        method: "get",
        summary: "List messages in a folder",
        requiredScopes: MAIL_SCOPE,
        description:
          "List messages in one folder, by its id or a well-known name such as inbox. Filter with $filter, order with $orderby (for example receivedDateTime desc), pick fields with $select, and page with $top and $skip.",
      },
      {
        path: "/me/mailFolders",
        method: "post",
        summary: "Create mail folder",
        requiredScopes: MAIL_SCOPE,
        description: 'Create a top-level mail folder. Send {"displayName":"..."}.',
      },
      {
        path: "/me/mailboxSettings",
        method: "get",
        summary: "Get mailbox settings",
        requiredScopes: MAILBOX_SETTINGS_SCOPE,
        description:
          "Read mailbox settings such as time zone, working hours, language and automatic replies.",
      },
      {
        path: "/me/mailboxSettings",
        method: "patch",
        summary: "Update mailbox settings",
        requiredScopes: MAILBOX_SETTINGS_SCOPE,
        description:
          'Update mailbox settings; send only the settings to change, for example {"automaticRepliesSetting":{"status":"alwaysEnabled","internalReplyMessage":"..."}}.',
      },
    ],
    genericPathScope: { prefixes: OUTLOOK_MAIL_PATH_PREFIXES },
  },
  baseUrl: MICROSOFT_GRAPH_BASE_URL,
  authentication: microsoftOAuth(["Mail.ReadWrite", "Mail.Send", "MailboxSettings.ReadWrite"]),
  facets: mailboxFacets("microsoft-outlook-mail"),
};

const CALENDAR_SCOPE = ["Calendars.ReadWrite"] as const;
const EVENT_TIME_EXAMPLE =
  '"start":{"dateTime":"2026-11-16T09:00:00","timeZone":"Europe/Oslo"},"end":{"dateTime":"2026-11-16T09:30:00","timeZone":"Europe/Oslo"}';
const RESPONSE_BODY = 'Send {"comment":"...","sendResponse":true}.';

export const MICROSOFT_OUTLOOK_CALENDAR_INTEGRATION_DEFINITION: IntegrationDefinition = {
  id: "microsoft-outlook-calendar",
  name: "Outlook Calendar",
  summary: "Calendars, events, availability, and scheduling.",
  protocol: "openapi",
  provider: { id: "microsoft", domain: "graph.microsoft.com" },
  source: {
    kind: "openapi",
    url: MICROSOFT_GRAPH_OPENAPI_URL,
    pinned: MICROSOFT_GRAPH_OPENAPI_PIN,
    schemaMode: "provider_validated_json",
    operationAllowlist: [
      {
        path: "/me/calendars",
        method: "get",
        summary: "List calendars",
        requiredScopes: CALENDAR_SCOPE,
        description: "List the signed-in person's calendars with their ids.",
      },
      {
        path: "/me/calendar",
        method: "get",
        summary: "Get default calendar",
        requiredScopes: CALENDAR_SCOPE,
        description: "Read the signed-in person's default calendar.",
      },
      {
        path: "/me/calendarView",
        method: "get",
        summary: "List events in a time range",
        requiredScopes: CALENDAR_SCOPE,
        description:
          "List the signed-in person's events between startDateTime and endDateTime (ISO 8601, for example 2026-11-16T00:00:00Z), including each occurrence of recurring events. Order with $orderby=start/dateTime, pick fields with $select, and page with $top and @odata.nextLink.",
      },
      {
        path: "/me/calendars/{calendar-id}/calendarView",
        method: "get",
        summary: "List events in a time range in a calendar",
        requiredScopes: CALENDAR_SCOPE,
        description:
          "List one calendar's events between startDateTime and endDateTime (ISO 8601), including each occurrence of recurring events.",
      },
      {
        path: "/me/events",
        method: "get",
        summary: "List events",
        requiredScopes: CALENDAR_SCOPE,
        description:
          "List events in the default calendar as single events and recurring series, not each occurrence; use the time range tool for a schedule. Filter with $filter, pick fields with $select, and page with $top and $skip.",
      },
      {
        path: "/me/events",
        method: "post",
        summary: "Create event",
        requiredScopes: CALENDAR_SCOPE,
        description: `Create an event in the default calendar. Send {"subject":"...",${EVENT_TIME_EXAMPLE},"attendees":[{"emailAddress":{"address":"..."},"type":"required"}]}. Attendees get an invitation.`,
      },
      {
        path: "/me/calendars/{calendar-id}/events",
        method: "get",
        summary: "List events in a calendar",
        requiredScopes: CALENDAR_SCOPE,
        description: "List events in one calendar as single events and recurring series.",
      },
      {
        path: "/me/calendars/{calendar-id}/events",
        method: "post",
        summary: "Create event in a calendar",
        requiredScopes: CALENDAR_SCOPE,
        description: `Create an event in one calendar. Send {"subject":"...",${EVENT_TIME_EXAMPLE}}. Attendees get an invitation.`,
      },
      {
        path: "/me/events/{event-id}",
        method: "get",
        summary: "Get event",
        requiredScopes: CALENDAR_SCOPE,
        description: "Read one event by its id.",
      },
      {
        path: "/me/events/{event-id}",
        method: "patch",
        summary: "Update event",
        requiredScopes: CALENDAR_SCOPE,
        description:
          "Update an event; send only the fields to change, such as subject, start, end, location or attendees. Attendees get an update for a meeting the signed-in person organizes.",
      },
      {
        path: "/me/events/{event-id}",
        method: "delete",
        summary: "Delete event",
        requiredScopes: CALENDAR_SCOPE,
        description:
          "Delete an event from the calendar. To call off a meeting the signed-in person organizes and tell attendees, cancel it instead.",
      },
      {
        path: "/me/events/{event-id}/accept",
        method: "post",
        summary: "Accept invitation",
        requiredScopes: CALENDAR_SCOPE,
        description: `Accept a meeting invitation. ${RESPONSE_BODY}`,
      },
      {
        path: "/me/events/{event-id}/tentativelyAccept",
        method: "post",
        summary: "Tentatively accept invitation",
        requiredScopes: CALENDAR_SCOPE,
        description: `Tentatively accept a meeting invitation. ${RESPONSE_BODY}`,
      },
      {
        path: "/me/events/{event-id}/decline",
        method: "post",
        summary: "Decline invitation",
        requiredScopes: CALENDAR_SCOPE,
        description: `Decline a meeting invitation. ${RESPONSE_BODY}`,
      },
      {
        path: "/me/events/{event-id}/cancel",
        method: "post",
        summary: "Cancel meeting",
        requiredScopes: CALENDAR_SCOPE,
        description:
          'Cancel a meeting the signed-in person organizes and notify its attendees. Send {"comment":"..."}.',
      },
      {
        path: "/me/events/{event-id}/forward",
        method: "post",
        summary: "Forward invitation",
        requiredScopes: CALENDAR_SCOPE,
        description: `Forward a meeting invitation. Send {${RECIPIENTS_EXAMPLE},"comment":"..."}.`,
      },
      {
        path: "/me/events/{event-id}/instances",
        method: "get",
        summary: "List occurrences",
        requiredScopes: CALENDAR_SCOPE,
        description:
          "List the occurrences of a recurring event between startDateTime and endDateTime (ISO 8601).",
      },
      {
        path: "/me/events/{event-id}/attachments",
        method: "get",
        summary: "List event attachments",
        requiredScopes: CALENDAR_SCOPE,
        description:
          "List an event's attachments. File attachments include their content as base64 contentBytes; use $select=id,name,contentType,size to list them without content.",
      },
      {
        path: "/me/events/{event-id}/attachments/{attachment-id}",
        method: "get",
        summary: "Get event attachment",
        requiredScopes: CALENDAR_SCOPE,
        description: "Read one attachment of an event.",
      },
      {
        path: "/me/calendar/getSchedule",
        method: "post",
        readOnly: true,
        summary: "Get free/busy schedules",
        requiredScopes: CALENDAR_SCOPE,
        description:
          'Read free/busy availability of people, rooms or groups in a time range. Send {"schedules":["..."],"startTime":{"dateTime":"...","timeZone":"UTC"},"endTime":{"dateTime":"...","timeZone":"UTC"},"availabilityViewInterval":30}. Work or school accounts only.',
      },
    ],
    genericPathScope: {
      prefixes: [
        "/me/calendar",
        "/me/calendars",
        "/me/calendarGroups",
        "/me/calendarView",
        "/me/events",
        "/me/reminderView",
      ],
    },
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

const CONTACTS_SCOPE = ["Contacts.ReadWrite"] as const;

export const MICROSOFT_OUTLOOK_CONTACTS_INTEGRATION_DEFINITION: IntegrationDefinition = {
  id: "microsoft-outlook-contacts",
  name: "Outlook Contacts",
  summary: "Contacts, contact folders, and people suggestions.",
  protocol: "openapi",
  provider: { id: "microsoft", domain: "graph.microsoft.com" },
  source: {
    kind: "openapi",
    url: MICROSOFT_GRAPH_OPENAPI_URL,
    pinned: MICROSOFT_GRAPH_OPENAPI_PIN,
    schemaMode: "provider_validated_json",
    operationAllowlist: [
      {
        path: "/me/contacts",
        method: "get",
        summary: "List contacts",
        requiredScopes: CONTACTS_SCOPE,
        description:
          "List the signed-in person's contacts. Find one by name with $filter=startswith(displayName,'Ann') or by email with $filter=emailAddresses/any(a:a/address eq 'ann@contoso.com'); pick fields with $select and page with $top and $skip.",
      },
      {
        path: "/me/contacts/{contact-id}",
        method: "get",
        summary: "Get contact",
        requiredScopes: CONTACTS_SCOPE,
        description: "Read one contact by its id.",
      },
      {
        path: "/me/contacts",
        method: "post",
        summary: "Create contact",
        requiredScopes: CONTACTS_SCOPE,
        description:
          'Create a contact. Send {"givenName":"...","surname":"...","emailAddresses":[{"address":"...","name":"..."}],"businessPhones":["..."]}.',
      },
      {
        path: "/me/contacts/{contact-id}",
        method: "patch",
        summary: "Update contact",
        requiredScopes: CONTACTS_SCOPE,
        description:
          "Update a contact; send only the fields to change. A list such as emailAddresses is replaced as a whole.",
      },
      {
        path: "/me/contacts/{contact-id}",
        method: "delete",
        summary: "Delete contact",
        requiredScopes: CONTACTS_SCOPE,
        description: "Delete one contact by its id.",
      },
      {
        path: "/me/contactFolders",
        method: "get",
        summary: "List contact folders",
        requiredScopes: CONTACTS_SCOPE,
        description: "List the signed-in person's contact folders with their ids.",
      },
      {
        path: "/me/contactFolders/{contactFolder-id}",
        method: "get",
        summary: "Get contact folder",
        requiredScopes: CONTACTS_SCOPE,
        description: "Read one contact folder by its id.",
      },
      {
        path: "/me/contactFolders",
        method: "post",
        summary: "Create contact folder",
        requiredScopes: CONTACTS_SCOPE,
        description: 'Create a contact folder. Send {"displayName":"..."}.',
      },
      {
        path: "/me/contactFolders/{contactFolder-id}/childFolders",
        method: "get",
        summary: "List child contact folders",
        requiredScopes: CONTACTS_SCOPE,
        description: "List the folders inside a contact folder.",
      },
      {
        path: "/me/contactFolders/{contactFolder-id}/contacts",
        method: "get",
        summary: "List contacts in a folder",
        requiredScopes: CONTACTS_SCOPE,
        description:
          "List the contacts in one contact folder. Filter with $filter and page with $top and $skip.",
      },
      {
        path: "/me/contactFolders/{contactFolder-id}/contacts",
        method: "post",
        summary: "Create contact in a folder",
        requiredScopes: CONTACTS_SCOPE,
        description: "Create a contact in one contact folder.",
      },
      {
        path: "/me/contactFolders/{contactFolder-id}/contacts/{contact-id}",
        method: "get",
        summary: "Get contact in a folder",
        requiredScopes: CONTACTS_SCOPE,
        description: "Read one contact in a contact folder.",
      },
      {
        path: "/me/people",
        method: "get",
        summary: "Find relevant people",
        requiredScopes: ["People.Read"],
        description:
          'Find the people the signed-in person works or communicates with most, including colleagues who aren\'t saved contacts. Search by name with $search="ann". Returns names and email addresses.',
      },
    ],
    genericPathScope: { prefixes: ["/me/contacts", "/me/contactFolders", "/me/people"] },
  },
  baseUrl: MICROSOFT_GRAPH_BASE_URL,
  authentication: microsoftOAuth(["Contacts.ReadWrite", "People.Read"]),
  facets: [accountIdentityFacet("microsoft")],
};

const FILES_SCOPE = ["Files.ReadWrite.All"] as const;

export const MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION: IntegrationDefinition = {
  id: "microsoft-onedrive",
  name: "OneDrive",
  summary: "Drives, files, folders, sharing links, and permissions.",
  protocol: "openapi",
  provider: { id: "microsoft", domain: "graph.microsoft.com" },
  source: {
    kind: "openapi",
    url: MICROSOFT_GRAPH_OPENAPI_URL,
    pinned: MICROSOFT_GRAPH_OPENAPI_PIN,
    schemaMode: "provider_validated_json",
    operationAllowlist: [
      {
        path: "/me/drive",
        method: "get",
        summary: "Get my drive",
        requiredScopes: FILES_SCOPE,
        description:
          "Read the signed-in person's OneDrive, including its id, which the other file tools take as drive-id.",
      },
      {
        path: "/me/drives",
        method: "get",
        summary: "List drives",
        requiredScopes: FILES_SCOPE,
        description: "List the drives the signed-in person can use, with their ids.",
      },
      {
        path: "/drives/{drive-id}/items/{driveItem-id}/children",
        method: "get",
        summary: "List folder contents",
        odataSkipToken: true,
        requiredScopes: FILES_SCOPE,
        description:
          "List the files and folders in a folder. Use driveItem-id root for the top of the drive.",
      },
      {
        path: "/drives/{drive-id}/items/{driveItem-id}",
        method: "get",
        summary: "Get file or folder",
        requiredScopes: FILES_SCOPE,
        description:
          "Read a file or folder by its id. A file's response includes @microsoft.graph.downloadUrl, a short-lived pre-authenticated link to its content.",
      },
      {
        path: "/drives/{drive-id}/items/{driveItem-id}",
        method: "get",
        operationId: "drives.getItemByPath",
        summary: "Get file or folder by path",
        requestPath: "/drives/{drive-id}/root:/{+path}",
        pathParameterDescriptions: {
          path: "The item's path from the top of the drive, for example Documents/Plan.docx, as plain text.",
        },
        requiredScopes: FILES_SCOPE,
        description: "Read a file or folder by its path from the top of the drive.",
      },
      {
        path: "/drives/{drive-id}/search(q='{q}')",
        method: "get",
        summary: "Search files",
        requiredScopes: FILES_SCOPE,
        description: "Search the drive's file and folder names, content and metadata for q.",
      },
      {
        path: "/drives/{drive-id}/recent()",
        method: "get",
        summary: "List recent files",
        requiredScopes: FILES_SCOPE,
        description: "List the files the signed-in person used recently.",
      },
      {
        path: "/drives/{drive-id}/items/{driveItem-id}/content",
        method: "get",
        summary: "Download file",
        requiredScopes: FILES_SCOPE,
        description: "Download a file's content by its id.",
      },
      {
        path: "/drives/{drive-id}/items/{driveItem-id}/content",
        method: "put",
        operationId: "drives.uploadFile",
        summary: "Upload file",
        requestPath: "/drives/{drive-id}/items/{driveItem-id}:/{+path}:/content",
        pathParameterDescriptions: {
          path: "The new file's name, or its path below the folder, for example notes.txt, as plain text.",
        },
        requiredScopes: FILES_SCOPE,
        description:
          "Upload a small file (up to 4 MB) into a folder, creating it or replacing a file with the same name. driveItem-id is the folder's id, or root for the top of the drive. Send the file's text as the body.",
      },
      {
        path: "/drives/{drive-id}/items/{driveItem-id}/content",
        method: "put",
        summary: "Replace file content",
        requiredScopes: FILES_SCOPE,
        description:
          "Replace an existing file's content (up to 4 MB) by its id. Send the file's text as the body.",
      },
      {
        path: "/drives/{drive-id}/items/{driveItem-id}/children",
        method: "post",
        summary: "Create folder",
        requiredScopes: FILES_SCOPE,
        description:
          'Create a folder inside a folder (driveItem-id root for the top of the drive). Send {"name":"...","folder":{},"@microsoft.graph.conflictBehavior":"rename"}.',
      },
      {
        path: "/drives/{drive-id}/items/{driveItem-id}",
        method: "patch",
        summary: "Move or rename",
        requiredScopes: FILES_SCOPE,
        description:
          'Rename a file or folder with {"name":"..."}, or move it with {"parentReference":{"id":"<folder id>"}}.',
      },
      {
        path: "/drives/{drive-id}/items/{driveItem-id}",
        method: "delete",
        summary: "Delete file or folder",
        requiredScopes: FILES_SCOPE,
        description: "Delete a file or folder by its id; it moves to the recycle bin.",
      },
      {
        path: "/drives/{drive-id}/items/{driveItem-id}/copy",
        method: "post",
        summary: "Copy file or folder",
        requiredScopes: FILES_SCOPE,
        description:
          'Copy a file or folder. Send {"parentReference":{"driveId":"...","id":"<folder id>"},"name":"..."}. The copy finishes in the background.',
      },
      {
        path: "/drives/{drive-id}/items/{driveItem-id}/createLink",
        method: "post",
        summary: "Create sharing link",
        requiredScopes: FILES_SCOPE,
        description:
          'Create a sharing link to a file or folder. Send {"type":"view" or "edit","scope":"organization" or "anonymous"}. Returns the link URL.',
      },
      {
        path: "/drives/{drive-id}/items/{driveItem-id}/invite",
        method: "post",
        summary: "Share with people",
        requiredScopes: FILES_SCOPE,
        description:
          'Share a file or folder with people. Send {"recipients":[{"email":"..."}],"roles":["read"] or ["write"],"requireSignIn":true,"sendInvitation":true,"message":"..."}.',
      },
      {
        path: "/drives/{drive-id}/items/{driveItem-id}/permissions",
        method: "get",
        summary: "List sharing permissions",
        requiredScopes: FILES_SCOPE,
        description: "List who a file or folder is shared with, and its sharing links.",
      },
      {
        path: "/drives/{drive-id}/items/{driveItem-id}/versions",
        method: "get",
        summary: "List file versions",
        requiredScopes: FILES_SCOPE,
        description: "List the earlier versions of a file.",
      },
      {
        path: "/shares/{sharedDriveItem-id}/driveItem",
        method: "get",
        summary: "Open sharing link",
        requiredScopes: FILES_SCOPE,
        description:
          "Read the file or folder a sharing link points to. sharedDriveItem-id is u! followed by the link URL, base64url-encoded without padding.",
      },
    ],
    genericPathScope: {
      prefixes: ["/me/drive", "/me/drives", "/drives", "/shares"],
      // Excel's nested workbook API is a separate surface, not file management.
      excludedPrefixes: ["/drives/{drive-id}/items/{driveItem-id}/workbook"],
    },
  },
  baseUrl: MICROSOFT_GRAPH_BASE_URL,
  authentication: microsoftOAuth(["Files.ReadWrite.All"]),
  facets: [accountIdentityFacet("microsoft")],
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
    pinned: MICROSOFT_GRAPH_OPENAPI_PIN,
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
          'Search SharePoint and OneDrive files, lists, list items and sites the signed-in person can access. Send {"requests":[{"entityTypes":["driveItem","listItem","list","site"],"query":{"queryString":"..."},"from":0,"size":25}]}. Use entityTypes driveItem for files, listItem for list items, list for lists and libraries, site for sites and drive for document libraries; one request may combine any of them, which finds content whatever its kind. List rows are listItem results, not driveItem. KQL is supported in queryString (for example filetype:docx or path:"https://contoso.sharepoint.com/sites/hr"). Page with from and size. Only driveItem, listItem, list, site and drive can be searched here.',
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
        // Graph rejects a server-relative path inside the function call's
        // quotes; its colon form addresses the same site.
        requestPath: "/sites/{site-id}:/{+path}",
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
        description:
          "List a site's lists and document libraries with their ids and names. Read a list's rows with the list items tool.",
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
          "Read a file or folder in a document library: its name, size, dates and web link. Read a file's content with the download file tool.",
      },
      {
        path: "/drives/{drive-id}/items/{driveItem-id}/content",
        method: "get",
        summary: "Download file",
        requiredScopes: SHAREPOINT_SCOPE,
        description: "Download a document library file's content by its drive id and item id.",
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
      ...directoryLookupOperations("User.ReadBasic.All"),
    ],
  },
  baseUrl: MICROSOFT_GRAPH_BASE_URL,
  authentication: {
    ...microsoftOAuth([...SHAREPOINT_SCOPE, "User.ReadBasic.All"]),
    authorizationUrl: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
  },
  facets: [accountIdentityFacet("microsoft")],
};

/** Delegated work/school account access. Message sends use the connected human. */
export const MICROSOFT_TEAMS_INTEGRATION_DEFINITION: IntegrationDefinition = {
  id: "microsoft-teams",
  name: "Microsoft Teams",
  summary:
    "Read and search teams, channels and chats, look up colleagues, and send messages as your connected Microsoft account.",
  protocol: "openapi",
  provider: { id: "microsoft", domain: "graph.microsoft.com" },
  source: {
    kind: "openapi",
    url: MICROSOFT_GRAPH_OPENAPI_URL,
    pinned: MICROSOFT_GRAPH_OPENAPI_PIN,
    schemaMode: "provider_validated_json",
    // No tenant-wide export, membership/admin changes, app installation, or beta APIs.
    operationAllowlist: [
      {
        path: "/search/query",
        method: "post",
        readOnly: true,
        searchEntityTypes: ["chatMessage"],
        requiredScopes: ["Chat.Read", "ChannelMessage.Read.All"],
        description:
          'Search Teams chat and channel messages the signed-in person can access, using the same index as the Teams search box. Send {"requests":[{"entityTypes":["chatMessage"],"query":{"queryString":"..."},"from":0,"size":25}]}, with exactly one entry in requests per call. KQL is supported in queryString, for example pricing from:"Anna Larsen". Page with from and size; for messages, total counts only the current page, so use moreResultsAvailable to decide whether to fetch more. Sorting is not supported. Hits include a summary and the message\'s chat or channel ids; read the full message or thread with the chat and channel message tools. Only chatMessage can be searched here.',
      },
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
        // Graph declares these here but supports only $top and $expand; it
        // answers $orderby with "Query option 'OrderBy' is not allowed".
        omitQueryParameters: ["$orderby", "$skip", "$search", "$filter", "$count"],
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
      ...directoryLookupOperations("User.Read.All"),
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
      "User.Read.All",
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
        `${entry.method} ${entry.requestPath ? requestPathTemplate(entry.requestPath) : entry.path}`,
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

/** One operation a definition's generic path tools can find and call. */
export interface GenericPathOperation {
  readonly method: "get" | "put" | "post" | "delete" | "patch";
  readonly path: string;
  readonly summary?: string;
  /** Delegated scope alternatives the provider document declares, if any. */
  readonly scopes?: readonly (readonly string[])[];
}

const GENERIC_PATH_METHODS = ["get", "put", "post", "delete", "patch"] as const;
const GENERIC_PATH_SUMMARY_CHARS = 200;

/**
 * The operations under a definition's opted-in generic path scope, read from
 * the full (unfiltered) provider document. Empty when it hasn't opted in.
 */
export function genericPathScopeOperations(
  document: Record<string, unknown>,
  definition: IntegrationDefinition,
): readonly GenericPathOperation[] {
  if (definition.source.kind !== "openapi" || !definition.source.genericPathScope) return [];
  const scope = definition.source.genericPathScope;
  if (!isRecord(document.paths)) return [];
  const under = (path: string, prefixes: readonly string[]) =>
    prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  const documentScopes = securityScopes(document.security);
  const operations: GenericPathOperation[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    if (!under(path, scope.prefixes) || under(path, scope.excludedPrefixes ?? [])) continue;
    if (!isRecord(item)) continue;
    for (const method of GENERIC_PATH_METHODS) {
      const operation = item[method];
      if (!isRecord(operation)) continue;
      const text =
        typeof operation.summary === "string" && operation.summary.trim()
          ? operation.summary.trim()
          : typeof operation.description === "string"
            ? operation.description.trim()
            : "";
      const scopes =
        operation.security === undefined ? documentScopes : securityScopes(operation.security);
      operations.push({
        method,
        path,
        ...(text ? { summary: text.slice(0, GENERIC_PATH_SUMMARY_CHARS) } : {}),
        ...(scopes.length > 0 ? { scopes } : {}),
      });
    }
  }
  return operations.sort((left, right) =>
    left.path === right.path
      ? left.method.localeCompare(right.method)
      : left.path < right.path
        ? -1
        : 1,
  );
}

function securityScopes(value: unknown): readonly (readonly string[])[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): string[][] => {
    if (!isRecord(entry)) return [];
    const scopes = Object.values(entry).flatMap((raw) =>
      Array.isArray(raw) ? raw.filter((scope): scope is string => typeof scope === "string") : [],
    );
    return scopes.length > 0 ? [[...new Set(scopes)].sort()] : [];
  });
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
  const entries = Object.entries(document.paths)
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
    .flatMap<[string, unknown]>(([path, item]) => {
      if (!operationAllowlist) return [[path, item]];
      if (!isRecord(item)) return [];
      const selected = operationAllowlist.filter((entry) => entry.path === path);
      const reviewedOperations = selected
        .filter(({ method }) => isRecord(item[method]))
        .map(
          ({
            method,
            operationId,
            summary,
            requiredScopes,
            odataSkipToken,
            description,
            requestPath,
            pathParameterDescriptions,
            omitQueryParameters,
          }) => {
            const operation = item[method] as Record<string, unknown>;
            if (operation.$ref)
              throw new IntegrationProtocolError(
                "integration_definition_reference",
                "Reviewed operations must be inline OpenAPI operations",
              );
            const { servers: _servers, ...reviewed } = operation;
            const reserved = reservedPathParameters(requestPath);
            const omitQuery = omitQueryParameters ?? [];
            // A request path naming other path parameters than the provider's
            // path gets its own parameter list, matching the request path.
            const reshaped = requestPath
              ? reshapedPathParameters(document, item.parameters, reviewed.parameters, {
                  template: requestPathTemplate(requestPath),
                  reserved,
                  descriptions: pathParameterDescriptions ?? {},
                })
              : undefined;
            const parameters = reviewedParameters(document, reshaped ?? reviewed.parameters, {
              reserved,
              omitQuery,
            });
            return {
              path: requestPath ? requestPathTemplate(requestPath) : path,
              reserved,
              omitQuery,
              ownParameters: reshaped !== undefined,
              method,
              operation: {
                ...reviewed,
                ...(operationId ? { operationId } : {}),
                ...(summary ? { summary } : {}),
                ...((parameters ?? reshaped) ? { parameters: parameters ?? reshaped } : {}),
                // Reviewed guidance is long; keep a short name when the provider has no summary.
                ...(description
                  ? {
                      description,
                      ...(summary || (typeof reviewed.summary === "string" && reviewed.summary)
                        ? {}
                        : { summary: `${method.toUpperCase()} ${path}` }),
                    }
                  : {}),
                ...(odataSkipToken
                  ? {
                      parameters: [
                        ...(parameters ??
                          reshaped ??
                          (Array.isArray(reviewed.parameters) ? reviewed.parameters : [])),
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
              } as Record<string, unknown>,
            };
          },
        );
      if (reviewedOperations.length === 0) return [];
      // A shared query parameter an operation omits can only be removed by
      // moving the shared parameters into each operation.
      const sharedParameters = Array.isArray(item.parameters) ? item.parameters : [];
      const inlineShared = reviewedOperations.some(
        ({ omitQuery, ownParameters }) =>
          !ownParameters &&
          sharedParameters.some((parameter) => {
            const resolved = resolveParameter(document, parameter);
            return resolved?.in === "query" && omitQuery.includes(String(resolved.name));
          }),
      );
      // Preserve shared parameters and descriptions, but do not allow a path $ref
      // to reintroduce unreviewed methods or a provider override of the API origin.
      // An operation with a reviewed request path gets its own path item.
      const byPath = new Map<string, Record<string, unknown>>();
      const ownItems: [string, Record<string, unknown>][] = [];
      for (const reviewed of reviewedOperations) {
        if (reviewed.ownParameters) {
          // Its parameter list already includes the shared ones it keeps, so
          // it gets a path item of its own; a path it shares is merged below.
          ownItems.push([reviewed.path, { [reviewed.method]: reviewed.operation }]);
          continue;
        }
        const corrections = { reserved: reviewed.reserved, omitQuery: reviewed.omitQuery };
        let operation = reviewed.operation;
        if (inlineShared) {
          const merged = mergeParameters(document, sharedParameters, operation.parameters);
          operation = {
            ...operation,
            parameters: reviewedParameters(document, merged, corrections) ?? merged,
          };
        }
        const shared = inlineShared
          ? undefined
          : reviewedParameters(document, item.parameters, { ...corrections, omitQuery: [] });
        const pathItem = byPath.get(reviewed.path) ?? {
          ...(item.parameters && !inlineShared ? { parameters: shared ?? item.parameters } : {}),
          ...(item.summary ? { summary: item.summary } : {}),
          ...(item.description ? { description: item.description } : {}),
        };
        pathItem[reviewed.method] = operation;
        byPath.set(reviewed.path, pathItem);
      }
      return [...byPath, ...ownItems];
    });
  // A reviewed request path can name a path another operation already uses;
  // their methods are merged rather than one path item replacing the other.
  const paths: Record<string, unknown> = {};
  for (const [path, item] of entries) {
    const existing = paths[path];
    paths[path] =
      existing === undefined ? item : mergePathItems(document, definition, path, existing, item);
  }
  if (Object.keys(paths).length === 0) {
    throw new IntegrationProtocolError(
      "integration_definition_empty",
      `${definition.name} did not match any operations in the supplied OpenAPI document`,
    );
  }
  for (const [key, text] of Object.entries(definition.source.operationText ?? {})) {
    const [method, ...rest] = key.split(" ");
    const pathItem = paths[rest.join(" ")];
    const operation = isRecord(pathItem) && method ? pathItem[method] : undefined;
    if (!isRecord(pathItem) || !isRecord(operation) || operation.$ref) continue;
    paths[rest.join(" ")] = { ...pathItem, [method!]: { ...operation, ...text } };
  }
  return {
    ...document,
    paths,
    servers: [{ url: definition.baseUrl }],
  };
}

/** Path parameters a reviewed request path expands as paths (`{+name}`). */
function reservedPathParameters(requestPath: string | undefined): readonly string[] {
  return [...(requestPath ?? "").matchAll(/\{\+([^}]+)\}/g)].map((match) => match[1]!);
}

/**
 * The parameters of an operation sent on a reviewed request path, when that
 * path names other path parameters than the provider's: path parameters it
 * doesn't name are dropped and ones only it names are added as required
 * strings. Undefined when the path parameters already match, so existing
 * operations keep their bytes.
 */
function reshapedPathParameters(
  document: Record<string, unknown>,
  shared: unknown,
  own: unknown,
  input: {
    template: string;
    reserved: readonly string[];
    descriptions: Readonly<Record<string, string>>;
  },
): unknown[] | undefined {
  const names = [...input.template.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
  const merged = mergeParameters(document, shared, own);
  const pathNames = merged.flatMap((parameter) => {
    const resolved = resolveParameter(document, parameter);
    return resolved?.in === "path" ? [String(resolved.name)] : [];
  });
  if (
    pathNames.every((name) => names.includes(name)) &&
    names.every((name) => pathNames.includes(name))
  ) {
    return undefined;
  }
  const kept = merged.filter((parameter) => {
    const resolved = resolveParameter(document, parameter);
    return resolved?.in !== "path" || names.includes(String(resolved.name));
  });
  const added = names
    .filter((name) => !pathNames.includes(name))
    .map((name) => ({
      name,
      in: "path",
      required: true,
      ...(input.reserved.includes(name) ? { allowReserved: true } : {}),
      description:
        input.descriptions[name] ??
        (input.reserved.includes(name) ? RESERVED_PATH_PARAMETER_DESCRIPTION : name),
      schema: { type: "string" },
    }));
  return [...kept, ...added];
}

/** A reviewed request path as an OpenAPI path template (`{+name}` is `{name}`). */
export function requestPathTemplate(requestPath: string): string {
  return requestPath.replace(/\{\+([^}]+)\}/g, "{$1}");
}

const OPENAPI_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** A parameter object, following local references (`#/...`). */
function resolveParameter(
  document: Record<string, unknown>,
  parameter: unknown,
): Record<string, unknown> | undefined {
  let current = parameter;
  for (let depth = 0; depth < 8; depth++) {
    if (!isRecord(current)) return undefined;
    const ref = current.$ref;
    if (typeof ref !== "string") return current;
    if (!ref.startsWith("#/")) return undefined;
    current = ref
      .slice(2)
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce<unknown>((value, part) => (isRecord(value) ? value[part] : undefined), document);
  }
  return undefined;
}

/** Shared path-level parameters an operation does not override, then its own. */
function mergeParameters(
  document: Record<string, unknown>,
  shared: unknown,
  own: unknown,
): unknown[] {
  const ownList = Array.isArray(own) ? own : [];
  const key = (parameter: unknown) => {
    const resolved = resolveParameter(document, parameter);
    return resolved ? `${String(resolved.in)} ${String(resolved.name)}` : undefined;
  };
  const overridden = new Set(ownList.map(key).filter(Boolean));
  const sharedList = Array.isArray(shared) ? shared : [];
  return [...sharedList.filter((parameter) => !overridden.has(key(parameter))), ...ownList];
}

/** A path item whose shared parameters are moved into each operation. */
function withInlineParameters(
  document: Record<string, unknown>,
  item: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(item.parameters)) return item;
  const { parameters: shared, ...rest } = item;
  for (const method of OPENAPI_METHODS) {
    const operation = rest[method];
    if (isRecord(operation)) {
      rest[method] = {
        ...operation,
        parameters: mergeParameters(document, shared, operation.parameters),
      };
    }
  }
  return rest;
}

function mergePathItems(
  document: Record<string, unknown>,
  definition: IntegrationDefinition,
  path: string,
  first: unknown,
  second: unknown,
): Record<string, unknown> {
  if (!isRecord(first) || !isRecord(second)) {
    throw new IntegrationProtocolError(
      "integration_definition_path",
      `${definition.name} has an invalid path item for ${path}`,
    );
  }
  const merged = withInlineParameters(document, first);
  const other = withInlineParameters(document, second);
  for (const method of OPENAPI_METHODS) {
    if (other[method] === undefined) continue;
    if (merged[method] !== undefined) {
      throw new IntegrationProtocolError(
        "integration_definition_duplicate_operation",
        `${definition.name} defines ${method.toUpperCase()} ${path} twice`,
      );
    }
    merged[method] = other[method];
  }
  return merged;
}

/** Generic guidance for a path parameter expanded as a path. */
const RESERVED_PATH_PARAMETER_DESCRIPTION =
  "A /-separated path as plain text, without quotes; segments are encoded for you.";

/**
 * Parameters with reviewed corrections: reserved path parameters are marked
 * `allowReserved` with path guidance, and query parameters the provider
 * rejects are dropped. Undefined when nothing changes, so unchanged
 * operations keep their bytes.
 */
function reviewedParameters(
  document: Record<string, unknown>,
  value: unknown,
  corrections: { reserved: readonly string[]; omitQuery: readonly string[] },
): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (corrections.reserved.length === 0 && corrections.omitQuery.length === 0) return undefined;
  return value.flatMap((parameter) => {
    const resolved = resolveParameter(document, parameter);
    if (!resolved) return [parameter];
    if (resolved.in === "query" && corrections.omitQuery.includes(String(resolved.name))) return [];
    if (resolved.in === "path" && corrections.reserved.includes(String(resolved.name)))
      return [
        {
          ...resolved,
          allowReserved: true,
          // A parameter a reviewed request path added keeps its reviewed text.
          description:
            resolved.allowReserved === true && typeof resolved.description === "string"
              ? resolved.description
              : RESERVED_PATH_PARAMETER_DESCRIPTION,
        },
      ];
    return [parameter];
  });
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
