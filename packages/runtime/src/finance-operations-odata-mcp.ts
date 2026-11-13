import {
  MCP_TOOL_RECOMMENDED_PERMISSION_META_KEY,
  type McpServerConnectionRef,
  type ToolAuthNeededPayload,
} from "@opengeni/contracts";
import {
  FINANCE_OPERATIONS_DATA_PATH,
  FINANCE_OPERATIONS_METADATA_PATH,
  financeOperationsOrigin,
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
import { encodeQueryPath } from "./dataverse-web-api-mcp";
import { isRoutingMutationOutcomeUnknownError } from "./sandbox/routing/routing-session";

/**
 * Dynamics 365 Finance and Operations through the environment's OData data
 * entities. The connection is created for the environment's MCP endpoint
 * (`https://<env>.operations.dynamics.com/mcp`); its delegated grant
 * (`.default` on the environment) also carries `Odata.FullAccess`, so these
 * tools need no "Allowed MCP clients" entry and no Copilot Credits, which
 * Microsoft's ERP MCP server requires of other clients. One generic tool set,
 * run as the signed-in user with their own security roles.
 */

const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 5000;
const ENTITY_LIST_LIMIT = 300;
const ENUM_LOOKUP_LIMIT = 40;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const ENUM_TYPE = /^Microsoft\.Dynamics\.DataEntities\.([A-Za-z_][A-Za-z0-9_]{0,127})$/u;

type FinanceOperationsTool = Awaited<ReturnType<MCPServer["listTools"]>>[number] & {
  annotations: Record<string, boolean>;
  _meta?: Record<string, unknown>;
};

const entitySet = {
  type: "string",
  description:
    "Entity set name of the data entity, for example CustomersV3, SalesOrderHeadersV2 or LegalEntities.",
  pattern: NAME.source,
};
const recordKey = {
  type: "object",
  description:
    'Every key field of the record and its value, as listed by fno_describe_entity, for example {"dataAreaId": "usmf", "CustomerAccount": "US-001"}.',
  additionalProperties: { type: ["string", "number", "boolean"] },
};
const recordShape = {
  type: "object",
  description:
    'Field values by name. Enum fields take the member name, for example "Yes". Include dataAreaId to choose the company (legal entity).',
  additionalProperties: true,
};

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  effect: "read" | "write" | "delete",
): FinanceOperationsTool {
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
  } as FinanceOperationsTool;
}

export const FINANCE_OPERATIONS_ODATA_TOOLS: readonly FinanceOperationsTool[] = Object.freeze([
  tool(
    "fno_list_entities",
    `Lists the public data entities of the connected Dynamics 365 Finance and Operations environment: entity name, entity set name (used in queries) and whether it is read-only. Filter with search; at most ${ENTITY_LIST_LIMIT} entities are returned.`,
    {
      search: {
        type: "string",
        maxLength: 128,
        description: "Case-insensitive text matched against entity and entity set names.",
      },
    },
    [],
    "read",
  ),
  tool(
    "fno_describe_entity",
    "Describes one data entity: its key fields, and each field's type, whether it is required or read-only, and enum member names, plus navigation properties for $expand.",
    { entitySet },
    ["entitySet"],
    "read",
  ),
  tool(
    "fno_query",
    "Reads Finance and Operations data with an OData query relative to the data root, for example CustomersV3?$select=CustomerAccount,OrganizationName&$filter=CustomerGroupId eq '10'&$top=10, CustomersV3(dataAreaId='usmf',CustomerAccount='US-001'), CustomersV3/$count or LegalEntities for the companies. Rows come from the user's default company unless the query adds cross-company=true (then filter on dataAreaId). Filter enums as Microsoft.Dynamics.DataEntities.<Enum>'<Member>' and match text with a wildcard such as Name eq 'Contoso*'. $apply aggregation is not supported; count with $count. Pass a returned nextLink as path to read the next page.",
    {
      path: {
        type: "string",
        minLength: 1,
        maxLength: 16_384,
        description: "Entity set with OData query options; no leading slash.",
      },
      pageSize: {
        type: "integer",
        minimum: 1,
        maximum: MAX_PAGE_SIZE,
        description: `Rows per page (default ${DEFAULT_PAGE_SIZE}, at most ${MAX_PAGE_SIZE}).`,
      },
    },
    ["path"],
    "read",
  ),
  tool(
    "fno_create_record",
    "Creates a record in a data entity and returns it.",
    { entitySet, record: recordShape },
    ["entitySet", "record"],
    "write",
  ),
  tool(
    "fno_update_record",
    "Updates fields of an existing record and returns it. Only the given fields change.",
    { entitySet, key: recordKey, record: recordShape },
    ["entitySet", "key", "record"],
    "write",
  ),
  tool(
    "fno_delete_record",
    "Deletes a record permanently.",
    { entitySet, key: recordKey },
    ["entitySet", "key"],
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

export type FinanceOperationsODataMcpServerOptions = {
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
export type FinanceOperationsODataMcpBridgeConfig = {
  readonly url: string;
  readonly connectionRef?: McpServerConnectionRef;
};
export type FinanceOperationsODataMcpBridgeContext = Omit<
  FinanceOperationsODataMcpServerOptions,
  "connectionRef" | "mcpUrl"
>;

/** A Finance and Operations MCP endpoint connected through its own environment's OAuth grant. */
export function isFinanceOperationsMcpConfig(
  url: string,
  connectionRef: McpServerConnectionRef | undefined,
): boolean {
  if (microsoftDynamicsProductForMcpUrl(url) !== "finance_operations") return false;
  return (
    connectionRef?.kind === "oauth2" &&
    connectionRef.providerDomain.toLowerCase() === new URL(url).hostname.toLowerCase()
  );
}

type Request = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Absolute URL below the data or metadata root, already encoded. */
  url: string;
  body?: unknown;
  /** Rows per page for data reads. */
  pageSize?: number;
};

export class FinanceOperationsODataMcpServer implements LocalMcpBridgeServer {
  readonly name: string;
  readonly cacheToolsList = false;
  readonly bridge: LocalMcpBridgeDescriptor;
  private readonly fetchImpl: FetchLike;
  private readonly origin: string;
  private readonly dataBase: string;
  private readonly metadataBase: string;
  private connectionId: string | undefined;
  private entities: Promise<{ entity: string; entitySet: string; readOnly: boolean }[]> | undefined;

  constructor(private readonly options: FinanceOperationsODataMcpServerOptions) {
    const origin = financeOperationsOrigin(options.mcpUrl);
    if (!origin)
      throw new Error("Finance and Operations bridge requires a Finance and Operations endpoint");
    this.origin = origin;
    this.dataBase = `${origin}${FINANCE_OPERATIONS_DATA_PATH}`;
    this.metadataBase = `${origin}${FINANCE_OPERATIONS_METADATA_PATH}`;
    this.name = `opengeni-finance-operations-${options.serverId.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 80)}`;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.bridge = defineLocalMcpBridgeDescriptor({
      adapterId: "finance-operations-odata",
      providerId: "microsoft-dynamics",
      catalogIdentity: `mcp:${options.mcpUrl}`,
      authority: "connection",
      toolSurface: "static_reviewed",
      mutationReplay: "safe_reads_only",
      destinations: [
        { origin, pathPrefix: FINANCE_OPERATIONS_DATA_PATH },
        { origin, pathPrefix: FINANCE_OPERATIONS_METADATA_PATH },
      ],
    });
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async invalidateToolsCache(): Promise<void> {}

  async listTools(): Promise<Awaited<ReturnType<MCPServer["listTools"]>>> {
    // Surfaces a missing or expired connection before the model sees the tools.
    await this.resolve(this.dataBase, undefined, false);
    // Naming the environment lets the agent tell connections apart and notice
    // when a request is about an environment that isn't connected yet.
    const environment = new URL(this.origin).hostname;
    return FINANCE_OPERATIONS_ODATA_TOOLS.map((entry) => ({
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
        error instanceof FinanceOperationsMutationOutcomeUnknownError ||
        isRoutingMutationOutcomeUnknownError(error)
      )
        throw error;
      const message =
        error instanceof FinanceOperationsError
          ? error.message
          : "Finance and Operations tool failed. Try again.";
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  }

  private async run(
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    switch (toolName) {
      case "fno_list_entities":
        return await this.listEntities(optionalString(args.search, "search", 128), signal);
      case "fno_describe_entity":
        return await this.describeEntity(identifier(args.entitySet, "entitySet"), signal);
      case "fno_query": {
        const payload = await this.request(
          toolName,
          {
            method: "GET",
            url: `${this.dataBase}${this.queryPath(requiredString(args.path, "path"))}`,
            pageSize: pageSizeArg(args.pageSize),
          },
          signal,
        );
        return this.page(payload);
      }
      case "fno_create_record": {
        const set = identifier(args.entitySet, "entitySet");
        const payload = await this.request(
          toolName,
          {
            method: "POST",
            // cross-company lets dataAreaId choose any company the user can reach.
            url: `${this.dataBase}${set}?cross-company=true`,
            body: recordArg(args.record),
          },
          signal,
        );
        return { record: tidy(payload) };
      }
      case "fno_update_record": {
        const set = identifier(args.entitySet, "entitySet");
        const key = keyArg(args.key);
        const url = `${this.dataBase}${set}(${key})?cross-company=true`;
        await this.request(
          toolName,
          { method: "PATCH", url, body: recordArg(args.record) },
          signal,
        );
        // Finance and Operations confirms an update without its result; read
        // it back, but a failed read does not make the applied change uncertain.
        const record = await this.request(toolName, { method: "GET", url }, signal).catch(
          () => null,
        );
        return record ? { updated: true, record: tidy(record) } : { updated: true };
      }
      case "fno_delete_record": {
        const set = identifier(args.entitySet, "entitySet");
        const key = keyArg(args.key);
        await this.request(
          toolName,
          { method: "DELETE", url: `${this.dataBase}${set}(${key})?cross-company=true` },
          signal,
        );
        return { deleted: true, entitySet: set, key: args.key };
      }
      default:
        throw new FinanceOperationsError(`Unknown Finance and Operations tool ${toolName}.`);
    }
  }

  private async listEntities(search: string | undefined, signal: AbortSignal | undefined) {
    this.entities ??= this.request(
      "fno_list_entities",
      {
        method: "GET",
        url: `${this.metadataBase}PublicEntities?$select=Name,EntitySetName,IsReadOnly`,
      },
      signal,
    ).then((payload) =>
      arrayOf(payload.value)
        .map((entry) => ({
          entity: stringOf(entry.Name),
          entitySet: stringOf(entry.EntitySetName),
          readOnly: entry.IsReadOnly === true,
        }))
        .filter((entry) => entry.entity && entry.entitySet)
        .sort((a, b) => a.entitySet.localeCompare(b.entitySet)),
    );
    const all = await this.entities.catch((error: unknown) => {
      this.entities = undefined;
      throw error;
    });
    const needle = search?.toLowerCase();
    const matches = all
      .filter(
        (entry) =>
          !needle ||
          entry.entity.toLowerCase().includes(needle) ||
          entry.entitySet.toLowerCase().includes(needle),
      )
      .map(({ readOnly, ...entry }) => ({ ...entry, ...(readOnly ? { readOnly } : {}) }));
    return {
      entities: matches.slice(0, ENTITY_LIST_LIMIT),
      ...(matches.length > ENTITY_LIST_LIMIT
        ? { truncated: true, total: matches.length, hint: "Narrow the list with search." }
        : {}),
    };
  }

  private async describeEntity(set: string, signal: AbortSignal | undefined) {
    const toolName = "fno_describe_entity";
    const get = (path: string) =>
      this.request(toolName, { method: "GET", url: `${this.metadataBase}${path}` }, signal);
    // The metadata service keys entities by entity name, not entity set name.
    const lookup = await get(
      `PublicEntities?$filter=${encodeURIComponent(`EntitySetName eq '${set}'`)}&$select=Name`,
    );
    const name = stringOf(arrayOf(lookup.value)[0]?.Name);
    if (!name)
      throw new FinanceOperationsError(
        `No data entity has the entity set name ${set}. Find it with fno_list_entities.`,
      );
    const definition = await get(`PublicEntities('${encodeURIComponent(name)}')`);
    const properties = arrayOf(definition.Properties);
    const enumNames = [
      ...new Set(
        properties
          .map((property) => ENUM_TYPE.exec(stringOf(property.TypeName))?.[1])
          .filter((value): value is string => Boolean(value)),
      ),
    ].slice(0, ENUM_LOOKUP_LIMIT);
    const enums = new Map<string, string[]>();
    await Promise.all(
      enumNames.map(async (enumName) => {
        const enumeration = await get(`PublicEnumerations('${enumName}')`).catch(() => null);
        if (enumeration)
          enums.set(
            enumName,
            arrayOf(enumeration.Members)
              .map((member) => stringOf(member.Name))
              .filter(Boolean),
          );
      }),
    );
    const fields = properties.map((property) => {
      const enumName = ENUM_TYPE.exec(stringOf(property.TypeName))?.[1];
      const allowEdit = property.AllowEdit !== false;
      const allowEditOnCreate = property.AllowEditOnCreate !== false;
      return {
        field: stringOf(property.Name),
        type: enumName ? `enum ${enumName}` : stringOf(property.TypeName).replace(/^Edm\./u, ""),
        ...(property.IsKey === true ? { key: true } : {}),
        ...(property.IsMandatory === true ? { required: true } : {}),
        ...(!allowEdit && !allowEditOnCreate ? { readOnly: true } : {}),
        ...(!allowEdit && allowEditOnCreate ? { setOnCreateOnly: true } : {}),
        ...(enumName && enums.has(enumName) ? { values: enums.get(enumName) } : {}),
      };
    });
    return {
      entity: stringOf(definition.Name),
      entitySet: stringOf(definition.EntitySetName),
      ...(definition.IsReadOnly === true ? { readOnly: true } : {}),
      keys: fields.filter((field) => field.key).map((field) => field.field),
      fields,
      navigation: arrayOf(definition.NavigationProperties).map((navigation) => ({
        name: stringOf(navigation.Name),
        entity: stringOf(navigation.RelatedEntity),
        ...(navigation.Cardinality === "Multiple" ? { many: true } : {}),
      })),
    };
  }

  /** A path relative to the data root, or a nextLink this environment returned. */
  private queryPath(value: string): string {
    let path = value.trim();
    if (/^https:\/\//iu.test(path)) {
      if (!path.toLowerCase().startsWith(this.dataBase.toLowerCase()))
        throw new FinanceOperationsError(
          "path must be relative to this environment's data root, for example CustomersV3?$top=5.",
        );
      path = path.slice(this.dataBase.length);
    }
    path = path.replace(/^\/+/u, "").replace(/^data\//iu, "");
    const resource = decodeUriComponentSafe(path.split("?")[0]!);
    if (
      !/^[A-Za-z_]/u.test(path) ||
      /(^|[/\\])\.\.?([/\\]|$)/u.test(resource) ||
      path.includes("#")
    )
      throw new FinanceOperationsError(
        "path must start with an entity set name, for example CustomersV3?$top=5.",
      );
    // Finance and Operations ignores $apply and would return every row.
    if (/[?&]\$apply=/iu.test(decodeUriComponentSafe(path)))
      throw new FinanceOperationsError(
        "Finance and Operations doesn't support $apply. Count with $count (for example CustomersV3/$count?$filter=...) or read the rows with $select and add them up.",
      );
    return encodeQueryPath(path);
  }

  private page(payload: Record<string, unknown>): Record<string, unknown> {
    if (!Array.isArray(payload.value)) return { record: tidy(payload) };
    const nextLink = stringOf(payload["@odata.nextLink"]);
    const count = payload["@odata.count"];
    return {
      rows: payload.value.map((row) =>
        row && typeof row === "object" && !Array.isArray(row)
          ? tidy(row as Record<string, unknown>)
          : row,
      ),
      ...(typeof count === "number" && count >= 0 ? { count } : {}),
      ...(nextLink
        ? {
            nextLink: nextLink.startsWith(this.dataBase)
              ? nextLink.slice(this.dataBase.length)
              : nextLink,
          }
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
      throw new FinanceOperationsError(
        "Sign-in to Microsoft Dynamics is needed. Reconnect the Microsoft Dynamics connection.",
      );
    }
    if (this.connectionId && this.connectionId !== result.connectionId)
      throw new FinanceOperationsError(
        "The Microsoft Dynamics connection changed during this attempt.",
      );
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
    const mutation = request.method !== "GET";
    const credential = await this.resolve(request.url, toolName, refreshed);
    if (credential.authorizeProviderRequest && !(await credential.authorizeProviderRequest()))
      throw new FinanceOperationsError("The Microsoft Dynamics connection is no longer available.");
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: {
          ...credential.headers,
          accept: "application/json",
          "odata-version": "4.0",
          "odata-maxversion": "4.0",
          // Paging applies to queries only.
          ...(request.pageSize !== undefined
            ? { prefer: `odata.maxpagesize=${request.pageSize}` }
            : {}),
          // Update only: never create a record when the key does not exist.
          ...(request.method === "PATCH" ? { "if-match": "*" } : {}),
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
      throw new FinanceOperationsError("Finance and Operations could not be reached. Try again.");
    }
    if (response.status === 401) {
      // Finance and Operations authenticates before it changes anything, so a
      // 401 applied nothing and one retry with a refreshed sign-in is safe.
      await response.body?.cancel().catch(() => undefined);
      if (!refreshed) return await this.request(toolName, request, signal, true);
      await this.reportAuthNeeded(
        {
          status: "auth_needed",
          reason: "expired",
          providerDomain: this.options.connectionRef.providerDomain,
          connectionId: credential.connectionId,
        },
        toolName,
      ).catch(() => undefined);
      throw new FinanceOperationsError(
        "Microsoft Dynamics rejected the sign-in. Reconnect the Microsoft Dynamics connection. If it keeps failing, the signed-in Microsoft account may not be a user in this Finance and Operations environment; its system administrator can add the user.",
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
        "Finance and Operations response",
        { signal: deadline },
      );
      if (value && typeof value === "object" && !Array.isArray(value))
        payload = value as Record<string, unknown>;
      else if (typeof value === "number") payload = { count: value };
    } catch {
      if (mutation && response.ok) throw unknownOutcome();
      if (response.ok)
        throw new FinanceOperationsError(
          "Finance and Operations returned more data than one result can hold. Select fewer fields or use a smaller pageSize.",
        );
    }
    if (response.ok) return payload;
    if (mutation && response.status >= 500) throw unknownOutcome();
    throw new FinanceOperationsError(financeOperationsErrorMessage(response, payload));
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

export const FINANCE_OPERATIONS_ODATA_MCP_BRIDGE_ADAPTER: LocalMcpBridgeAdapter<
  FinanceOperationsODataMcpBridgeConfig,
  FinanceOperationsODataMcpBridgeContext
> = Object.freeze({
  adapterId: "finance-operations-odata",
  matches: (config: FinanceOperationsODataMcpBridgeConfig) =>
    isFinanceOperationsMcpConfig(config.url, config.connectionRef),
  create: (
    config: FinanceOperationsODataMcpBridgeConfig,
    context: FinanceOperationsODataMcpBridgeContext,
  ) => {
    if (!config.connectionRef)
      throw new Error("Finance and Operations bridge requires a connection reference");
    return new FinanceOperationsODataMcpServer({
      ...context,
      mcpUrl: config.url,
      connectionRef: config.connectionRef,
    });
  },
});

/**
 * Microsoft's own message, with the next step for errors a person can fix.
 * Finance and Operations puts the useful text of `{ error: { message } }` in
 * `innererror.message` (next to a stack trace, which is dropped); routing
 * errors are `{ Message }`.
 */
function financeOperationsErrorMessage(
  response: Response,
  payload: Record<string, unknown>,
): string {
  const error = payload.error as
    | { message?: unknown; innererror?: { message?: unknown } }
    | undefined;
  const candidates = [error?.innererror?.message, error?.message, payload.Message];
  const raw = (
    candidates.find((value): value is string => typeof value === "string" && value.trim() !== "") ??
    ""
  ).trim();
  const message = raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw;
  const prefix = `Finance and Operations returned ${response.status}${message ? `: ${message}` : "."}`;
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    return `${prefix} Try again${Number.isFinite(retryAfter) && retryAfter > 0 ? ` in ${Math.ceil(retryAfter)} seconds` : " shortly"}.`;
  }
  if (response.status === 403)
    return `${prefix} The signed-in user's Finance and Operations security roles don't allow this.`;
  if (response.status === 404)
    return `${prefix} No record has that key, or the entity set name is wrong; fno_list_entities lists entity sets.`;
  return prefix;
}

function unknownOutcome(): FinanceOperationsMutationOutcomeUnknownError {
  return new FinanceOperationsMutationOutcomeUnknownError(
    "Finance and Operations did not confirm the change; it may or may not have been applied. Check the record before trying again.",
  );
}

/** Drops OData bookkeeping. */
function tidy(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "@odata.context" || key === "@odata.etag") continue;
    out[key] = Array.isArray(value)
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

/** An OData key predicate from the record's key fields, for example dataAreaId='usmf',CustomerAccount='US-001'. */
function keyArg(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FinanceOperationsError("key must be an object of key fields and values.");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 16)
    throw new FinanceOperationsError("key must name between 1 and 16 key fields.");
  return entries
    .map(([field, fieldValue]) => {
      if (!NAME.test(field)) throw new FinanceOperationsError(`key field is not valid: ${field}`);
      let literal: string;
      if (typeof fieldValue === "string") {
        // Microsoft routes / and \ inside a key as path separators, and the
        // connection only reaches paths without encoded separators.
        if (/[/\\]/u.test(fieldValue))
          throw new FinanceOperationsError(
            `The ${field} value contains / or \\, which can't be used in a record key. Find the record with fno_query and $filter instead.`,
          );
        literal = `'${encodeURIComponent(fieldValue.replace(/'/gu, "''"))}'`;
      } else if (typeof fieldValue === "number" && Number.isFinite(fieldValue))
        literal = String(fieldValue);
      else if (typeof fieldValue === "boolean") literal = String(fieldValue);
      else throw new FinanceOperationsError(`key field ${field} must be text or a number.`);
      return `${field}=${literal}`;
    })
    .join(",");
}

function decodeUriComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new FinanceOperationsError(`${field} is required.`);
  return value;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new FinanceOperationsError(`${field} must be text of at most ${max} characters.`);
  return value.trim() || undefined;
}

function identifier(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!NAME.test(text)) throw new FinanceOperationsError(`${field} is not valid: ${String(value)}`);
  return text;
}

function pageSizeArg(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_PAGE_SIZE;
  const size = Number(value);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE)
    throw new FinanceOperationsError(`pageSize must be between 1 and ${MAX_PAGE_SIZE}.`);
  return size;
}

function recordArg(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  )
    throw new FinanceOperationsError("record must be an object with at least one field.");
  return value as Record<string, unknown>;
}

class FinanceOperationsError extends Error {}
class FinanceOperationsMutationOutcomeUnknownError extends IntegrationInvocationError {
  constructor(message: string) {
    super("finance_operations_mutation_outcome_unknown", message, "unknown", false);
  }
}
