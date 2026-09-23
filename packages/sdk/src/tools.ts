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
import { OpenGeniApiError } from "./errors";

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

export type OpenGeniWorkspaceTools<
  TCatalog extends Pick<
    ToolGatewayCatalog,
    "version" | "generation" | "digest" | "createdAt" | "entries"
  > = ToolGatewayCatalog,
> = OpenGeniGeneratedTools &
  OpenGeniDynamicToolNamespace & {
    readonly $catalog: (options?: { refresh?: boolean; signal?: AbortSignal }) => Promise<TCatalog>;
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
  readonly outcomeUnknown: boolean;

  constructor(readonly result: ToolGatewayResult) {
    const structured = result.structuredContent as
      | {
          error?: {
            code?: unknown;
            message?: unknown;
            retryable?: unknown;
            outcomeUnknown?: unknown;
          };
        }
      | undefined;
    super(
      typeof structured?.error?.message === "string"
        ? structured.error.message
        : "OpenGeni tool call failed",
    );
    this.name = "OpenGeniToolCallError";
    this.code = typeof structured?.error?.code === "string" ? structured.error.code : "tool_error";
    this.retryable = structured?.error?.retryable === true;
    this.outcomeUnknown = structured?.error?.outcomeUnknown === true;
  }
}

/** A catalog refresh invalidated the single-use approval capability for this call. */
export class OpenGeniToolReapprovalRequiredError extends Error {
  readonly code = "tool_reapproval_required" as const;
  readonly retryable = false;

  constructor(
    readonly operationId: string,
    readonly previousCatalogDigest: string,
    readonly catalogDigest: string,
    readonly identity: ToolGatewayIdentity,
  ) {
    super(
      "The workspace tool catalog changed after approval. Request a new approval for the refreshed tool identity and retry with the same operation ID.",
    );
    this.name = "OpenGeniToolReapprovalRequiredError";
  }
}

export class OpenGeniToolsClient implements OpenGeniToolsFacade {
  constructor(private readonly transport: OpenGeniToolTransport) {}

  forWorkspace(workspaceId: string): OpenGeniWorkspaceTools {
    const normalizedWorkspaceId = requiredId(workspaceId, "workspaceId");
    let catalogSnapshot: ToolGatewayCatalog | null = null;
    const approvalBindings = new Map<
      string,
      {
        operationId: string;
        catalogDigest: string;
        identity: ToolGatewayIdentity;
      }
    >();
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
    const callResolvedIdentity = async (
      resolveIdentity: (current: ToolGatewayCatalog) => ToolGatewayIdentity,
      argumentsValue: Record<string, unknown>,
      options: OpenGeniToolCallOptions,
    ): Promise<unknown> => {
      if (options.approvalToken && !options.operationId) {
        throw new TypeError("operationId is required when using an approval token");
      }
      const operationId = options.operationId ?? crypto.randomUUID();
      const initial = await catalog({
        ...(options.refreshCatalog === undefined ? {} : { refresh: options.refreshCatalog }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const invoke = async (current: ToolGatewayCatalog): Promise<unknown> => {
        const identity = resolveIdentity(current);
        const approvalBinding = options.approvalToken
          ? approvalBindings.get(options.approvalToken)
          : undefined;
        if (
          approvalBinding &&
          (approvalBinding.operationId !== operationId ||
            approvalBinding.catalogDigest !== current.digest ||
            !sameToolIdentity(approvalBinding.identity, identity))
        ) {
          throw new OpenGeniToolReapprovalRequiredError(
            operationId,
            approvalBinding.catalogDigest,
            current.digest,
            identity,
          );
        }
        const request: ToolGatewayCallRequest = {
          operationId,
          catalogDigest: current.digest,
          identity,
          arguments: argumentsValue,
          ...(options.approvalToken ? { approvalToken: options.approvalToken } : {}),
        };
        let response: ToolGatewayCallResponse;
        try {
          response = await this.transport.requestJson<ToolGatewayCallResponse>(
            "POST",
            `/v1/workspaces/${encodeURIComponent(normalizedWorkspaceId)}/tools/calls`,
            request,
            {},
            options.signal ? { signal: options.signal } : {},
          );
        } catch (error) {
          if (isCatalogStaleApiError(error)) catalogSnapshot = null;
          else if (options.approvalToken) approvalBindings.delete(options.approvalToken);
          throw error;
        }
        if (options.approvalToken) approvalBindings.delete(options.approvalToken);
        if (response.catalogDigest !== current.digest) {
          catalogSnapshot = null;
        }
        if (response.result.isError) throw new OpenGeniToolCallError(response.result);
        const entry = findCatalogEntry(current, identity);
        return entry?.outputSchema && response.result.structuredContent !== undefined
          ? response.result.structuredContent
          : response.result;
      };
      try {
        return await invoke(initial);
      } catch (error) {
        if (!isCatalogStaleApiError(error)) throw error;
      }
      const refreshed = await catalog({
        refresh: true,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const refreshedIdentity = resolveIdentity(refreshed);
      if (options.approvalToken && refreshed.digest !== initial.digest) {
        throw new OpenGeniToolReapprovalRequiredError(
          operationId,
          initial.digest,
          refreshed.digest,
          refreshedIdentity,
        );
      }
      return await invoke(refreshed);
    };
    const callIdentity = async (
      identity: ToolGatewayIdentity,
      argumentsValue: Record<string, unknown> = {},
      options: OpenGeniToolCallOptions = {},
    ): Promise<unknown> =>
      await callResolvedIdentity(
        (current) => requireCatalogIdentity(current, identity),
        argumentsValue,
        options,
      );
    const approveIdentity = async (
      identity: ToolGatewayIdentity,
      argumentsValue: Record<string, unknown> = {},
      options: {
        operationId?: string;
        signal?: AbortSignal;
      } = {},
    ): Promise<ToolGatewayApprovalResponse> => {
      const operationId = options.operationId ?? crypto.randomUUID();
      const approve = async (current: ToolGatewayCatalog): Promise<ToolGatewayApprovalResponse> => {
        const request: ToolGatewayApprovalRequest = {
          operationId,
          catalogDigest: current.digest,
          identity: requireCatalogIdentity(current, identity),
          arguments: argumentsValue,
        };
        try {
          const response = await this.transport.requestJson<ToolGatewayApprovalResponse>(
            "POST",
            `/v1/workspaces/${encodeURIComponent(normalizedWorkspaceId)}/tools/approvals`,
            request,
            {},
            options.signal ? { signal: options.signal } : {},
          );
          approvalBindings.set(response.approvalToken, {
            operationId: response.operationId,
            catalogDigest: response.catalogDigest,
            identity: response.identity,
          });
          return response;
        } catch (error) {
          if (isCatalogStaleApiError(error)) catalogSnapshot = null;
          throw error;
        }
      };
      const initial = await catalog(options.signal ? { signal: options.signal } : {});
      try {
        return await approve(initial);
      } catch (error) {
        if (!isCatalogStaleApiError(error)) throw error;
      }
      const refreshed = await catalog({
        refresh: true,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return await approve(refreshed);
    };
    const invokePath = async (
      path: readonly string[],
      argumentsValue: Record<string, unknown> = {},
      options: OpenGeniToolCallOptions = {},
    ): Promise<unknown> => {
      return await callResolvedIdentity(
        (current) => requireCatalogPath(current, path).identity,
        argumentsValue,
        options,
      );
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

function sameToolIdentity(left: ToolGatewayIdentity, right: ToolGatewayIdentity): boolean {
  return left.serverId === right.serverId && left.toolName === right.toolName;
}

function requireCatalogIdentity(
  catalog: ToolGatewayCatalog,
  identity: ToolGatewayIdentity,
): ToolGatewayIdentity {
  const entry = findCatalogEntry(catalog, identity);
  if (!entry) {
    throw new Error(
      `Tool is not present in the workspace catalog: ${identity.serverId}/${identity.toolName}`,
    );
  }
  return entry.identity;
}

function requireCatalogPath(
  catalog: ToolGatewayCatalog,
  path: readonly string[],
): ToolGatewayCatalogEntry {
  const entry = catalog.entries.find(
    (candidate) =>
      candidate.codemodePath.length === path.length &&
      candidate.codemodePath.every((segment, index) => segment === path[index]),
  );
  if (!entry) throw new Error(`Tool is not present in the workspace catalog: ${path.join(".")}`);
  return entry;
}

function isCatalogStaleApiError(
  error: unknown,
): error is OpenGeniApiError | { code: "catalog_stale" } {
  return (
    (error instanceof OpenGeniApiError &&
      error.status === 409 &&
      error.details?.code === "catalog_stale") ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "catalog_stale")
  );
}

function requiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}
