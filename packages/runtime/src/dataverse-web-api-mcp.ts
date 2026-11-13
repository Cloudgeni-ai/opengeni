import {
  MCP_TOOL_RECOMMENDED_PERMISSION_META_KEY,
  type McpServerConnectionRef,
  type ToolAuthNeededPayload,
} from "@opengeni/contracts";
import {
  DATAVERSE_WEB_API_PATH,
  dataverseWebApiBase,
  microsoftDynamicsProductForMcpUrl,
} from "@opengeni/contracts/microsoft-dynamics";
import {
  defineLocalMcpBridgeDescriptor,
  IntegrationInvocationError,
  type LocalMcpBridgeAdapter,
  type LocalMcpBridgeDescriptor,
  type LocalMcpBridgeServer,
} from "@opengeni/capabilities";
import { readResponseJsonBounded, type FetchLike } from "@opengeni/network";
import type { MCPServer } from "@openai/agents";
import { isRoutingMutationOutcomeUnknownError } from "./sandbox/routing/routing-session";

/**
 * Dataverse (Dynamics 365 Sales, Customer Service and other model-driven apps)
 * through the environment's Web API. The connection is created for the
 * environment's MCP endpoint (`https://<org>.crm*.dynamics.com/api/mcp`); its
 * delegated grant (`user_impersonation`) also covers the Web API, which needs
 * no Managed Environment, MCP client allow-list or Copilot Credits and has no
 * small row cap. This bridge therefore replaces the hosted MCP server: one
 * generic tool set, run as the signed-in user with their own security roles.
 */

const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 5000;
const TABLE_LIST_LIMIT = 300;
const ENTITY_SET = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const LOGICAL_NAME = /^[a-z_][a-z0-9_]{0,127}$/u;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ANNOTATIONS =
  'odata.include-annotations="OData.Community.Display.V1.FormattedValue,Microsoft.Dynamics.CRM.lookuplogicalname,Microsoft.Dynamics.CRM.associatednavigationproperty,Microsoft.Dynamics.CRM.totalrecordcount,Microsoft.Dynamics.CRM.morerecords,Microsoft.Dynamics.CRM.fetchxmlpagingcookie"';
/** Shorter names for the annotations the model reads most. */
const ANNOTATION_ALIASES: readonly [string, string][] = [
  ["@OData.Community.Display.V1.FormattedValue", "@label"],
  ["@Microsoft.Dynamics.CRM.lookuplogicalname", "@table"],
  ["@Microsoft.Dynamics.CRM.associatednavigationproperty", "@navigation"],
];

type DataverseTool = Awaited<ReturnType<MCPServer["listTools"]>>[number] & {
  annotations: Record<string, boolean>;
  _meta?: Record<string, unknown>;
};

const recordShape = {
  type: "object",
  description:
    'Column values by logical name. Set a lookup with "<navigation property>@odata.bind": "/<entity set>(<id>)"; dataverse_describe_table lists each lookup\'s navigation property and target tables.',
  additionalProperties: true,
};
const entitySet = {
  type: "string",
  description: "Entity set name of the table, for example accounts, contacts or opportunities.",
  pattern: ENTITY_SET.source,
};
const recordId = { type: "string", description: "The record's id (GUID).", pattern: GUID.source };
const pageSize = {
  type: "integer",
  minimum: 1,
  maximum: MAX_PAGE_SIZE,
  description: `Rows per page (default ${DEFAULT_PAGE_SIZE}, at most ${MAX_PAGE_SIZE}).`,
};

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  effect: "read" | "write" | "delete",
): DataverseTool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: {
      readOnlyHint: effect === "read",
      destructiveHint: effect === "delete",
      idempotentHint: effect !== "write",
      openWorldHint: true,
    },
    // Changes to business records ask first unless the workspace chooses otherwise.
    ...(effect === "read" ? {} : { _meta: { [MCP_TOOL_RECOMMENDED_PERMISSION_META_KEY]: "ask" } }),
  } as DataverseTool;
}

export const DATAVERSE_WEB_API_TOOLS: readonly DataverseTool[] = Object.freeze([
  tool(
    "dataverse_list_tables",
    `Lists tables in the connected Dynamics 365 / Dataverse environment: logical name, entity set name (used in queries) and display name. Filter with search; at most ${TABLE_LIST_LIMIT} tables are returned.`,
    {
      search: {
        type: "string",
        maxLength: 128,
        description: "Case-insensitive text matched against logical and display names.",
      },
    },
    [],
    "read",
  ),
  tool(
    "dataverse_describe_table",
    "Describes one table: its entity set, primary id and name columns, and each column's type, label and requirement, with choice values and labels, and each lookup's target tables and navigation property for @odata.bind.",
    {
      table: {
        type: "string",
        description: "Logical name of the table, for example account or opportunity.",
        pattern: LOGICAL_NAME.source,
      },
    },
    ["table"],
    "read",
  ),
  tool(
    "dataverse_query",
    "Reads Dataverse data with an OData query relative to the Web API root, for example accounts?$select=name,revenue&$filter=statecode eq 0&$orderby=revenue desc&$top=10, opportunities?$apply=groupby((stepname),aggregate(estimatedvalue_base with sum as total)), accounts(<id>)?$expand=contact_customer_accounts($select=fullname), or a function such as WhoAmI(). Choice and lookup values come with readable labels (<column>@label). Pass a returned nextLink as path to read the next page.",
    {
      path: {
        type: "string",
        minLength: 1,
        maxLength: 16_384,
        description: "Entity set or function with OData query options; no leading slash.",
      },
      pageSize,
    },
    ["path"],
    "read",
  ),
  tool(
    "dataverse_fetchxml",
    "Runs a FetchXML query, including aggregates and grouping by date (dategrouping year, quarter, month, week or day) and linked tables. When a result has moreRecords, read the next page by setting the page attribute of <fetch> to nextPage and its paging-cookie attribute to pagingCookie (already escaped for the attribute); count sets the page size.",
    {
      table: entitySet,
      fetchXml: { type: "string", minLength: 1, maxLength: 16_384 },
    },
    ["table", "fetchXml"],
    "read",
  ),
  tool(
    "dataverse_create_record",
    "Creates a record and returns it.",
    { table: entitySet, record: recordShape },
    ["table", "record"],
    "write",
  ),
  tool(
    "dataverse_update_record",
    "Updates columns of an existing record and returns it. Only the given columns change.",
    { table: entitySet, id: recordId, record: recordShape },
    ["table", "id", "record"],
    "write",
  ),
  tool(
    "dataverse_delete_record",
    "Deletes a record permanently.",
    { table: entitySet, id: recordId },
    ["table", "id"],
    "delete",
  ),
]);

type CredentialResult =
  | {
      status: "ok";
      headers: Record<string, string>;
      connectionId: string;
      authorizeProviderRequest?: () => Promise<boolean>;
    }
  | {
      status: "auth_needed";
      reason: ToolAuthNeededPayload["reason"];
      providerDomain: string;
      authoritySource?: "host";
      provider?: string;
      connectionId?: string;
      scopes?: string[];
      resource?: string;
      authorizationUrl?: string;
    };
type Credential = Extract<CredentialResult, { status: "ok" }>;

export type DataverseWebApiMcpServerOptions = {
  workspaceId: string;
  subjectId?: string;
  serverId: string;
  mcpUrl: string;
  connectionRef: McpServerConnectionRef;
  resolveCredential: (input: {
    workspaceId: string;
    subjectId?: string;
    serverId: string;
    toolName?: string;
    connectionRef: McpServerConnectionRef;
    destinationUrl: string;
    forceRefresh?: boolean;
  }) => Promise<CredentialResult>;
  onAuthNeeded?: (payload: ToolAuthNeededPayload) => void | Promise<void>;
  onResolvedConnectionId?: (connectionId: string) => void;
  fetchImpl?: FetchLike;
};
export type DataverseWebApiMcpBridgeConfig = {
  readonly url: string;
  readonly connectionRef?: McpServerConnectionRef;
};
export type DataverseWebApiMcpBridgeContext = Omit<
  DataverseWebApiMcpServerOptions,
  "connectionRef" | "mcpUrl"
>;

/** A Dataverse MCP endpoint connected through its own environment's OAuth grant. */
export function isDataverseMcpConfig(
  url: string,
  connectionRef: McpServerConnectionRef | undefined,
): boolean {
  if (microsoftDynamicsProductForMcpUrl(url) !== "dataverse") return false;
  return (
    connectionRef?.kind === "oauth2" &&
    connectionRef.providerDomain.toLowerCase() === new URL(url).hostname.toLowerCase()
  );
}

type Request = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path below the Web API root, already encoded. */
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Rows per page for reads; null leaves paging to the query itself (FetchXML count). */
  pageSize?: number | null;
};

export class DataverseWebApiMcpServer implements LocalMcpBridgeServer {
  readonly name: string;
  readonly cacheToolsList = false;
  readonly bridge: LocalMcpBridgeDescriptor;
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private connectionId: string | undefined;

  constructor(private readonly options: DataverseWebApiMcpServerOptions) {
    const base = dataverseWebApiBase(options.mcpUrl);
    if (!base) throw new Error("Dataverse bridge requires a Dataverse MCP endpoint");
    this.base = base;
    this.name = `opengeni-dataverse-${options.serverId.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 80)}`;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.bridge = defineLocalMcpBridgeDescriptor({
      adapterId: "dataverse-web-api",
      providerId: "microsoft-dynamics",
      catalogIdentity: `mcp:${options.mcpUrl}`,
      authority: "connection",
      toolSurface: "static_reviewed",
      mutationReplay: "safe_reads_only",
      destinations: [{ origin: new URL(base).origin, pathPrefix: DATAVERSE_WEB_API_PATH }],
    });
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async invalidateToolsCache(): Promise<void> {}

  async listTools(): Promise<Awaited<ReturnType<MCPServer["listTools"]>>> {
    // Surfaces a missing or expired connection before the model sees the tools.
    await this.resolve(`${this.base}WhoAmI`, undefined, false);
    // Naming the environment lets the agent tell connections apart and notice
    // when a request is about an environment that isn't connected yet.
    const environment = new URL(this.base).hostname;
    return DATAVERSE_WEB_API_TOOLS.map((entry) => ({
      ...structuredClone(entry),
      description: `${entry.description} Environment: ${environment}.`,
    }));
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
    options?: { signal?: AbortSignal },
  ): Promise<any> {
    return (await this.callToolResult(toolName, args, meta, options)).content;
  }

  async callToolResult(
    toolName: string,
    args: Record<string, unknown> | null,
    _meta?: Record<string, unknown> | null,
    options?: { signal?: AbortSignal },
  ): Promise<any> {
    try {
      const output = await this.run(toolName, args ?? {}, options?.signal);
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      if (
        error instanceof DataverseMutationOutcomeUnknownError ||
        isRoutingMutationOutcomeUnknownError(error)
      )
        throw error;
      const message =
        error instanceof DataverseError ? error.message : "Dataverse tool failed. Try again.";
      const code = error instanceof DataverseError ? error.code : undefined;
      return {
        isError: true,
        content: [{ type: "text", text: message }],
        // Typed, so hosts such as a Site frame can offer Reconnect or say
        // plainly that Microsoft Dynamics refused it; nothing ran either way.
        ...(code
          ? {
              structuredContent: {
                error: { code, message, retryable: false, outcomeUnknown: false },
              },
            }
          : {}),
      };
    }
  }

  private async run(
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    switch (toolName) {
      case "dataverse_list_tables":
        return await this.listTables(optionalString(args.search, "search", 128), signal);
      case "dataverse_describe_table":
        return await this.describeTable(identifier(args.table, LOGICAL_NAME, "table"), signal);
      case "dataverse_query": {
        const path = this.queryPath(requiredString(args.path, "path"));
        const payload = await this.request(
          toolName,
          { method: "GET", path, pageSize: pageSizeArg(args.pageSize) },
          signal,
        );
        return this.page(payload);
      }
      case "dataverse_fetchxml": {
        const table = identifier(args.table, ENTITY_SET, "table");
        const fetchXml = requiredString(args.fetchXml, "fetchXml").trim();
        if (!fetchXml.startsWith("<fetch"))
          throw new DataverseError("fetchXml must be a <fetch> document.");
        const payload = await this.request(
          toolName,
          {
            method: "GET",
            path: `${table}?fetchXml=${encodeURIComponent(fetchXml)}`,
            // Dataverse lets a page-size preference override the FetchXML count.
            ...(/^<fetch\b[^>]*\scount\s*=/iu.test(fetchXml) ? { pageSize: null } : {}),
          },
          signal,
        );
        return this.page(payload);
      }
      case "dataverse_create_record": {
        const table = identifier(args.table, ENTITY_SET, "table");
        const payload = await this.request(
          toolName,
          {
            method: "POST",
            path: table,
            body: recordArg(args.record),
            headers: { prefer: "return=representation" },
          },
          signal,
        );
        return { record: withoutEmpty(tidy(payload)) };
      }
      case "dataverse_update_record": {
        const table = identifier(args.table, ENTITY_SET, "table");
        const id = identifier(args.id, GUID, "id");
        const payload = await this.request(
          toolName,
          {
            method: "PATCH",
            path: `${table}(${id})`,
            body: recordArg(args.record),
            // Update only: never create a record when the id does not exist.
            headers: { prefer: "return=representation", "if-match": "*" },
          },
          signal,
        );
        return { record: withoutEmpty(tidy(payload)) };
      }
      case "dataverse_delete_record": {
        const table = identifier(args.table, ENTITY_SET, "table");
        const id = identifier(args.id, GUID, "id");
        await this.request(toolName, { method: "DELETE", path: `${table}(${id})` }, signal);
        return { deleted: true, table, id };
      }
      default:
        throw new DataverseError(`Unknown Dataverse tool ${toolName}.`);
    }
  }

  private async listTables(search: string | undefined, signal: AbortSignal | undefined) {
    const payload = await this.request(
      "dataverse_list_tables",
      {
        method: "GET",
        path: "EntityDefinitions?$select=LogicalName,EntitySetName,DisplayName,IsCustomEntity&$filter=IsPrivate%20eq%20false%20and%20IsIntersect%20eq%20false",
      },
      signal,
    );
    const needle = search?.toLowerCase();
    const tables = arrayOf(payload.value)
      .map((entry) => ({
        table: stringOf(entry.LogicalName),
        entitySet: stringOf(entry.EntitySetName),
        name: labelOf(entry.DisplayName),
        ...(entry.IsCustomEntity === true ? { custom: true } : {}),
      }))
      .filter((entry) => entry.table && entry.entitySet)
      .filter(
        (entry) =>
          !needle ||
          entry.table.includes(needle) ||
          entry.entitySet.toLowerCase().includes(needle) ||
          (entry.name ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) => a.table.localeCompare(b.table));
    return {
      tables: tables.slice(0, TABLE_LIST_LIMIT),
      ...(tables.length > TABLE_LIST_LIMIT
        ? { truncated: true, total: tables.length, hint: "Narrow the list with search." }
        : {}),
    };
  }

  private async describeTable(table: string, signal: AbortSignal | undefined) {
    const entity = `EntityDefinitions(LogicalName='${table}')`;
    const toolName = "dataverse_describe_table";
    const get = (path: string) => this.request(toolName, { method: "GET", path }, signal);
    const options = (cast: string) =>
      get(
        `${entity}/Attributes/Microsoft.Dynamics.CRM.${cast}?$select=LogicalName&$expand=OptionSet($select=Options)`,
      );
    const [definition, picklists, states, statuses, multi, booleans, relationships] =
      await Promise.all([
        get(
          `${entity}?$select=LogicalName,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute,DisplayName&$expand=Attributes($select=LogicalName,AttributeType,AttributeTypeName,DisplayName,RequiredLevel,IsValidForCreate,IsValidForUpdate,AttributeOf)`,
        ),
        options("PicklistAttributeMetadata"),
        options("StateAttributeMetadata"),
        options("StatusAttributeMetadata"),
        options("MultiSelectPicklistAttributeMetadata"),
        get(
          `${entity}/Attributes/Microsoft.Dynamics.CRM.BooleanAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=TrueOption,FalseOption)`,
        ),
        get(
          `${entity}/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName`,
        ),
      ]);
    const choices = new Map<string, { value: number; label: string | null }[]>();
    for (const payload of [picklists, states, statuses, multi])
      for (const attribute of arrayOf(payload.value)) {
        const optionSet = attribute.OptionSet as Record<string, unknown> | undefined;
        choices.set(
          stringOf(attribute.LogicalName),
          arrayOf(optionSet?.Options).map((option) => ({
            value: Number(option.Value),
            label: labelOf(option.Label),
          })),
        );
      }
    for (const attribute of arrayOf(booleans.value)) {
      const optionSet = attribute.OptionSet as Record<string, unknown> | undefined;
      const option = (value: unknown) => value as { Value?: unknown; Label?: unknown } | undefined;
      choices.set(
        stringOf(attribute.LogicalName),
        [option(optionSet?.FalseOption), option(optionSet?.TrueOption)]
          .filter((entry) => entry !== undefined)
          .map((entry) => ({
            value: Number(entry.Value),
            label: labelOf(entry.Label),
          })),
      );
    }
    const lookups = new Map<string, { table: string; bind: string }[]>();
    for (const relationship of arrayOf(relationships.value)) {
      const column = stringOf(relationship.ReferencingAttribute);
      const navigation = stringOf(relationship.ReferencingEntityNavigationPropertyName);
      if (!column || !navigation) continue;
      lookups.set(column, [
        ...(lookups.get(column) ?? []),
        { table: stringOf(relationship.ReferencedEntity), bind: `${navigation}@odata.bind` },
      ]);
    }
    const columns = arrayOf(definition.Attributes)
      .filter((attribute) => !attribute.AttributeOf)
      .map((attribute) => {
        const column = stringOf(attribute.LogicalName);
        const required = (attribute.RequiredLevel as { Value?: unknown } | undefined)?.Value;
        const typeName = (attribute.AttributeTypeName as { Value?: unknown } | undefined)?.Value;
        return {
          column,
          type:
            typeof typeName === "string"
              ? typeName.replace(/Type$/u, "")
              : stringOf(attribute.AttributeType),
          label: labelOf(attribute.DisplayName),
          ...(required === "ApplicationRequired" || required === "SystemRequired"
            ? { required: true }
            : {}),
          ...(attribute.IsValidForCreate === false && attribute.IsValidForUpdate === false
            ? { readOnly: true }
            : {}),
          ...(choices.has(column) ? { choices: choices.get(column) } : {}),
          ...(lookups.has(column) ? { lookup: lookups.get(column) } : {}),
        };
      })
      .sort((a, b) => a.column.localeCompare(b.column));
    return {
      table: stringOf(definition.LogicalName),
      entitySet: stringOf(definition.EntitySetName),
      name: labelOf(definition.DisplayName),
      primaryId: stringOf(definition.PrimaryIdAttribute),
      primaryName: stringOf(definition.PrimaryNameAttribute),
      columns,
    };
  }

  /** A relative OData path, or a nextLink this environment returned. */
  private queryPath(value: string): string {
    let path = value.trim();
    if (/^https:\/\//iu.test(path)) {
      if (!path.toLowerCase().startsWith(this.base.toLowerCase()))
        throw new DataverseError("path must be relative to this environment's Web API.");
      path = path.slice(this.base.length);
    }
    path = path.replace(/^\/+/u, "").replace(/^api\/data\/v[\d.]+\//iu, "");
    const resource = decodeUriComponentSafe(path.split("?")[0]!);
    if (
      !/^[A-Za-z_]/u.test(path) ||
      /(^|[/\\])\.\.?([/\\]|$)/u.test(resource) ||
      /^\$batch/iu.test(path) ||
      path.includes("#")
    )
      throw new DataverseError(
        "path must start with an entity set or function name, for example accounts?$top=5.",
      );
    return encodeQueryPath(path);
  }

  private page(payload: Record<string, unknown>): Record<string, unknown> {
    if (!Array.isArray(payload.value)) return { record: tidy(payload) };
    const nextLink = stringOf(payload["@odata.nextLink"]);
    const count = payload["@odata.count"] ?? payload["@Microsoft.Dynamics.CRM.totalrecordcount"];
    const cookie = stringOf(payload["@Microsoft.Dynamics.CRM.fetchxmlpagingcookie"]);
    return {
      rows: payload.value.map((row) =>
        row && typeof row === "object" && !Array.isArray(row)
          ? tidy(row as Record<string, unknown>)
          : row,
      ),
      ...(typeof count === "number" && count >= 0 ? { count } : {}),
      ...(nextLink
        ? {
            nextLink: nextLink.startsWith(this.base) ? nextLink.slice(this.base.length) : nextLink,
          }
        : {}),
      ...(payload["@Microsoft.Dynamics.CRM.morerecords"] === true
        ? { moreRecords: true, ...(cookie ? fetchXmlNextPage(cookie) : {}) }
        : {}),
    };
  }

  private async resolve(
    destinationUrl: string,
    toolName: string | undefined,
    forceRefresh: boolean,
  ): Promise<Credential> {
    const result = await this.options.resolveCredential({
      workspaceId: this.options.workspaceId,
      serverId: this.options.serverId,
      connectionRef: this.options.connectionRef,
      destinationUrl,
      forceRefresh,
      ...(toolName ? { toolName } : {}),
      ...(this.options.subjectId ? { subjectId: this.options.subjectId } : {}),
    });
    if (result.status === "auth_needed") {
      await this.reportAuthNeeded(result, toolName);
      throw new DataverseError(
        "Sign-in to Microsoft Dynamics is needed. Reconnect the Microsoft Dynamics connection.",
        "connection_auth_needed",
      );
    }
    if (this.connectionId && this.connectionId !== result.connectionId)
      throw new DataverseError("The Microsoft Dynamics connection changed during this attempt.");
    this.connectionId = result.connectionId;
    this.options.onResolvedConnectionId?.(result.connectionId);
    return result;
  }

  private async request(
    toolName: string,
    request: Request,
    signal: AbortSignal | undefined,
    refreshed = false,
  ): Promise<Record<string, unknown>> {
    const url = `${this.base}${request.path}`;
    const mutation = request.method !== "GET";
    const credential = await this.resolve(url, toolName, refreshed);
    if (credential.authorizeProviderRequest && !(await credential.authorizeProviderRequest()))
      throw new DataverseError("The Microsoft Dynamics connection is no longer available.");
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const prefer = [
      ANNOTATIONS,
      ...(request.method === "GET" && request.pageSize !== null
        ? [`odata.maxpagesize=${request.pageSize ?? DEFAULT_PAGE_SIZE}`]
        : []),
      ...(request.headers?.prefer ? [request.headers.prefer] : []),
    ].join(",");
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: request.method,
        headers: {
          ...credential.headers,
          accept: "application/json",
          "odata-version": "4.0",
          "odata-maxversion": "4.0",
          prefer,
          ...(request.headers?.["if-match"] ? { "if-match": request.headers["if-match"] } : {}),
          ...(request.body !== undefined
            ? { "content-type": "application/json; charset=utf-8" }
            : {}),
        },
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        redirect: "error",
        signal: deadline,
      });
    } catch {
      if (mutation) throw unknownOutcome();
      throw new DataverseError("Dataverse could not be reached. Try again.");
    }
    if (response.status === 401) {
      // Dataverse authenticates before it changes anything, so a 401 applied
      // nothing and one retry with a refreshed sign-in is safe for writes too.
      if (!refreshed) {
        await response.body?.cancel().catch(() => undefined);
        return await this.request(toolName, request, signal, true);
      }
      // A fresh sign-in Dataverse still refuses with its own error is about
      // the person (no access to this environment), not the sign-in; asking
      // them to reconnect would only loop.
      const refusal = await readResponseJsonBounded<unknown>(
        response,
        RESPONSE_MAX_BYTES,
        "Dataverse response",
        { signal: deadline },
      ).catch(() => null);
      const refusalMessage =
        refusal && typeof refusal === "object" && !Array.isArray(refusal)
          ? (refusal as { error?: { message?: unknown } }).error?.message
          : undefined;
      if (typeof refusalMessage === "string" && refusalMessage.trim())
        throw new DataverseError(
          `${dataverseErrorMessage(response, refusal as Record<string, unknown>)} The signed-in Microsoft account may not have access to this Dynamics environment; its Dynamics admin can add the user.`,
          "provider_permission_denied",
        );
      await this.reportAuthNeeded(
        {
          status: "auth_needed",
          reason: "expired",
          providerDomain: this.options.connectionRef.providerDomain,
          connectionId: credential.connectionId,
        },
        toolName,
      ).catch(() => undefined);
      // Dataverse authenticates before it changes anything, so a 401 applied nothing.
      throw new DataverseError(
        "Microsoft Dynamics rejected the sign-in. Reconnect the Microsoft Dynamics connection.",
        "connection_auth_needed",
      );
    }
    if (response.status === 204) {
      await response.body?.cancel().catch(() => undefined);
      return {};
    }
    let payload: Record<string, unknown> = {};
    try {
      const value = await readResponseJsonBounded<unknown>(
        response,
        RESPONSE_MAX_BYTES,
        "Dataverse response",
        { signal: deadline },
      );
      if (value && typeof value === "object" && !Array.isArray(value))
        payload = value as Record<string, unknown>;
    } catch {
      if (mutation && response.ok) throw unknownOutcome();
      if (response.ok)
        throw new DataverseError(
          "Dataverse returned more data than one result can hold. Select fewer columns or use a smaller pageSize.",
        );
    }
    if (response.ok) return payload;
    if (mutation && response.status >= 500) throw unknownOutcome();
    throw new DataverseError(
      dataverseErrorMessage(response, payload),
      response.status === 403 ? "provider_permission_denied" : undefined,
    );
  }

  private async reportAuthNeeded(
    result: Extract<CredentialResult, { status: "auth_needed" }>,
    toolName?: string,
  ): Promise<void> {
    if (this.options.connectionRef.subjectScope === "subject" && !this.options.subjectId) return;
    await this.options.onAuthNeeded?.({
      serverId: this.options.serverId,
      ...(toolName ? { toolName } : {}),
      providerDomain: result.providerDomain,
      reason: result.reason,
      ...(result.connectionId ? { connectionId: result.connectionId } : {}),
      ...(result.provider ? { provider: result.provider } : {}),
      ...(result.scopes ? { scopes: result.scopes } : {}),
      ...(result.resource ? { resource: result.resource } : {}),
      ...(result.authorizationUrl ? { authorizationUrl: result.authorizationUrl } : {}),
      ...(result.authoritySource === "host" || this.options.connectionRef.authoritySource === "host"
        ? { authoritySource: "host" as const }
        : {}),
      ...(this.options.subjectId ? { subjectId: this.options.subjectId } : {}),
    });
  }
}

export const DATAVERSE_WEB_API_MCP_BRIDGE_ADAPTER: LocalMcpBridgeAdapter<
  DataverseWebApiMcpBridgeConfig,
  DataverseWebApiMcpBridgeContext
> = Object.freeze({
  adapterId: "dataverse-web-api",
  matches: (config: DataverseWebApiMcpBridgeConfig) =>
    isDataverseMcpConfig(config.url, config.connectionRef),
  create: (config: DataverseWebApiMcpBridgeConfig, context: DataverseWebApiMcpBridgeContext) => {
    if (!config.connectionRef) throw new Error("Dataverse bridge requires a connection reference");
    return new DataverseWebApiMcpServer({
      ...context,
      mcpUrl: config.url,
      connectionRef: config.connectionRef,
    });
  },
});

/**
 * Microsoft's own message, with the next step for errors a person can fix.
 * Dataverse error bodies are `{ error: { code, message } }`.
 */
function dataverseErrorMessage(response: Response, payload: Record<string, unknown>): string {
  const error = payload.error as { code?: unknown; message?: unknown } | undefined;
  const raw = typeof error?.message === "string" ? error.message.trim() : "";
  const message = raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw;
  const prefix = `Dataverse returned ${response.status}${message ? `: ${message}` : "."}`;
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    return `${prefix} Try again${Number.isFinite(retryAfter) && retryAfter > 0 ? ` in ${Math.ceil(retryAfter)} seconds` : " shortly"}.`;
  }
  if (response.status === 403)
    return `${prefix} The signed-in user's Dynamics security roles don't allow this, or the user has no licence or access to this environment.`;
  return prefix;
}

function unknownOutcome(): DataverseMutationOutcomeUnknownError {
  return new DataverseMutationOutcomeUnknownError(
    "Dataverse did not confirm the change; it may or may not have been applied. Check the record before trying again.",
  );
}

/** Drops OData bookkeeping and shortens annotation names. */
function tidy(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "@odata.context" || key === "@odata.etag") continue;
    let alias = key;
    for (const [long, short] of ANNOTATION_ALIASES)
      if (alias.endsWith(long)) alias = `${alias.slice(0, -long.length)}${short}`;
    out[alias] = Array.isArray(value)
      ? value.map((item) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? tidy(item as Record<string, unknown>)
            : item,
        )
      : value && typeof value === "object"
        ? tidy(value as Record<string, unknown>)
        : value;
  }
  return out;
}

/** A written record returns every column; empty ones only add noise. */
function withoutEmpty(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
}

/**
 * The next page of a FetchXML result from Dataverse's paging cookie
 * annotation: its page number, and the cookie escaped for the `paging-cookie`
 * attribute of `<fetch>`.
 */
function fetchXmlNextPage(annotation: string): { nextPage?: number; pagingCookie?: string } {
  const page = Number(/pagenumber="(\d+)"/u.exec(annotation)?.[1]);
  const encoded = /pagingcookie="([^"]*)"/u.exec(annotation)?.[1];
  let cookie: string | undefined;
  if (encoded !== undefined) {
    try {
      cookie = decodeURIComponent(decodeURIComponent(encoded));
    } catch {
      cookie = undefined;
    }
  }
  return {
    ...(Number.isSafeInteger(page) && page > 0 ? { nextPage: page } : {}),
    ...(cookie
      ? {
          pagingCookie: cookie
            .replace(/&/gu, "&amp;")
            .replace(/</gu, "&lt;")
            .replace(/>/gu, "&gt;")
            .replace(/"/gu, "&quot;"),
        }
      : {}),
  };
}

function decodeUriComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Percent-encodes what a URL cannot carry (spaces, quotes, non-ASCII) and a
 * literal `+`, which servers read as a space in a query, while keeping the
 * caller's own `%XX` escapes as they are, so `'A %26 B'` stays one literal.
 */
export function encodeQueryPath(path: string): string {
  return path
    .replace(/%(?![0-9A-Fa-f]{2})/gu, "%25")
    .replace(/[^A-Za-z0-9\-._~!$&'()*,;=:@/?%]/gu, (character) => encodeURIComponent(character));
}

function arrayOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function labelOf(value: unknown): string | null {
  const label = (value as { UserLocalizedLabel?: { Label?: unknown } } | undefined)
    ?.UserLocalizedLabel?.Label;
  return typeof label === "string" ? label : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new DataverseError(`${field} is required.`);
  return value;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new DataverseError(`${field} must be text of at most ${max} characters.`);
  return value.trim() || undefined;
}

function identifier(value: unknown, pattern: RegExp, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!pattern.test(text)) throw new DataverseError(`${field} is not valid: ${String(value)}`);
  return text;
}

function pageSizeArg(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_PAGE_SIZE;
  const size = Number(value);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE)
    throw new DataverseError(`pageSize must be between 1 and ${MAX_PAGE_SIZE}.`);
  return size;
}

function recordArg(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  )
    throw new DataverseError("record must be an object with at least one column.");
  return value as Record<string, unknown>;
}

/**
 * A refusal the person can act on carries a typed code: sign in again
 * (`connection_auth_needed`) or ask for access (`provider_permission_denied`).
 */
class DataverseError extends Error {
  constructor(
    message: string,
    readonly code?: "connection_auth_needed" | "provider_permission_denied",
  ) {
    super(message);
  }
}
class DataverseMutationOutcomeUnknownError extends IntegrationInvocationError {
  constructor(message: string) {
    super("dataverse_mutation_outcome_unknown", message, "unknown", false);
  }
}
