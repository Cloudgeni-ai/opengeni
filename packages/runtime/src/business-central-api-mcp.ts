import {
  MCP_TOOL_RECOMMENDED_PERMISSION_META_KEY,
  type McpServerConnectionRef,
  type ToolAuthNeededPayload,
} from "@opengeni/contracts";
import {
  businessCentralApiBase,
  businessCentralEnvironment,
} from "@opengeni/contracts/microsoft-dynamics";
import {
  defineLocalMcpBridgeDescriptor,
  IntegrationInvocationError,
  type LocalMcpBridgeAdapter,
  type LocalMcpBridgeDescriptor,
  type LocalMcpBridgeServer,
} from "@opengeni/capabilities";
import {
  readResponseJsonBounded,
  readResponseTextBounded,
  type FetchLike,
} from "@opengeni/network";
import type { MCPServer } from "@openai/agents";
import { encodeQueryPath } from "./dataverse-web-api-mcp";
import { isRoutingMutationOutcomeUnknownError } from "./sandbox/routing/routing-session";

/**
 * Dynamics 365 Business Central through the environment's API (v2.0). A
 * Business Central connection's URL is the environment's API root
 * (`https://api.businesscentral.dynamics.com/v2.0/<tenant>/<environment>/api/v2.0`)
 * and its delegated grant is `Financials.ReadWrite.All`. Microsoft's hosted
 * Business Central MCP server is one URL for every environment (chosen by
 * request headers), and offers only read-only discovery tools until an admin
 * publishes an MCP configuration; the API needs neither and covers reads,
 * writes and bound actions such as posting. One generic tool set, run as the
 * signed-in user with their own Business Central permissions.
 */

const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const METADATA_MAX_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const ENTITY_LIST_LIMIT = 300;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
// An entity set, optionally below a record: salesOrders or salesOrders(<id>)/salesOrderLines.
const ENTITY_PATH =
  /^[A-Za-z_][A-Za-z0-9_]{0,127}(?:\([0-9a-fA-F-]{36}\)\/[A-Za-z_][A-Za-z0-9_]{0,127}){0,3}$/u;

type BusinessCentralTool = Awaited<ReturnType<MCPServer["listTools"]>>[number] & {
  annotations: Record<string, boolean>;
  _meta?: Record<string, unknown>;
};

const company = {
  type: "string",
  maxLength: 128,
  description:
    "Company name or id. Optional when the environment has one company; business_central_list_companies lists them.",
};
const entityPath = {
  type: "string",
  maxLength: 512,
  pattern: ENTITY_PATH.source,
  description:
    "Entity set, for example customers, items or salesInvoices, or one below a record, for example salesOrders(<id>)/salesOrderLines.",
};
const recordShape = {
  type: "object",
  description:
    "Field values by property name, for example displayName or customerNumber; business_central_describe_entity lists them.",
  additionalProperties: true,
};
const recordId = { type: "string", description: "The record's id (GUID).", pattern: GUID.source };

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  effect: "read" | "write" | "delete",
): BusinessCentralTool {
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
  } as BusinessCentralTool;
}

export const BUSINESS_CENTRAL_API_TOOLS: readonly BusinessCentralTool[] = Object.freeze([
  tool(
    "business_central_list_companies",
    "Lists the companies in the connected Business Central environment: id, name and display name.",
    {},
    [],
    "read",
  ),
  tool(
    "business_central_list_entities",
    `Lists the entity sets of the Business Central API (customers, vendors, items, salesOrders, salesInvoices, purchaseInvoices, generalLedgerEntries, …). Filter with search; at most ${ENTITY_LIST_LIMIT} are returned.`,
    {
      search: {
        type: "string",
        maxLength: 128,
        description: "Case-insensitive text matched against entity set names.",
      },
    },
    [],
    "read",
  ),
  tool(
    "business_central_describe_entity",
    "Describes one entity set: its key, each property's type and length, choice (enum) values, navigation properties for $expand, and the actions a record supports (for example post on salesInvoices).",
    {
      entity: {
        type: "string",
        maxLength: 128,
        pattern: NAME.source,
        description: "Entity set name, for example customers or salesInvoices.",
      },
    },
    ["entity"],
    "read",
  ),
  tool(
    "business_central_query",
    "Reads Business Central data in one company with an OData query relative to the company, for example customers?$select=number,displayName,balanceDue&$filter=balanceDue gt 0&$orderby=balanceDue desc&$top=10, salesInvoices?$filter=status eq 'Open'&$expand=salesInvoiceLines or items(<id>). Pass a returned nextLink as path to read the next page.",
    {
      company,
      path: {
        type: "string",
        minLength: 1,
        maxLength: 16_384,
        description: "Entity set or record with OData query options; no leading slash.",
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
    "business_central_create_record",
    "Creates a record in one company and returns it.",
    { company, entity: entityPath, record: recordShape },
    ["entity", "record"],
    "write",
  ),
  tool(
    "business_central_update_record",
    "Updates fields of an existing record and returns it. Only the given fields change.",
    { company, entity: entityPath, id: recordId, record: recordShape },
    ["entity", "id", "record"],
    "write",
  ),
  tool(
    "business_central_delete_record",
    "Deletes a record permanently.",
    { company, entity: entityPath, id: recordId },
    ["entity", "id"],
    "delete",
  ),
  tool(
    "business_central_run_action",
    "Runs an action on a record, for example post or send on salesInvoices, shipAndInvoice on salesOrders, or makeInvoice on salesQuotes; business_central_describe_entity lists each entity's actions.",
    {
      company,
      entity: entityPath,
      id: recordId,
      action: {
        type: "string",
        maxLength: 128,
        pattern: NAME.source,
        description: "Action name, for example post.",
      },
    },
    ["entity", "id", "action"],
    "write",
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

export type BusinessCentralApiMcpServerOptions = {
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
export type BusinessCentralApiMcpBridgeConfig = {
  readonly url: string;
  readonly connectionRef?: McpServerConnectionRef;
};
export type BusinessCentralApiMcpBridgeContext = Omit<
  BusinessCentralApiMcpServerOptions,
  "connectionRef" | "mcpUrl"
>;

/** A Business Central environment connected through its own OAuth grant. */
export function isBusinessCentralApiConfig(
  url: string,
  connectionRef: McpServerConnectionRef | undefined,
): boolean {
  const base = businessCentralApiBase(url);
  return (
    base !== null &&
    connectionRef?.kind === "oauth2" &&
    connectionRef.providerDomain.toLowerCase() === new URL(base).hostname
  );
}

type Request = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path below the API root, already encoded. */
  path: string;
  body?: unknown;
  /** Rows per page for reads. */
  pageSize?: number;
  ifMatch?: boolean;
  /** Read the body as text (`$metadata`). */
  text?: boolean;
};

type Company = { id: string; name: string; displayName: string | null };
type EntityModel = {
  sets: Map<string, string>;
  types: Map<string, string>;
  enums: Map<string, string[]>;
  actions: Map<string, string[]>;
};

export class BusinessCentralApiMcpServer implements LocalMcpBridgeServer {
  readonly name: string;
  readonly cacheToolsList = false;
  readonly bridge: LocalMcpBridgeDescriptor;
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private readonly environmentLabel: string;
  private connectionId: string | undefined;
  private companies: Promise<Company[]> | undefined;
  private model: Promise<EntityModel> | undefined;

  constructor(private readonly options: BusinessCentralApiMcpServerOptions) {
    const base = businessCentralApiBase(options.mcpUrl);
    const environment = businessCentralEnvironment(options.mcpUrl);
    if (!base || !environment)
      throw new Error("Business Central bridge requires a Business Central API root");
    this.base = base;
    this.environmentLabel = environment.tenant
      ? `${environment.environment} (tenant ${environment.tenant})`
      : environment.environment;
    this.name = `opengeni-business-central-${options.serverId.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 80)}`;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const root = new URL(base);
    this.bridge = defineLocalMcpBridgeDescriptor({
      adapterId: "business-central-api",
      providerId: "microsoft-dynamics",
      catalogIdentity: `mcp:${options.mcpUrl}`,
      authority: "connection",
      toolSurface: "static_reviewed",
      mutationReplay: "safe_reads_only",
      destinations: [{ origin: root.origin, pathPrefix: root.pathname }],
    });
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async invalidateToolsCache(): Promise<void> {}

  async listTools(): Promise<Awaited<ReturnType<MCPServer["listTools"]>>> {
    // Surfaces a missing or expired connection before the model sees the tools.
    await this.resolve(`${this.base}companies`, undefined, false);
    // Naming the environment lets the agent tell connections apart and notice
    // when a request is about an environment that isn't connected yet.
    return BUSINESS_CENTRAL_API_TOOLS.map((entry) => ({
      ...structuredClone(entry),
      description: `${entry.description} Business Central environment: ${this.environmentLabel}.`,
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
        error instanceof BusinessCentralMutationOutcomeUnknownError ||
        isRoutingMutationOutcomeUnknownError(error)
      )
        throw error;
      const message =
        error instanceof BusinessCentralError
          ? error.message
          : "Business Central tool failed. Try again.";
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  }

  private async run(
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    switch (toolName) {
      case "business_central_list_companies":
        return { companies: await this.listCompanies(toolName, signal) };
      case "business_central_list_entities":
        return await this.listEntities(optionalString(args.search, "search", 128), signal);
      case "business_central_describe_entity":
        return await this.describeEntity(identifier(args.entity, NAME, "entity"), signal);
      case "business_central_query": {
        const path = requiredString(args.path, "path");
        const target = await this.queryPath(toolName, path, args.company, signal);
        const payload = await this.request(
          toolName,
          { method: "GET", path: target, pageSize: pageSizeArg(args.pageSize) },
          signal,
        );
        return this.page(payload);
      }
      case "business_central_create_record": {
        const prefix = await this.companyPath(toolName, args.company, signal);
        const entity = identifier(args.entity, ENTITY_PATH, "entity");
        const payload = await this.request(
          toolName,
          { method: "POST", path: `${prefix}/${entity}`, body: recordArg(args.record) },
          signal,
        );
        return { record: tidy(payload) };
      }
      case "business_central_update_record": {
        const prefix = await this.companyPath(toolName, args.company, signal);
        const entity = identifier(args.entity, ENTITY_PATH, "entity");
        const id = identifier(args.id, GUID, "id");
        const payload = await this.request(
          toolName,
          {
            method: "PATCH",
            path: `${prefix}/${entity}(${id})`,
            body: recordArg(args.record),
            ifMatch: true,
          },
          signal,
        );
        return { record: tidy(payload) };
      }
      case "business_central_delete_record": {
        const prefix = await this.companyPath(toolName, args.company, signal);
        const entity = identifier(args.entity, ENTITY_PATH, "entity");
        const id = identifier(args.id, GUID, "id");
        await this.request(
          toolName,
          { method: "DELETE", path: `${prefix}/${entity}(${id})`, ifMatch: true },
          signal,
        );
        return { deleted: true, entity, id };
      }
      case "business_central_run_action": {
        const prefix = await this.companyPath(toolName, args.company, signal);
        const entity = identifier(args.entity, ENTITY_PATH, "entity");
        const id = identifier(args.id, GUID, "id");
        const action = identifier(args.action, NAME, "action");
        await this.request(
          toolName,
          { method: "POST", path: `${prefix}/${entity}(${id})/Microsoft.NAV.${action}` },
          signal,
        );
        return { done: true, entity, id, action };
      }
      default:
        throw new BusinessCentralError(`Unknown Business Central tool ${toolName}.`);
    }
  }

  private async listCompanies(toolName: string, signal: AbortSignal | undefined) {
    this.companies ??= this.request(
      toolName,
      { method: "GET", path: "companies?$select=id,name,displayName" },
      signal,
    ).then((payload) =>
      arrayOf(payload.value).map((entry) => ({
        id: stringOf(entry.id),
        name: stringOf(entry.name),
        displayName: stringOf(entry.displayName) || null,
      })),
    );
    try {
      return await this.companies;
    } catch (error) {
      this.companies = undefined;
      throw error;
    }
  }

  /** `companies(<id>)` for a company name or id, or the only company. */
  private async companyPath(
    toolName: string,
    value: unknown,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const wanted = optionalString(value, "company", 128);
    if (wanted && GUID.test(wanted)) return `companies(${wanted.toLowerCase()})`;
    const companies = await this.listCompanies(toolName, signal);
    const needle = wanted?.toLowerCase();
    const matches = needle
      ? companies.filter(
          (entry) =>
            entry.name.toLowerCase() === needle || entry.displayName?.toLowerCase() === needle,
        )
      : companies;
    if (matches.length === 1) return `companies(${matches[0]!.id})`;
    const names = companies.map((entry) => entry.name).join(", ");
    throw new BusinessCentralError(
      wanted
        ? `No company named ${wanted}. Companies: ${names || "none"}.`
        : `Name the company. Companies: ${names || "none"}.`,
    );
  }

  /** A company-relative OData path, or a nextLink this environment returned. */
  private async queryPath(
    toolName: string,
    value: string,
    companyArg: unknown,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    let path = value.trim();
    if (/^https:\/\//iu.test(path)) {
      if (!path.toLowerCase().startsWith(this.base.toLowerCase()))
        throw new BusinessCentralError("path must be relative to this environment's API.");
      path = path.slice(this.base.length);
    }
    path = path.replace(/^\/+/u, "");
    const resource = decodeUriComponentSafe(path.split("?")[0]!);
    if (
      !/^[A-Za-z_]/u.test(path) ||
      /(^|[/\\])\.\.?([/\\]|$)/u.test(resource) ||
      /^\$batch/iu.test(path) ||
      path.includes("#")
    )
      throw new BusinessCentralError(
        "path must start with an entity set, for example customers?$top=5.",
      );
    // A nextLink already names its company.
    if (/^companies(\(|$|\?)/iu.test(path)) return encodeQueryPath(path);
    const prefix = await this.companyPath(toolName, companyArg, signal);
    return `${prefix}/${encodeQueryPath(path)}`;
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
            nextLink: nextLink.startsWith(this.base) ? nextLink.slice(this.base.length) : nextLink,
          }
        : {}),
    };
  }

  private async listEntities(search: string | undefined, signal: AbortSignal | undefined) {
    const model = await this.entityModel("business_central_list_entities", signal);
    const needle = search?.toLowerCase();
    const entities = [...model.sets.keys()]
      .filter((name) => name !== "companies")
      .filter((name) => !needle || name.toLowerCase().includes(needle))
      .sort((a, b) => a.localeCompare(b));
    return {
      entities: entities.slice(0, ENTITY_LIST_LIMIT),
      ...(entities.length > ENTITY_LIST_LIMIT
        ? { truncated: true, total: entities.length, hint: "Narrow the list with search." }
        : {}),
    };
  }

  private async describeEntity(entity: string, signal: AbortSignal | undefined) {
    const model = await this.entityModel("business_central_describe_entity", signal);
    const setName = [...model.sets.keys()].find(
      (name) => name.toLowerCase() === entity.toLowerCase(),
    );
    const typeName = setName ? model.sets.get(setName) : undefined;
    const xml = typeName ? model.types.get(typeName) : undefined;
    if (!setName || !typeName || xml === undefined)
      throw new BusinessCentralError(
        `No entity set named ${entity}. business_central_list_entities lists them.`,
      );
    const key = [...xml.matchAll(/<PropertyRef\b([^>]*)\/?>/gu)].map(
      (match) => attributes(match[1]!).Name ?? "",
    );
    const properties = [...xml.matchAll(/<Property\b([^>]*?)\/?>/gu)].map((match) => {
      const attrs = attributes(match[1]!);
      const type = attrs.Type ?? "";
      const enumName = type.replace(/^Microsoft\.NAV\./u, "");
      const choices = type.startsWith("Microsoft.NAV.") ? model.enums.get(enumName) : undefined;
      return {
        name: attrs.Name ?? "",
        type: type.replace(/^Edm\./u, "").replace(/^Microsoft\.NAV\./u, ""),
        ...(attrs.Nullable === "false" ? { nullable: false } : {}),
        ...(attrs.MaxLength ? { maxLength: Number(attrs.MaxLength) } : {}),
        ...(choices ? { choices } : {}),
      };
    });
    const navigation = [...xml.matchAll(/<NavigationProperty\b([^>]*?)\/?>/gu)].map((match) => {
      const attrs = attributes(match[1]!);
      return {
        name: attrs.Name ?? "",
        target: (attrs.Type ?? "")
          .replace(/^Collection\((.*)\)$/u, "$1[]")
          .replace(/^Microsoft\.NAV\./u, ""),
      };
    });
    return {
      entity: setName,
      key,
      properties,
      ...(navigation.length ? { navigation } : {}),
      ...(model.actions.get(typeName)?.length ? { actions: model.actions.get(typeName) } : {}),
    };
  }

  /** Entity sets, types, enums and bound actions from the API's `$metadata`. */
  private async entityModel(toolName: string, signal: AbortSignal | undefined) {
    this.model ??= this.request(
      toolName,
      { method: "GET", path: "$metadata", text: true },
      signal,
    ).then((payload) => parseMetadata(stringOf(payload.text)));
    try {
      return await this.model;
    } catch (error) {
      this.model = undefined;
      throw error;
    }
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
      throw new BusinessCentralError(
        "Sign-in to Microsoft Dynamics is needed. Reconnect the Microsoft Dynamics connection.",
      );
    }
    if (this.connectionId && this.connectionId !== result.connectionId)
      throw new BusinessCentralError(
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
    const url = `${this.base}${request.path}`;
    const mutation = request.method !== "GET";
    const credential = await this.resolve(url, toolName, refreshed);
    if (credential.authorizeProviderRequest && !(await credential.authorizeProviderRequest()))
      throw new BusinessCentralError("The Microsoft Dynamics connection is no longer available.");
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: request.method,
        headers: {
          ...credential.headers,
          accept: request.text ? "application/xml" : "application/json",
          ...(request.method === "GET" && !request.text
            ? { prefer: `odata.maxpagesize=${request.pageSize ?? DEFAULT_PAGE_SIZE}` }
            : {}),
          // Update or delete only the record as it is now; never create one.
          ...(request.ifMatch ? { "if-match": "*" } : {}),
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
      throw new BusinessCentralError("Business Central could not be reached. Try again.");
    }
    if (response.status === 401) {
      // Business Central authenticates before it changes anything, so a 401
      // applied nothing and one retry with a refreshed sign-in is safe.
      if (!refreshed) {
        await response.body?.cancel().catch(() => undefined);
        return await this.request(toolName, request, signal, true);
      }
      // A fresh sign-in Business Central still refuses with its own error is
      // about the person (no licence or no user in this environment), not
      // the sign-in; asking them to reconnect would only loop.
      const refusal = await readResponseJsonBounded<unknown>(
        response,
        RESPONSE_MAX_BYTES,
        "Business Central response",
        { signal: deadline },
      ).catch(() => null);
      const refusalMessage =
        refusal && typeof refusal === "object" && !Array.isArray(refusal)
          ? (refusal as { error?: { message?: unknown } }).error?.message
          : undefined;
      if (typeof refusalMessage === "string" && refusalMessage.trim())
        throw new BusinessCentralError(
          `${businessCentralErrorMessage(response, refusal as Record<string, unknown>)} The signed-in Microsoft account may have no Business Central licence or no user in this environment; its Business Central admin can add them.`,
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
      throw new BusinessCentralError(
        "Microsoft Dynamics rejected the sign-in. Reconnect the Microsoft Dynamics connection.",
      );
    }
    if (response.status === 204) {
      await response.body?.cancel().catch(() => undefined);
      return {};
    }
    if (request.text && response.ok) {
      try {
        return {
          text: await readResponseTextBounded(
            response,
            METADATA_MAX_BYTES,
            "Business Central metadata",
            { signal: deadline },
          ),
        };
      } catch {
        throw new BusinessCentralError("Business Central metadata could not be read. Try again.");
      }
    }
    let payload: Record<string, unknown> = {};
    try {
      const value = await readResponseJsonBounded<unknown>(
        response,
        RESPONSE_MAX_BYTES,
        "Business Central response",
        { signal: deadline },
      );
      if (value && typeof value === "object" && !Array.isArray(value))
        payload = value as Record<string, unknown>;
    } catch {
      if (mutation && response.ok) throw unknownOutcome();
      if (response.ok)
        throw new BusinessCentralError(
          "Business Central returned more data than one result can hold. Select fewer fields or use a smaller pageSize.",
        );
    }
    if (response.ok) return payload;
    if (mutation && response.status >= 500) throw unknownOutcome();
    throw new BusinessCentralError(businessCentralErrorMessage(response, payload));
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

export const BUSINESS_CENTRAL_API_MCP_BRIDGE_ADAPTER: LocalMcpBridgeAdapter<
  BusinessCentralApiMcpBridgeConfig,
  BusinessCentralApiMcpBridgeContext
> = Object.freeze({
  adapterId: "business-central-api",
  matches: (config: BusinessCentralApiMcpBridgeConfig) =>
    isBusinessCentralApiConfig(config.url, config.connectionRef),
  create: (
    config: BusinessCentralApiMcpBridgeConfig,
    context: BusinessCentralApiMcpBridgeContext,
  ) => {
    if (!config.connectionRef)
      throw new Error("Business Central bridge requires a connection reference");
    return new BusinessCentralApiMcpServer({
      ...context,
      mcpUrl: config.url,
      connectionRef: config.connectionRef,
    });
  },
});

/** Entity sets, entity types, enums and bound actions of an OData CSDL document. */
export function parseMetadata(xml: string): EntityModel {
  const sets = new Map<string, string>();
  for (const match of xml.matchAll(/<EntitySet\b([^>]*?)\/?>/gu)) {
    const attrs = attributes(match[1]!);
    if (attrs.Name && attrs.EntityType)
      sets.set(attrs.Name, attrs.EntityType.replace(/^.*\./u, ""));
  }
  const types = new Map<string, string>();
  for (const match of xml.matchAll(/<EntityType\b([^>]*?)(?:\/>|>([\s\S]*?)<\/EntityType>)/gu)) {
    const name = attributes(match[1]!).Name;
    if (name) types.set(name, match[2] ?? "");
  }
  const enums = new Map<string, string[]>();
  for (const match of xml.matchAll(/<EnumType\b([^>]*?)(?:\/>|>([\s\S]*?)<\/EnumType>)/gu)) {
    const name = attributes(match[1]!).Name;
    if (!name) continue;
    enums.set(
      name,
      [...(match[2] ?? "").matchAll(/<Member\b([^>]*?)\/?>/gu)]
        .map((member) => attributes(member[1]!).Name ?? "")
        .filter(Boolean),
    );
  }
  const actions = new Map<string, string[]>();
  for (const match of xml.matchAll(/<Action\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Action>)/gu)) {
    const attrs = attributes(match[1]!);
    if (attrs.IsBound !== "true" || !attrs.Name) continue;
    const binding = /<Parameter\b([^>]*?)\/?>/u.exec(match[2] ?? "");
    const type = binding ? (attributes(binding[1]!).Type ?? "") : "";
    const bound = type.replace(/^Collection\((.*)\)$/u, "$1").replace(/^.*\./u, "");
    if (!bound) continue;
    actions.set(bound, [...(actions.get(bound) ?? []), attrs.Name]);
  }
  return { sets, types, enums, actions };
}

function attributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of source.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/gu))
    out[match[1]!] = match[2]!
      .replace(/&quot;/gu, '"')
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/&amp;/gu, "&");
  return out;
}

/**
 * Microsoft's own message, with the next step for errors a person can fix.
 * Business Central error bodies are `{ error: { code, message } }`.
 */
function businessCentralErrorMessage(response: Response, payload: Record<string, unknown>): string {
  const error = payload.error as { code?: unknown; message?: unknown } | undefined;
  const raw = typeof error?.message === "string" ? error.message.trim() : "";
  const message = raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw;
  const prefix = `Business Central returned ${response.status}${message ? `: ${message}` : "."}`;
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    return `${prefix} Try again${Number.isFinite(retryAfter) && retryAfter > 0 ? ` in ${Math.ceil(retryAfter)} seconds` : " shortly"}.`;
  }
  if (response.status === 403)
    return `${prefix} The signed-in user's Business Central permissions don't allow this.`;
  return prefix;
}

function unknownOutcome(): BusinessCentralMutationOutcomeUnknownError {
  return new BusinessCentralMutationOutcomeUnknownError(
    "Business Central did not confirm the change; it may or may not have been applied. Check the record before trying again.",
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
    throw new BusinessCentralError(`${field} is required.`);
  return value;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new BusinessCentralError(`${field} must be text of at most ${max} characters.`);
  return value.trim() || undefined;
}

function identifier(value: unknown, pattern: RegExp, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!pattern.test(text))
    throw new BusinessCentralError(`${field} is not valid: ${String(value)}`);
  return text;
}

function pageSizeArg(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_PAGE_SIZE;
  const size = Number(value);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE)
    throw new BusinessCentralError(`pageSize must be between 1 and ${MAX_PAGE_SIZE}.`);
  return size;
}

function recordArg(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  )
    throw new BusinessCentralError("record must be an object with at least one field.");
  return value as Record<string, unknown>;
}

class BusinessCentralError extends Error {}
class BusinessCentralMutationOutcomeUnknownError extends IntegrationInvocationError {
  constructor(message: string) {
    super("business_central_mutation_outcome_unknown", message, "unknown", false);
  }
}
