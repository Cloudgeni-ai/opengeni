import type {
  ToolGatewayCallRequest,
  ToolGatewayCallResponse,
  ToolGatewayApprovalRequest,
  ToolGatewayApprovalResponse,
  ToolGatewayCatalog,
  ToolGatewayCatalogEntry,
  ToolGatewayDeclarationsResponse,
  ToolGatewayIdentity,
  ToolGatewayResult,
} from "./types";

export type OpenGeniToolCallOptions = {
  operationId?: string;
  signal?: AbortSignal;
  refreshCatalog?: boolean;
  /** Server-issued, single-use capability returned by `$approve`. */
  approvalToken?: string;
};

export type OpenGeniToolFunction<
  TArguments extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
> = (argumentsValue?: TArguments, options?: OpenGeniToolCallOptions) => Promise<TResult>;

export interface OpenGeniDynamicToolNamespace {
  readonly [key: string]: OpenGeniDynamicToolNode;
}

export type OpenGeniDynamicToolNode = OpenGeniDynamicToolNamespace & OpenGeniToolFunction;

/** Declaration-generation target for one exact workspace catalog. */
export interface OpenGeniGeneratedTools {}

export type OpenGeniWorkspaceTools = OpenGeniGeneratedTools &
  OpenGeniDynamicToolNamespace & {
    readonly $catalog: (options?: {
      refresh?: boolean;
      signal?: AbortSignal;
    }) => Promise<ToolGatewayCatalog>;
    readonly $call: (
      identity: ToolGatewayIdentity,
      argumentsValue?: Record<string, unknown>,
      options?: OpenGeniToolCallOptions,
    ) => Promise<unknown>;
    readonly $approve: (
      identity: ToolGatewayIdentity,
      argumentsValue?: Record<string, unknown>,
      options?: {
        operationId?: string;
        signal?: AbortSignal;
      },
    ) => Promise<ToolGatewayApprovalResponse>;
    readonly $declarations: (options?: {
      signal?: AbortSignal;
    }) => Promise<ToolGatewayDeclarationsResponse>;
  };

export interface OpenGeniToolTransport {
  requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T>;
}

export interface OpenGeniToolsFacade {
  forWorkspace(workspaceId: string): OpenGeniWorkspaceTools;
}

export class OpenGeniToolCallError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(readonly result: ToolGatewayResult) {
    const structured = result.structuredContent as
      | { error?: { code?: unknown; message?: unknown; retryable?: unknown } }
      | undefined;
    super(
      typeof structured?.error?.message === "string"
        ? structured.error.message
        : "OpenGeni tool call failed",
    );
    this.name = "OpenGeniToolCallError";
    this.code = typeof structured?.error?.code === "string" ? structured.error.code : "tool_error";
    this.retryable = structured?.error?.retryable === true;
  }
}

export class OpenGeniToolsClient implements OpenGeniToolsFacade {
  constructor(private readonly transport: OpenGeniToolTransport) {}

  forWorkspace(workspaceId: string): OpenGeniWorkspaceTools {
    const normalizedWorkspaceId = requiredId(workspaceId, "workspaceId");
    let catalogSnapshot: ToolGatewayCatalog | null = null;
    const catalog = async (
      options: { refresh?: boolean; signal?: AbortSignal } = {},
    ): Promise<ToolGatewayCatalog> => {
      if (catalogSnapshot && !options.refresh) return catalogSnapshot;
      const next = await this.transport.requestJson<ToolGatewayCatalog>(
        "GET",
        `/v1/workspaces/${encodeURIComponent(normalizedWorkspaceId)}/tools/catalog`,
        undefined,
        {},
        options.signal ? { signal: options.signal } : {},
      );
      catalogSnapshot = next;
      return next;
    };
    const callIdentity = async (
      identity: ToolGatewayIdentity,
      argumentsValue: Record<string, unknown> = {},
      options: OpenGeniToolCallOptions = {},
    ): Promise<unknown> => {
      if (options.approvalToken && !options.operationId) {
        throw new TypeError("operationId is required when using an approval token");
      }
      const current = await catalog({
        ...(options.refreshCatalog === undefined ? {} : { refresh: options.refreshCatalog }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const request: ToolGatewayCallRequest = {
        ...(options.operationId ? { operationId: options.operationId } : {}),
        catalogDigest: current.digest,
        identity,
        arguments: argumentsValue,
        ...(options.approvalToken ? { approvalToken: options.approvalToken } : {}),
      };
      const response = await this.transport.requestJson<ToolGatewayCallResponse>(
        "POST",
        `/v1/workspaces/${encodeURIComponent(normalizedWorkspaceId)}/tools/calls`,
        request,
        {},
        options.signal ? { signal: options.signal } : {},
      );
      if (response.catalogDigest !== current.digest) {
        catalogSnapshot = null;
      }
      if (response.result.isError) throw new OpenGeniToolCallError(response.result);
      const entry = findCatalogEntry(current, identity);
      return entry?.outputSchema && response.result.structuredContent !== undefined
        ? response.result.structuredContent
        : response.result;
    };
    const approveIdentity = async (
      identity: ToolGatewayIdentity,
      argumentsValue: Record<string, unknown> = {},
      options: {
        operationId?: string;
        signal?: AbortSignal;
      } = {},
    ): Promise<ToolGatewayApprovalResponse> => {
      const current = await catalog(options.signal ? { signal: options.signal } : {});
      const request: ToolGatewayApprovalRequest = {
        operationId: options.operationId ?? crypto.randomUUID(),
        catalogDigest: current.digest,
        identity,
        arguments: argumentsValue,
      };
      return await this.transport.requestJson<ToolGatewayApprovalResponse>(
        "POST",
        `/v1/workspaces/${encodeURIComponent(normalizedWorkspaceId)}/tools/approvals`,
        request,
        {},
        options.signal ? { signal: options.signal } : {},
      );
    };
    const invokePath = async (
      path: readonly string[],
      argumentsValue: Record<string, unknown> = {},
      options: OpenGeniToolCallOptions = {},
    ): Promise<unknown> => {
      const current = await catalog({
        ...(options.refreshCatalog === undefined ? {} : { refresh: options.refreshCatalog }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const entry = current.entries.find(
        (candidate) =>
          candidate.codemodePath.length === path.length &&
          candidate.codemodePath.every((segment, index) => segment === path[index]),
      );
      if (!entry)
        throw new Error(`Tool is not present in the workspace catalog: ${path.join(".")}`);
      return await callIdentity(entry.identity, argumentsValue, options);
    };
    const node = (path: readonly string[]): OpenGeniDynamicToolNode =>
      new Proxy(
        (async (argumentsValue = {}, options = {}) =>
          await invokePath(path, argumentsValue, options)) as OpenGeniDynamicToolNode,
        {
          get: (_target, property) => {
            // Dynamic namespaces must never become accidental Promise-like
            // values when passed through await/Promise.resolve.
            if (property === "then") return undefined;
            if (typeof property !== "string") return undefined;
            return node([...path, property]);
          },
        },
      );
    return new Proxy(Object.create(null) as OpenGeniWorkspaceTools, {
      get: (_target, property) => {
        if (property === "then") return undefined;
        if (property === "$catalog") return catalog;
        if (property === "$call") return callIdentity;
        if (property === "$approve") return approveIdentity;
        if (property === "$declarations") {
          return async (options: { signal?: AbortSignal } = {}) =>
            await this.transport.requestJson<ToolGatewayDeclarationsResponse>(
              "GET",
              `/v1/workspaces/${encodeURIComponent(normalizedWorkspaceId)}/tools/declarations`,
              undefined,
              {},
              options.signal ? { signal: options.signal } : {},
            );
        }
        if (typeof property !== "string") return undefined;
        return node([property]);
      },
    });
  }
}

function findCatalogEntry(
  catalog: ToolGatewayCatalog,
  identity: ToolGatewayIdentity,
): ToolGatewayCatalogEntry | undefined {
  return catalog.entries.find(
    (entry) =>
      entry.identity.serverId === identity.serverId &&
      entry.identity.toolName === identity.toolName,
  );
}

function requiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}
