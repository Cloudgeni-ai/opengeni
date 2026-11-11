import { OpenGeniApiError } from "./errors";
import { createSharedCatalogLoader, type SharedCatalogLoader } from "./shared-catalog-loader";
import {
  OpenGeniToolCallError,
  OpenGeniToolReapprovalRequiredError,
  type OpenGeniToolTransport,
  type OpenGeniWorkspaceTools,
  type OpenGeniToolCallOptions,
} from "./tools";
import type {
  ToolGatewayTarget,
  ToolGatewayResolvedTool,
  ToolGatewayInvokeRequest,
  ToolGatewayInvokeResponse,
  ToolGatewayTargetApprovalResponse,
  ToolGatewayManifestRequest,
  ToolGatewayManifestResponse,
  ToolGatewayIdentity,
} from "./types";

type Snapshot = ToolGatewayResolvedTool & { digest: string };
const targetKey = (target: ToolGatewayTarget) =>
  "identity" in target
    ? JSON.stringify(["identity", target.identity.serverId, target.identity.toolName])
    : JSON.stringify(["path", ...target.path]);
export const isToolDefinitionStale = (error: unknown) => {
  if (typeof error !== "object" || error === null) return false;
  if (
    ("outcomeUnknown" in error && error.outcomeUnknown === true) ||
    ("retryable" in error && error.retryable === false)
  )
    return false;
  return error instanceof OpenGeniApiError
    ? error.status === 409 && error.details?.code === "tool_definition_stale"
    : typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "tool_definition_stale";
};

/** Per-facade metadata only. Never coalesce invocations or retain credentials. */
export function createKnownWorkspaceTools(
  transport: OpenGeniToolTransport,
  workspaceId: string,
  createLegacy: () => OpenGeniWorkspaceTools,
): OpenGeniWorkspaceTools {
  const base = `/v1/workspaces/${encodeURIComponent(workspaceId)}/tools`;
  let legacy: OpenGeniWorkspaceTools | undefined;
  const old = () => (legacy ??= createLegacy());
  const legacyTokens = new Set<string>();
  const loaders = new Map<string, SharedCatalogLoader<Snapshot>>();
  const snapshots = new Map<string, ToolGatewayResolvedTool>();
  const revisions = new Map<string, number>();
  let revisionSequence = 0;
  const advance = (key: string) => {
    if (!revisions.has(key) && revisions.size >= 256)
      revisions.delete(revisions.keys().next().value!);
    const revision = ++revisionSequence;
    revisions.set(key, revision);
    return revision;
  };
  const approvals = new Map<string, ToolGatewayTargetApprovalResponse>();
  const loader = (target: ToolGatewayTarget) => {
    const key = targetKey(target);
    let value = loaders.get(key);
    if (!value) {
      value = createSharedCatalogLoader(async (_refresh, signal) => {
        const result = await transport.requestJson<ToolGatewayResolvedTool>(
          "POST",
          `${base}/resolve`,
          { target },
          {},
          { signal },
        );
        return { ...result, digest: result.definitionDigest };
      });
      if (loaders.size >= 256) loaders.delete(loaders.keys().next().value!);
      loaders.set(key, value);
    }
    return value;
  };
  const remember = (target: ToolGatewayTarget, tool: ToolGatewayResolvedTool, revision: number) => {
    const key = targetKey(target);
    if (revisions.get(key) !== revision) return;
    if (snapshots.size >= 256) snapshots.delete(snapshots.keys().next().value!);
    snapshots.set(key, tool);
  };
  const resolve = async (
    target: ToolGatewayTarget,
    options: {
      refresh?: boolean;
      signal?: AbortSignal;
      siteArtifactId?: string;
      siteVersionId?: string;
    } = {},
  ) => {
    if (options.siteArtifactId || options.siteVersionId)
      return await transport.requestJson<ToolGatewayResolvedTool>(
        "POST",
        `${base}/resolve`,
        { target, siteArtifactId: options.siteArtifactId, siteVersionId: options.siteVersionId },
        {},
        options.signal ? { signal: options.signal } : {},
      );
    const key = targetKey(target);
    const revision = advance(key);
    if (options.refresh) snapshots.delete(key);
    const result = await loader(target).load(options);
    remember(target, result, revision);
    return result;
  };
  const invoke = (request: ToolGatewayInvokeRequest, options: { signal?: AbortSignal } = {}) =>
    transport.requestJson<ToolGatewayInvokeResponse>(
      "POST",
      `${base}/invoke`,
      request,
      {},
      options,
    );
  const call = async (
    target: ToolGatewayTarget,
    args: Record<string, unknown> = {},
    options: OpenGeniToolCallOptions = {},
  ) => {
    if (
      options.approvalToken &&
      (options.approvalBinding === "catalog" || legacyTokens.has(options.approvalToken))
    ) {
      if ("identity" in target) return await old().$call(target.identity, args, options);
      let node: unknown = old();
      for (const part of target.path) node = (node as Record<string, unknown>)[part];
      return await (
        node as (
          args: Record<string, unknown>,
          options: OpenGeniToolCallOptions,
        ) => Promise<unknown>
      )(args, options);
    }
    if (options.approvalToken && !options.operationId)
      throw new TypeError("operationId is required when using an approval token");
    options.signal?.throwIfAborted();
    const operationId = options.operationId ?? crypto.randomUUID();
    const key = targetKey(target);
    const revision = advance(key);
    if (options.refreshCatalog) snapshots.delete(key);
    let tool = options.refreshCatalog
      ? await loader(target).load({
          refresh: true,
          ...(options.signal ? { signal: options.signal } : {}),
        })
      : snapshots.get(key);
    const approved = options.approvalToken ? approvals.get(options.approvalToken) : undefined;
    const expected =
      options.expectedDefinitionDigest !== undefined
        ? options.expectedDefinitionDigest
        : options.approvalToken
          ? undefined
          : tool?.definitionDigest;
    if (
      approved &&
      (approved.operationId !== operationId ||
        ("identity" in target && targetKey({ identity: approved.tool.entry.identity }) !== key))
    )
      throw new OpenGeniToolReapprovalRequiredError(
        operationId,
        approved.tool.definitionDigest,
        expected ?? "",
        approved.tool.entry.identity,
      );
    const send = (digest: string | undefined) =>
      invoke(
        {
          operationId,
          target,
          arguments: args,
          ...(digest === undefined ? {} : { expectedDefinitionDigest: digest }),
          ...(options.approvalToken ? { approvalToken: options.approvalToken } : {}),
        },
        options.signal ? { signal: options.signal } : {},
      );
    let response: ToolGatewayInvokeResponse;
    try {
      response = await send(expected);
    } catch (error) {
      if (!isToolDefinitionStale(error) || expected === undefined) throw error;
      if (revisions.get(key) === revision) snapshots.delete(key);
      if (options.expectedDefinitionDigest !== undefined && !options.approvalToken) throw error;
      tool = await loader(target).reloadAfterStale(expected, options.signal);
      remember(target, tool, revision);
      if (options.approvalToken || options.expectedDefinitionDigest !== undefined)
        throw new OpenGeniToolReapprovalRequiredError(
          operationId,
          expected,
          tool.definitionDigest,
          tool.entry.identity,
        );
      response = await send(tool.definitionDigest);
    }
    if (options.approvalToken) approvals.delete(options.approvalToken);
    remember(target, response.tool, revision);
    if (response.result.isError) throw new OpenGeniToolCallError(response.result);
    return response.tool.entry.outputSchema && response.result.structuredContent !== undefined
      ? response.result.structuredContent
      : response.result;
  };
  const approveTarget = async (
    identity: ToolGatewayIdentity,
    args: Record<string, unknown> = {},
    options: OpenGeniToolCallOptions = {},
  ) => {
    const tool = await resolve(
      { identity },
      { ...(options.signal ? { signal: options.signal } : {}) },
    );
    const response = await transport.requestJson<ToolGatewayTargetApprovalResponse>(
      "POST",
      `${base}/target-approvals`,
      {
        identity,
        arguments: args,
        operationId: options.operationId ?? crypto.randomUUID(),
        expectedDefinitionDigest:
          options.expectedDefinitionDigest === undefined
            ? tool.definitionDigest
            : options.expectedDefinitionDigest,
      },
      {},
      options.signal ? { signal: options.signal } : {},
    );
    if (approvals.size >= 256) approvals.delete(approvals.keys().next().value!);
    approvals.set(response.approvalToken, response);
    return response;
  };
  const node = (path: string[]): unknown =>
    new Proxy(
      async (args: Record<string, unknown> = {}, options: OpenGeniToolCallOptions = {}) =>
        call({ path }, args, options),
      {
        get: (_target, property) =>
          property === "then" || typeof property !== "string"
            ? undefined
            : node([...path, property]),
      },
    );
  return new Proxy(Object.create(null) as OpenGeniWorkspaceTools, {
    get: (_target, property) => {
      if (property === "then" || typeof property !== "string") return undefined;
      if (property === "$targetProtocol") return 1;
      if (property === "$resolve") return resolve;
      if (property === "$invoke") return invoke;
      if (property === "$manifest")
        return (request: ToolGatewayManifestRequest, options: { signal?: AbortSignal } = {}) =>
          transport.requestJson<ToolGatewayManifestResponse>(
            "POST",
            `${base}/manifest`,
            request,
            {},
            options,
          );
      if (property === "$call")
        return (
          identity: ToolGatewayIdentity,
          args?: Record<string, unknown>,
          options?: OpenGeniToolCallOptions,
        ) => call({ identity }, args, options);
      if (property === "$approveTarget") return approveTarget;
      if (property === "$approve")
        return async (...args: Parameters<OpenGeniWorkspaceTools["$approve"]>) => {
          const response = await old().$approve(...args);
          if (legacyTokens.size >= 256) legacyTokens.delete(legacyTokens.values().next().value!);
          legacyTokens.add(response.approvalToken);
          return response;
        };
      if (property === "$catalog") return old().$catalog;
      if (property === "$declarations") return old().$declarations;
      return node([property]);
    },
  });
}
