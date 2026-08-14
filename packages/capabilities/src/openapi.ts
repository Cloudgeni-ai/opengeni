import type { CallToolResultContent, MCPCallToolOptions, MCPServer } from "@openai/agents";
import { load as parseYaml } from "js-yaml";

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
  IntegrationToolDefinition,
  IntegrationTransport,
  JsonSchema,
} from "./types";
import { IntegrationInvocationError, IntegrationProtocolError } from "./types";

export type OpenApiHttpMethod =
  | "get"
  | "put"
  | "post"
  | "delete"
  | "patch"
  | "head"
  | "options"
  | "trace";

export interface OpenApiParameterBinding {
  readonly name: string;
  readonly location: "path" | "query" | "header" | "cookie";
  readonly required: boolean;
  readonly schema: JsonSchema;
  readonly description?: string;
}

export interface OpenApiOperationBinding {
  readonly method: OpenApiHttpMethod;
  readonly pathTemplate: string;
  readonly serverUrl: string;
  readonly parameters: readonly OpenApiParameterBinding[];
  readonly requestBody?: {
    readonly required: boolean;
    readonly contentTypes: readonly string[];
    readonly schemas: Readonly<Record<string, JsonSchema>>;
  };
  readonly requiredScopeAlternatives?: readonly (readonly string[])[];
}

export type OpenApiRevision = IntegrationRevision<OpenApiOperationBinding, "openapi">;

export interface CompileOpenApiOptions {
  readonly definitionId: string;
  readonly sourceUrl?: string;
  readonly baseUrl?: string;
  readonly provider?: string;
}

export interface OpenApiServerOptions {
  readonly revision: OpenApiRevision;
  readonly transport: IntegrationTransport;
  readonly credentialResolver?: IntegrationCredentialResolver;
  readonly authority: IntegrationInvocationAuthority;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export type OpenApiAuthDiscovery =
  | { kind: "none" }
  | {
      kind: "oauth2";
      scopes: string[];
    }
  | {
      kind: "api_key";
      carrier: "header" | "query" | "cookie";
      name: string;
    }
  | { kind: "http"; scheme: string };

type LocalMcpTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];

const methods = new Set<OpenApiHttpMethod>([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
]);
const forbiddenParameterHeaders = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
]);

export function parseOpenApiDocument(source: string | Uint8Array): Record<string, unknown> {
  const bytes = typeof source === "string" ? Buffer.byteLength(source) : source.byteLength;
  if (bytes === 0 || bytes > MAX_INTEGRATION_SPEC_BYTES) {
    throw new IntegrationProtocolError(
      "openapi_spec_size",
      `OpenAPI document must be between 1 and ${MAX_INTEGRATION_SPEC_BYTES} bytes`,
    );
  }
  const text =
    typeof source === "string" ? source : new TextDecoder("utf-8", { fatal: true }).decode(source);
  let parsed: unknown;
  try {
    parsed = parseYaml(text, { json: true });
  } catch {
    throw new IntegrationProtocolError(
      "openapi_parse",
      "OpenAPI document is not valid JSON or YAML",
    );
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.openapi !== "string" ||
    !/^3\.(?:0|1)(?:\.|$)/.test(parsed.openapi)
  ) {
    throw new IntegrationProtocolError(
      "openapi_version",
      "Only OpenAPI 3.0 and 3.1 documents are supported",
    );
  }
  if (!isRecord(parsed.paths)) {
    throw new IntegrationProtocolError("openapi_paths", "OpenAPI document has no paths object");
  }
  return parsed;
}

export function compileOpenApiRevision(
  source: string | Uint8Array | Record<string, unknown>,
  options: CompileOpenApiOptions,
): OpenApiRevision {
  const document = isRecord(source) ? source : parseOpenApiDocument(source);
  const contentSha256 = sha256Hex(canonicalJson(document));
  const revisionId = immutableRevisionId("openapi", contentSha256);
  const info = isRecord(document.info) ? document.info : {};
  const documentServers = readServers(document.servers, options.baseUrl, options.sourceUrl);
  const documentSecurity = readSecurity(document.security);
  const tools: IntegrationToolDefinition[] = [];
  const bindings: Record<string, OpenApiOperationBinding> = {};
  const seen = new Map<string, number>();

  for (const [pathTemplate, rawPathItem] of Object.entries(
    document.paths as Record<string, unknown>,
  )) {
    const pathItem = resolveObject(document, rawPathItem, "path item");
    const sharedParameters = readParameters(document, pathItem.parameters);
    const pathServers = readServers(pathItem.servers, undefined, undefined);
    for (const [rawMethod, rawOperation] of Object.entries(pathItem)) {
      const method = rawMethod.toLowerCase() as OpenApiHttpMethod;
      if (!methods.has(method) || !isRecord(rawOperation)) continue;
      const operation = resolveObject(document, rawOperation, "operation");
      const operationKey = operationIdentity(method, pathTemplate, operation.operationId);
      const id = stableToolId(operationKey, seen);
      const parameters = mergeParameters(
        sharedParameters,
        readParameters(document, operation.parameters),
      );
      const requestBody = readRequestBody(document, operation.requestBody);
      const serverUrl = firstServerUrl(
        readServers(operation.servers, undefined, undefined),
        pathServers,
        documentServers,
      );
      const requiredScopeAlternatives =
        operation.security === undefined ? documentSecurity : readSecurity(operation.security);
      const safety = classifyHttpSafety(method, operation);
      const inputSchema = operationInputSchema(parameters, requestBody);
      const outputSchema = operationOutputSchema(document, operation.responses);
      const summary = stringValue(operation.summary) ?? stringValue(operation.description);
      tools.push({
        id,
        operationKey,
        name: summary ?? `${method.toUpperCase()} ${pathTemplate}`,
        description: toolDescription(method, pathTemplate, operation, safety),
        inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
        safety,
        approvalMode: safety === "read" ? "never" : "ask",
        deprecated: operation.deprecated === true,
      });
      bindings[id] = {
        method,
        pathTemplate,
        serverUrl,
        parameters,
        ...(requestBody ? { requestBody } : {}),
        ...(requiredScopeAlternatives.length > 0 ? { requiredScopeAlternatives } : {}),
      };
      if (tools.length > MAX_INTEGRATION_TOOLS) {
        throw new IntegrationProtocolError(
          "openapi_tool_limit",
          `OpenAPI document exceeds the ${MAX_INTEGRATION_TOOLS}-tool limit`,
        );
      }
    }
  }
  if (tools.length === 0) {
    throw new IntegrationProtocolError("openapi_empty", "OpenAPI document exposes no operations");
  }
  return {
    id: revisionId,
    protocol: "openapi",
    definitionId: options.definitionId,
    contentSha256,
    source: {
      ...(options.sourceUrl ? { url: options.sourceUrl } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
    },
    title: stringValue(info.title) ?? options.definitionId,
    ...(stringValue(info.description) ? { description: stringValue(info.description)! } : {}),
    ...(stringValue(info.version) ? { version: stringValue(info.version)! } : {}),
    tools,
    bindings,
  };
}

export function discoverOpenApiAuth(document: Record<string, unknown>): OpenApiAuthDiscovery {
  const components = isRecord(document.components) ? document.components : {};
  const schemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
  for (const raw of Object.values(schemes)) {
    const scheme = resolveObject(document, raw, "security scheme");
    if (scheme.type === "oauth2") {
      const flows = isRecord(scheme.flows) ? scheme.flows : {};
      const scopes = new Set<string>();
      for (const flow of Object.values(flows)) {
        if (!isRecord(flow) || !isRecord(flow.scopes)) continue;
        for (const scope of Object.keys(flow.scopes)) scopes.add(scope);
      }
      return { kind: "oauth2", scopes: [...scopes].sort() };
    }
    if (
      scheme.type === "apiKey" &&
      (scheme.in === "header" || scheme.in === "query" || scheme.in === "cookie") &&
      typeof scheme.name === "string" &&
      scheme.name.length > 0
    ) {
      return { kind: "api_key", carrier: scheme.in, name: scheme.name };
    }
    if (scheme.type === "http" && typeof scheme.scheme === "string") {
      return { kind: "http", scheme: scheme.scheme.toLowerCase() };
    }
  }
  return { kind: "none" };
}

export class OpenApiMcpServer implements MCPServer {
  readonly cacheToolsList = true;
  readonly useStructuredContent = true;
  readonly name: string;

  constructor(private readonly options: OpenApiServerOptions) {
    this.name = `openapi:${stableToolId(options.revision.definitionId)}`;
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
            destructiveHint: tool.safety === "destructive",
            idempotentHint: isIdempotentMethod(this.options.revision.bindings[tool.id]?.method),
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
    const result = await invokeOpenApiOperation(
      this.options,
      toolName,
      args ?? {},
      callOptions?.signal,
    );
    const content = [
      {
        type: "text" as const,
        text: JSON.stringify(result),
      },
    ] as CallToolResultContent;
    content.structuredContent = result as Record<string, unknown>;
    content.isError = result.ok === false;
    return content;
  }
}

export function createOpenApiMcpServer(options: OpenApiServerOptions): MCPServer {
  return new OpenApiMcpServer(options);
}

export async function invokeOpenApiOperation(
  options: OpenApiServerOptions,
  toolId: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const binding = options.revision.bindings[toolId];
  if (!binding) {
    throw new IntegrationInvocationError(
      "operation_not_found",
      "Integration operation is not present in the frozen revision",
      "not_started",
      false,
    );
  }
  const firstCredential = await resolveOpenApiCredential(options, binding, toolId, args, false);
  let response = await sendOpenApiRequest(options, binding, args, firstCredential, signal);
  if (response.status === 401 && options.credentialResolver && options.authority.connectionRef) {
    const refreshed = await resolveOpenApiCredential(options, binding, toolId, args, true);
    if (isReplaySafeMethod(binding.method) && refreshed) {
      await response.body?.cancel().catch(() => undefined);
      response = await sendOpenApiRequest(options, binding, args, refreshed, signal);
    } else {
      await response.body?.cancel().catch(() => undefined);
      throw new IntegrationInvocationError(
        "authorization_rejected",
        "The connected account is no longer authorized for this operation",
        isReplaySafeMethod(binding.method) ? "failed" : "unknown",
        false,
        response.status,
      );
    }
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new IntegrationInvocationError(
      "redirect_rejected",
      "Integration attempted to redirect a credential-bearing request",
      binding.method === "get" || binding.method === "head" ? "failed" : "unknown",
      false,
      response.status,
    );
  }
  const payload = await readIntegrationResponse(
    response,
    options.maxResponseBytes ?? DEFAULT_INTEGRATION_RESPONSE_BYTES,
  );
  const result = {
    ok: response.ok,
    status: response.status,
    contentType: payload.contentType,
    data: payload.data,
  };
  if (!response.ok && (response.status === 401 || response.status === 403)) {
    throw new IntegrationInvocationError(
      "authorization_rejected",
      "The connected account is no longer authorized for this operation",
      binding.method === "get" || binding.method === "head" ? "failed" : "unknown",
      false,
      response.status,
    );
  }
  return result;
}

async function resolveOpenApiCredential(
  options: OpenApiServerOptions,
  binding: OpenApiOperationBinding,
  toolId: string,
  args: Record<string, unknown>,
  forceRefresh: boolean,
): Promise<Awaited<ReturnType<IntegrationCredentialResolver["resolve"]>>> {
  if (!options.credentialResolver || !options.authority.connectionRef) return null;
  const destinationUrl = buildOperationUrl(binding, args).toString();
  const credential = await options.credentialResolver.resolve({
    ...options.authority,
    protocol: "openapi",
    definitionId: options.revision.definitionId,
    revisionId: options.revision.id,
    operationKey: toolId,
    destinationUrl,
    ...(binding.requiredScopeAlternatives
      ? { requiredScopeAlternatives: binding.requiredScopeAlternatives }
      : {}),
    ...(forceRefresh ? { forceRefresh: true } : {}),
  });
  if (!credential && !forceRefresh) {
    throw new IntegrationInvocationError(
      "connection_required",
      "This integration needs a connected account",
      "not_started",
      false,
    );
  }
  return credential;
}

async function sendOpenApiRequest(
  options: OpenApiServerOptions,
  binding: OpenApiOperationBinding,
  args: Record<string, unknown>,
  credential: Awaited<ReturnType<IntegrationCredentialResolver["resolve"]>>,
  signal?: AbortSignal,
): Promise<Response> {
  const url = buildOperationUrl(binding, args);
  const headers = buildOperationHeaders(binding, args);
  const body = buildOperationBody(binding, args, headers);
  if (credential) applyCredentialPlacements(url, headers, credential);
  return await fetchWithDeadline(
    options.transport,
    url,
    {
      method: binding.method.toUpperCase(),
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(signal ? { signal } : {}),
    },
    options.timeoutMs ?? DEFAULT_INTEGRATION_TIMEOUT_MS,
  );
}

function readServers(
  value: unknown,
  explicitBaseUrl: string | undefined,
  sourceUrl: string | undefined,
): string[] {
  if (explicitBaseUrl) return [normalizeServerUrl(explicitBaseUrl)];
  const servers = Array.isArray(value)
    ? value.flatMap((entry): string[] =>
        isRecord(entry) && typeof entry.url === "string"
          ? [resolveServerUrl(entry.url, sourceUrl)]
          : [],
      )
    : [];
  if (servers.length > 0) return servers;
  if (sourceUrl && URL.canParse(sourceUrl)) {
    const source = new URL(sourceUrl);
    return [`${source.origin}/`];
  }
  return [];
}

function firstServerUrl(...groups: readonly string[][]): string {
  const server = groups.flat().find(Boolean);
  if (!server) {
    throw new IntegrationProtocolError(
      "openapi_server_missing",
      "OpenAPI operation has no resolvable server URL",
    );
  }
  return server;
}

function resolveServerUrl(value: string, sourceUrl?: string): string {
  if (/[{}]/.test(value)) {
    throw new IntegrationProtocolError(
      "openapi_server_variable",
      "OpenAPI server variables require an explicit resolved base URL",
    );
  }
  try {
    return normalizeServerUrl(sourceUrl ? new URL(value, sourceUrl).toString() : value);
  } catch {
    throw new IntegrationProtocolError("openapi_server_invalid", "OpenAPI server URL is invalid");
  }
}

function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) {
    throw new IntegrationProtocolError("openapi_server_invalid", "OpenAPI server URL is invalid");
  }
  return url.toString();
}

function readParameters(
  document: Record<string, unknown>,
  value: unknown,
): OpenApiParameterBinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): OpenApiParameterBinding[] => {
    const parameter = resolveObject(document, raw, "parameter");
    const location = parameter.in;
    if (
      typeof parameter.name !== "string" ||
      (location !== "path" &&
        location !== "query" &&
        location !== "header" &&
        location !== "cookie")
    ) {
      return [];
    }
    if (location === "header" && forbiddenParameterHeaders.has(parameter.name.toLowerCase()))
      return [];
    return [
      {
        name: parameter.name,
        location,
        required: location === "path" || parameter.required === true,
        schema: dereferenceSchema(document, parameter.schema),
        ...(stringValue(parameter.description)
          ? { description: stringValue(parameter.description)! }
          : {}),
      },
    ];
  });
}

function mergeParameters(
  base: readonly OpenApiParameterBinding[],
  override: readonly OpenApiParameterBinding[],
): OpenApiParameterBinding[] {
  const merged = new Map(base.map((entry) => [`${entry.location}:${entry.name}`, entry]));
  for (const entry of override) merged.set(`${entry.location}:${entry.name}`, entry);
  return [...merged.values()];
}

function readRequestBody(
  document: Record<string, unknown>,
  value: unknown,
): OpenApiOperationBinding["requestBody"] | undefined {
  if (value === undefined) return undefined;
  const body = resolveObject(document, value, "request body");
  if (!isRecord(body.content)) return undefined;
  const schemas: Record<string, JsonSchema> = {};
  for (const [contentType, rawMedia] of Object.entries(body.content)) {
    if (!isRecord(rawMedia)) continue;
    schemas[contentType.toLowerCase()] = dereferenceSchema(document, rawMedia.schema);
  }
  const contentTypes = Object.keys(schemas);
  return contentTypes.length === 0
    ? undefined
    : { required: body.required === true, contentTypes, schemas };
}

function operationInputSchema(
  parameters: readonly OpenApiParameterBinding[],
  body: OpenApiOperationBinding["requestBody"],
): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const location of ["path", "query", "header", "cookie"] as const) {
    const group = parameters.filter((entry) => entry.location === location);
    if (group.length === 0) continue;
    properties[location] = {
      type: "object",
      properties: Object.fromEntries(
        group.map((entry) => [
          entry.name,
          { ...entry.schema, ...(entry.description ? { description: entry.description } : {}) },
        ]),
      ),
      required: group.filter((entry) => entry.required).map((entry) => entry.name),
      additionalProperties: false,
    };
    if (group.some((entry) => entry.required)) required.push(location);
  }
  if (body) {
    properties.body = body.schemas[body.contentTypes[0]!] ?? {};
    if (body.contentTypes.length > 1) {
      properties.contentType = { type: "string", enum: body.contentTypes };
    }
    if (body.required) required.push("body");
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function operationOutputSchema(
  document: Record<string, unknown>,
  value: unknown,
): JsonSchema | undefined {
  if (!isRecord(value)) return undefined;
  for (const status of ["200", "201", "202", "203", "204", "default"]) {
    if (!(status in value)) continue;
    const response = resolveObject(document, value[status], "response");
    if (!isRecord(response.content)) return undefined;
    for (const media of Object.values(response.content)) {
      if (isRecord(media) && media.schema !== undefined) {
        return dereferenceSchema(document, media.schema);
      }
    }
  }
  return undefined;
}

function readSecurity(value: unknown): readonly (readonly string[])[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): string[][] => {
    if (!isRecord(entry)) return [];
    const scopes = Object.values(entry).flatMap((raw) =>
      Array.isArray(raw) ? raw.filter((scope): scope is string => typeof scope === "string") : [],
    );
    return scopes.length > 0 ? [[...new Set(scopes)].sort()] : [];
  });
}

function classifyHttpSafety(
  method: OpenApiHttpMethod,
  operation: Record<string, unknown>,
): IntegrationToolDefinition["safety"] {
  if (method === "get" || method === "head" || method === "options") return "read";
  const text =
    `${stringValue(operation.operationId) ?? ""} ${stringValue(operation.summary) ?? ""}`.toLowerCase();
  return method === "delete" || /\b(delete|destroy|remove|revoke|cancel|purge)\b/.test(text)
    ? "destructive"
    : "write";
}

function operationIdentity(method: OpenApiHttpMethod, path: string, operationId: unknown): string {
  return typeof operationId === "string" && operationId.trim()
    ? operationId.trim()
    : `${method}_${path}`;
}

function toolDescription(
  method: OpenApiHttpMethod,
  path: string,
  operation: Record<string, unknown>,
  safety: IntegrationToolDefinition["safety"],
): string {
  const description = stringValue(operation.description) ?? stringValue(operation.summary);
  const approval =
    safety === "read" ? "Read-only." : "Changes external state and requires approval.";
  return `${description ? `${description.trim()} ` : ""}${method.toUpperCase()} ${path}. ${approval}`.trim();
}

function isIdempotentMethod(method: OpenApiHttpMethod | undefined): boolean {
  return (
    method === "get" ||
    method === "head" ||
    method === "options" ||
    method === "put" ||
    method === "delete"
  );
}

function isReplaySafeMethod(method: OpenApiHttpMethod): boolean {
  return method === "get" || method === "head" || method === "options";
}

function buildOperationUrl(binding: OpenApiOperationBinding, args: Record<string, unknown>): URL {
  const pathArgs = objectValue(args.path);
  const path = binding.pathTemplate.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = pathArgs[name];
    if (value === undefined || value === null) {
      throw new IntegrationInvocationError(
        "path_parameter_missing",
        "A required integration path parameter is missing",
        "not_started",
        false,
      );
    }
    return encodeURIComponent(scalarString(value));
  });
  const base = new URL(binding.serverUrl);
  const url = new URL(
    path.replace(/^\//, ""),
    base.toString().endsWith("/") ? base : new URL(`${base}/`),
  );
  const query = objectValue(args.query);
  for (const [name, value] of Object.entries(query)) appendQueryValue(url, name, value);
  return url;
}

function buildOperationHeaders(
  binding: OpenApiOperationBinding,
  args: Record<string, unknown>,
): Headers {
  const headers = new Headers({ accept: "application/json, text/plain;q=0.9, */*;q=0.5" });
  for (const [name, value] of Object.entries(objectValue(args.header))) {
    if (forbiddenParameterHeaders.has(name.toLowerCase())) continue;
    headers.set(name, scalarString(value));
  }
  const cookies = Object.entries(objectValue(args.cookie)).map(
    ([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(scalarString(value))}`,
  );
  if (cookies.length > 0) headers.set("cookie", cookies.join("; "));
  if (binding.requestBody && args.body !== undefined) {
    const requested =
      typeof args.contentType === "string" ? args.contentType.toLowerCase() : undefined;
    const contentType =
      requested && binding.requestBody.contentTypes.includes(requested)
        ? requested
        : binding.requestBody.contentTypes[0]!;
    headers.set("content-type", contentType);
  }
  return headers;
}

function buildOperationBody(
  binding: OpenApiOperationBinding,
  args: Record<string, unknown>,
  headers: Headers,
): BodyInit | undefined {
  if (!binding.requestBody || args.body === undefined) return undefined;
  const contentType = headers.get("content-type") ?? "application/json";
  if (contentType === "application/x-www-form-urlencoded") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(objectValue(args.body)))
      appendSearchParam(params, key, value);
    return params;
  }
  if (contentType === "application/json" || contentType.endsWith("+json")) {
    return JSON.stringify(args.body);
  }
  if (typeof args.body === "string") return args.body;
  throw new IntegrationInvocationError(
    "request_body_unsupported",
    "This operation requires a text body for the selected content type",
    "not_started",
    false,
  );
}

function appendQueryValue(url: URL, name: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) url.searchParams.append(name, scalarString(entry));
  } else if (value !== undefined && value !== null) {
    url.searchParams.append(name, scalarString(value));
  }
}

function appendSearchParam(params: URLSearchParams, name: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) params.append(name, scalarString(entry));
  } else if (value !== undefined && value !== null) {
    params.append(name, scalarString(value));
  }
}

function scalarString(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new IntegrationInvocationError(
    "parameter_invalid",
    "Integration parameters must be strings, numbers, booleans, or arrays of them",
    "not_started",
    false,
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function resolveObject(
  document: Record<string, unknown>,
  value: unknown,
  label: string,
): Record<string, unknown> {
  const resolved = resolveLocalRef(document, value);
  if (!isRecord(resolved)) {
    throw new IntegrationProtocolError("openapi_shape", `OpenAPI ${label} is invalid`);
  }
  return resolved;
}

function resolveLocalRef(document: Record<string, unknown>, value: unknown): unknown {
  if (!isRecord(value) || typeof value.$ref !== "string") return value;
  if (!value.$ref.startsWith("#/")) {
    throw new IntegrationProtocolError(
      "openapi_external_ref",
      "External OpenAPI references are not supported; bundle the document first",
    );
  }
  return value.$ref
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((current, part) => (isRecord(current) ? current[part] : undefined), document);
}

function dereferenceSchema(
  document: Record<string, unknown>,
  value: unknown,
  seen = new Set<string>(),
  depth = 0,
): JsonSchema {
  if (depth > 20) return {};
  if (isRecord(value) && typeof value.$ref === "string") {
    if (seen.has(value.$ref)) return {};
    const nextSeen = new Set(seen).add(value.$ref);
    return dereferenceSchema(document, resolveLocalRef(document, value), nextSeen, depth + 1);
  }
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "properties" && isRecord(entry)) {
      result.properties = Object.fromEntries(
        Object.entries(entry).map(([name, schema]) => [
          name,
          dereferenceSchema(document, schema, seen, depth + 1),
        ]),
      );
    } else if (key === "items") {
      result.items = dereferenceSchema(document, entry, seen, depth + 1);
    } else if (key === "allOf" || key === "anyOf" || key === "oneOf") {
      result[key] = Array.isArray(entry)
        ? entry.map((schema) => dereferenceSchema(document, schema, seen, depth + 1))
        : [];
    } else if (key !== "$ref") {
      result[key] = entry;
    }
  }
  return result;
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
