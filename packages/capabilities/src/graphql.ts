import type { CallToolResultContent, MCPCallToolOptions, MCPServer } from "@openai/agents";
import {
  buildClientSchema,
  getIntrospectionQuery,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  parse,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLOutputType,
  type IntrospectionQuery,
} from "graphql";

import { applyCredentialPlacements } from "./auth";
import {
  DEFAULT_INTEGRATION_RESPONSE_BYTES,
  DEFAULT_INTEGRATION_TIMEOUT_MS,
  MAX_INTEGRATION_SPEC_BYTES,
  MAX_INTEGRATION_TOOLS,
  fetchWithDeadline,
  readIntegrationResponse,
} from "./http";
import { canonicalJson, immutableRevisionId, sha256Hex, stableToolId } from "./revision";
import type {
  IntegrationCredentialResolver,
  IntegrationInvocationAuthority,
  IntegrationRevision,
  IntegrationTransport,
  JsonSchema,
} from "./types";
import { IntegrationInvocationError, IntegrationProtocolError } from "./types";

export interface GraphqlOperationBinding {
  readonly kind: "query" | "mutation";
  readonly fieldName: string;
  readonly operationName: string;
  readonly variableDefinitions: readonly string[];
  readonly variableNames: readonly string[];
  readonly defaultSelection?: string;
  readonly selectionAllowed: boolean;
}

export type GraphqlRevision = IntegrationRevision<GraphqlOperationBinding, "graphql">;

export interface CompileGraphqlOptions {
  readonly definitionId: string;
  readonly endpoint: string;
  readonly name?: string;
  readonly sourceUrl?: string;
  readonly provider?: string;
}

export interface GraphqlServerOptions {
  readonly revision: GraphqlRevision;
  readonly endpoint: string;
  readonly transport: IntegrationTransport;
  readonly credentialResolver?: IntegrationCredentialResolver;
  readonly authority: IntegrationInvocationAuthority;
  readonly staticHeaders?: Readonly<Record<string, string>>;
  readonly staticQuery?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

type LocalMcpTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];

export function compileGraphqlRevision(
  introspection: IntrospectionQuery | { readonly data?: IntrospectionQuery } | string,
  options: CompileGraphqlOptions,
): GraphqlRevision {
  const document = parseIntrospection(introspection);
  let schema;
  try {
    schema = buildClientSchema(document);
  } catch {
    throw new IntegrationProtocolError(
      "graphql_introspection_invalid",
      "GraphQL introspection result cannot build a client schema",
    );
  }
  const endpoint = validateGraphqlEndpoint(options.endpoint);
  const contentSha256 = sha256Hex(canonicalJson(document));
  const id = immutableRevisionId("graphql", contentSha256);
  const tools = [] as GraphqlRevision["tools"] extends readonly (infer T)[] ? T[] : never;
  const bindings: Record<string, GraphqlOperationBinding> = {};
  const seen = new Map<string, number>();

  for (const [kind, root] of [
    ["query", schema.getQueryType()],
    ["mutation", schema.getMutationType()],
  ] as const) {
    if (!root) continue;
    for (const field of Object.values(root.getFields()).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const toolId = stableToolId(`${kind}_${field.name}`, seen);
      const namedOutput = getNamedType(field.type);
      const selectionAllowed = !isLeafType(namedOutput);
      const defaultSelection = selectionAllowed
        ? buildDefaultSelection(field.type, new Set(), 0)
        : undefined;
      const properties: Record<string, unknown> = Object.fromEntries(
        field.args.map((arg) => [
          arg.name,
          {
            ...inputTypeSchema(arg.type, new Set(), 0),
            ...(arg.description ? { description: arg.description } : {}),
          },
        ]),
      );
      if (selectionAllowed) {
        properties.select = {
          type: "string",
          description:
            "Optional GraphQL field selection without outer braces. The default selects safe scalar fields.",
          maxLength: 4_000,
        };
      }
      const required = field.args.filter((arg) => isNonNullType(arg.type)).map((arg) => arg.name);
      const description = [
        field.description?.trim(),
        kind === "mutation"
          ? "Changes external state and requires approval."
          : "Read-only GraphQL query.",
      ]
        .filter(Boolean)
        .join(" ");
      tools.push({
        id: toolId,
        operationKey: `${kind}:${field.name}`,
        name: field.name,
        description,
        inputSchema: {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
        safety: kind === "query" ? "read" : "write",
        approvalMode: kind === "query" ? "never" : "ask",
        deprecated: field.deprecationReason != null,
      });
      bindings[toolId] = {
        kind,
        fieldName: field.name,
        operationName: stableGraphqlName(`${kind}_${field.name}`),
        variableDefinitions: field.args.map((arg) => `$${arg.name}: ${String(arg.type)}`),
        variableNames: field.args.map((arg) => arg.name),
        ...(defaultSelection ? { defaultSelection } : {}),
        selectionAllowed,
      };
      if (tools.length > MAX_INTEGRATION_TOOLS) {
        throw new IntegrationProtocolError(
          "graphql_tool_limit",
          `GraphQL schema exceeds the ${MAX_INTEGRATION_TOOLS}-tool limit`,
        );
      }
    }
  }
  if (tools.length === 0) {
    throw new IntegrationProtocolError("graphql_empty", "GraphQL schema exposes no root fields");
  }
  return {
    id,
    protocol: "graphql",
    definitionId: options.definitionId,
    contentSha256,
    source: {
      url: options.sourceUrl ?? endpoint,
      ...(options.provider ? { provider: options.provider } : {}),
    },
    title: options.name?.trim() || options.definitionId,
    tools,
    bindings,
  };
}

export async function fetchGraphqlIntrospection(
  options: Omit<GraphqlServerOptions, "revision">,
): Promise<IntrospectionQuery> {
  const request = { query: getIntrospectionQuery({ descriptions: true }) };
  const firstCredential = await resolveGraphqlCredential(
    options,
    "graphql-introspection",
    "pending",
    "__introspection",
    false,
  );
  let response = await sendGraphqlRequest(options, request, firstCredential);
  if (response.status === 401 && options.credentialResolver && options.authority.connectionRef) {
    const refreshed = await resolveGraphqlCredential(
      options,
      "graphql-introspection",
      "pending",
      "__introspection",
      true,
    );
    await response.body?.cancel().catch(() => undefined);
    if (!refreshed) {
      throw new IntegrationInvocationError(
        "graphql_introspection_rejected",
        "GraphQL endpoint did not return an introspection schema",
        "failed",
        false,
        401,
      );
    }
    response = await sendGraphqlRequest(options, request, refreshed);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new IntegrationInvocationError(
      "redirect_rejected",
      "GraphQL endpoint attempted to redirect the introspection request",
      "unknown",
      false,
      response.status,
    );
  }
  const body = await readIntegrationResponse(response, MAX_INTEGRATION_SPEC_BYTES);
  if (!response.ok || !isRecord(body.data) || !isRecord(body.data.data)) {
    throw new IntegrationInvocationError(
      "graphql_introspection_rejected",
      "GraphQL endpoint did not return an introspection schema",
      "failed",
      false,
      response.status,
    );
  }
  return body.data.data as unknown as IntrospectionQuery;
}

export class GraphqlMcpServer implements MCPServer {
  readonly cacheToolsList = true;
  readonly useStructuredContent = true;
  readonly name: string;

  constructor(private readonly options: GraphqlServerOptions) {
    this.name = `graphql:${stableToolId(options.revision.definitionId)}`;
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async invalidateToolsCache(): Promise<void> {}

  async listTools(): Promise<LocalMcpTool[]> {
    return this.options.revision.tools.map(
      (tool) =>
        ({
          name: tool.id,
          description: tool.description,
          inputSchema: normalizeMcpSchema(tool.inputSchema),
          annotations: {
            readOnlyHint: tool.safety === "read",
            destructiveHint: false,
            idempotentHint: tool.safety === "read",
            openWorldHint: true,
          },
          _meta: {
            "opengeni/approvalMode": tool.approvalMode,
            "opengeni/operationKey": tool.operationKey,
            "opengeni/revisionId": this.options.revision.id,
          },
        }) as LocalMcpTool,
    );
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | null,
    _meta?: Record<string, unknown> | null,
    callOptions?: MCPCallToolOptions,
  ): Promise<CallToolResultContent> {
    const result = await invokeGraphqlOperation(
      this.options,
      toolName,
      args ?? {},
      callOptions?.signal,
    );
    const content = [
      { type: "text" as const, text: JSON.stringify(result) },
    ] as CallToolResultContent;
    content.structuredContent = result;
    content.isError = result.ok === false;
    return content;
  }
}

export function createGraphqlMcpServer(options: GraphqlServerOptions): MCPServer {
  return new GraphqlMcpServer(options);
}

export async function invokeGraphqlOperation(
  options: GraphqlServerOptions,
  toolId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const binding = options.revision.bindings[toolId];
  if (!binding) {
    throw new IntegrationInvocationError(
      "operation_not_found",
      "GraphQL operation is not present in the frozen revision",
      "not_started",
      false,
    );
  }
  const select = binding.selectionAllowed
    ? validateGraphqlSelection(
        typeof args.select === "string" ? args.select : (binding.defaultSelection ?? "__typename"),
      )
    : undefined;
  const variables = Object.fromEntries(
    binding.variableNames.flatMap((name) => (args[name] === undefined ? [] : [[name, args[name]]])),
  );
  const definitions = binding.variableDefinitions.length
    ? `(${binding.variableDefinitions.join(", ")})`
    : "";
  const argumentsText = binding.variableNames.length
    ? `(${binding.variableNames.map((name) => `${name}: $${name}`).join(", ")})`
    : "";
  const query = `${binding.kind} ${binding.operationName}${definitions} { ${binding.fieldName}${argumentsText}${select ? ` { ${select} }` : ""} }`;
  const request = { query, variables, operationName: binding.operationName };
  const firstCredential = await resolveGraphqlCredential(
    options,
    options.revision.definitionId,
    options.revision.id,
    toolId,
    false,
  );
  let response = await sendGraphqlRequest(options, request, firstCredential, signal);
  if (response.status === 401 && options.credentialResolver && options.authority.connectionRef) {
    const refreshed = await resolveGraphqlCredential(
      options,
      options.revision.definitionId,
      options.revision.id,
      toolId,
      true,
    );
    await response.body?.cancel().catch(() => undefined);
    if (binding.kind === "query" && refreshed) {
      response = await sendGraphqlRequest(options, request, refreshed, signal);
    } else {
      throw new IntegrationInvocationError(
        "authorization_rejected",
        "The connected account is no longer authorized for this GraphQL operation",
        binding.kind === "mutation" ? "unknown" : "failed",
        false,
        401,
      );
    }
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new IntegrationInvocationError(
      "redirect_rejected",
      "GraphQL endpoint attempted to redirect a credential-bearing request",
      binding.kind === "mutation" ? "unknown" : "failed",
      false,
      response.status,
    );
  }
  const payload = await readIntegrationResponse(
    response,
    options.maxResponseBytes ?? DEFAULT_INTEGRATION_RESPONSE_BYTES,
  );
  if (response.status === 401 || response.status === 403) {
    throw new IntegrationInvocationError(
      "authorization_rejected",
      "The connected account is no longer authorized for this GraphQL operation",
      binding.kind === "mutation" ? "unknown" : "failed",
      false,
      response.status,
    );
  }
  const graph = isRecord(payload.data) ? payload.data : {};
  return {
    ok: response.ok && !Array.isArray(graph.errors),
    status: response.status,
    data: graph.data ?? null,
    errors: graph.errors ?? null,
  };
}

async function resolveGraphqlCredential(
  options: Omit<GraphqlServerOptions, "revision"> | GraphqlServerOptions,
  definitionId: string,
  revisionId: string,
  operationKey: string,
  forceRefresh: boolean,
): Promise<Awaited<ReturnType<IntegrationCredentialResolver["resolve"]>>> {
  if (!options.credentialResolver || !options.authority.connectionRef) return null;
  const credential = await options.credentialResolver.resolve({
    ...options.authority,
    protocol: "graphql",
    definitionId,
    revisionId,
    operationKey,
    destinationUrl: graphqlEndpoint(options).toString(),
    ...(forceRefresh ? { forceRefresh: true } : {}),
  });
  if (!credential && !forceRefresh) {
    throw new IntegrationInvocationError(
      "connection_required",
      "This GraphQL integration needs a connected account",
      "not_started",
      false,
    );
  }
  return credential;
}

async function sendGraphqlRequest(
  options: Omit<GraphqlServerOptions, "revision"> | GraphqlServerOptions,
  request: Record<string, unknown>,
  credential: Awaited<ReturnType<IntegrationCredentialResolver["resolve"]>>,
  signal?: AbortSignal,
): Promise<Response> {
  const endpoint = graphqlEndpoint(options);
  const headers = new Headers(options.staticHeaders);
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  if (credential) applyCredentialPlacements(endpoint, headers, credential);
  if (credential?.authorizeProviderRequest) {
    let authorized = false;
    try {
      authorized = await credential.authorizeProviderRequest();
    } catch {
      authorized = false;
    }
    if (!authorized) {
      throw new IntegrationInvocationError(
        "authorization_rejected",
        "The connected account is no longer authorized for this operation",
        "not_started",
        false,
      );
    }
  }
  return await fetchWithDeadline(
    options.transport,
    endpoint,
    {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    },
    options.timeoutMs ?? DEFAULT_INTEGRATION_TIMEOUT_MS,
  );
}

function graphqlEndpoint(options: Pick<GraphqlServerOptions, "endpoint" | "staticQuery">): URL {
  const endpoint = new URL(validateGraphqlEndpoint(options.endpoint));
  for (const [name, value] of Object.entries(options.staticQuery ?? {})) {
    endpoint.searchParams.set(name, value);
  }
  return endpoint;
}

export function validateGraphqlSelection(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 4_000) {
    throw new IntegrationInvocationError(
      "graphql_selection_invalid",
      "GraphQL selection must contain between 1 and 4000 characters",
      "not_started",
      false,
    );
  }
  try {
    const document = parse(`fragment OpenGeniSelection on Placeholder { ${normalized} }`);
    if (
      document.definitions.length !== 1 ||
      document.definitions[0]?.kind !== "FragmentDefinition"
    ) {
      throw new Error("invalid selection document");
    }
    return normalized;
  } catch {
    throw new IntegrationInvocationError(
      "graphql_selection_invalid",
      "GraphQL selection is invalid",
      "not_started",
      false,
    );
  }
}

function parseIntrospection(
  value: IntrospectionQuery | { readonly data?: IntrospectionQuery } | string,
): IntrospectionQuery {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > MAX_INTEGRATION_SPEC_BYTES) {
      throw new IntegrationProtocolError(
        "graphql_introspection_size",
        `GraphQL introspection exceeds ${MAX_INTEGRATION_SPEC_BYTES} bytes`,
      );
    }
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new IntegrationProtocolError(
        "graphql_introspection_parse",
        "GraphQL introspection is not valid JSON",
      );
    }
  }
  if (isRecord(parsed) && isRecord(parsed.data) && isRecord(parsed.data.__schema)) {
    return parsed.data as unknown as IntrospectionQuery;
  }
  if (isRecord(parsed) && isRecord(parsed.__schema)) {
    return parsed as unknown as IntrospectionQuery;
  }
  throw new IntegrationProtocolError(
    "graphql_introspection_shape",
    "GraphQL introspection result has no __schema object",
  );
}

function validateGraphqlEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new IntegrationProtocolError(
      "graphql_endpoint_invalid",
      "GraphQL endpoint URL is invalid",
    );
  }
  if (
    !/^https?:$/.test(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    throw new IntegrationProtocolError(
      "graphql_endpoint_invalid",
      "GraphQL endpoint URL is invalid",
    );
  }
  return endpoint.toString();
}

function inputTypeSchema(input: GraphQLInputType, seen: Set<string>, depth: number): JsonSchema {
  if (depth > 12) return {};
  if (isNonNullType(input)) return inputTypeSchema(input.ofType, seen, depth + 1);
  if (isListType(input)) {
    return { type: "array", items: inputTypeSchema(input.ofType, seen, depth + 1) };
  }
  const type = getNamedType(input);
  if (isScalarType(type)) return scalarSchema(type.name);
  if (isEnumType(type))
    return { type: "string", enum: type.getValues().map((entry) => entry.name) };
  if (isInputObjectType(type)) {
    if (seen.has(type.name)) return { type: "object", additionalProperties: true };
    const nextSeen = new Set(seen).add(type.name);
    const fields = Object.values(type.getFields());
    return {
      type: "object",
      properties: Object.fromEntries(
        fields.map((field) => [
          field.name,
          {
            ...inputTypeSchema(field.type, nextSeen, depth + 1),
            ...(field.description ? { description: field.description } : {}),
          },
        ]),
      ),
      required: fields.filter((field) => isNonNullType(field.type)).map((field) => field.name),
      additionalProperties: false,
    };
  }
  return {};
}

function scalarSchema(name: string): JsonSchema {
  if (name === "Boolean") return { type: "boolean" };
  if (name === "Int") return { type: "integer" };
  if (name === "Float") return { type: "number" };
  if (name === "ID" || name === "String") return { type: "string" };
  return { description: `GraphQL scalar ${name}` };
}

function buildDefaultSelection(
  output: GraphQLOutputType,
  seen: Set<string>,
  depth: number,
): string | undefined {
  const type = getNamedType(output);
  if (isLeafType(type)) return undefined;
  if (depth > 2 || seen.has(type.name)) return "__typename";
  if (isUnionType(type) || isInterfaceType(type)) return "__typename";
  if (!isObjectType(type)) return "__typename";
  const nextSeen = new Set(seen).add(type.name);
  const fields = Object.values(type.getFields());
  const scalarFields = fields.filter((field) => isLeafType(getNamedType(field.type))).slice(0, 20);
  const selections = scalarFields.map((field) => field.name);
  if (selections.length < 3 && depth < 2) {
    const nested = fields.find(
      (field) => field.args.length === 0 && !isLeafType(getNamedType(field.type)),
    );
    if (nested) {
      const child = buildDefaultSelection(nested.type, nextSeen, depth + 1);
      if (child) selections.push(`${nested.name} { ${child} }`);
    }
  }
  return selections.length ? selections.join(" ") : "__typename";
}

function isLeafType(type: GraphQLNamedType): boolean {
  return isScalarType(type) || isEnumType(type);
}

function stableGraphqlName(value: string): string {
  const normalized = value.replace(/[^_0-9A-Za-z]/g, "_").replace(/^([^_A-Za-z])/, "_$1");
  return normalized || "OpenGeniOperation";
}

function normalizeMcpSchema(schema: JsonSchema): LocalMcpTool["inputSchema"] {
  return {
    type: "object",
    properties: isRecord(schema.properties) ? schema.properties : {},
    required: Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [],
    additionalProperties: schema.additionalProperties === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
