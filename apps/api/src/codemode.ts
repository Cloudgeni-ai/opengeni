import {
  codemodeDispatchSubject,
  decodeCodemodeDispatchAck,
  encodeCodemodeDispatchRequest,
} from "@opengeni/codemode";
import {
  CODEMODE_DISPATCH_TIMEOUT_MS,
  CodemodeCallRequest,
  CodemodeCallSubmission,
  type AccessGrant,
  type AttemptToolCatalog,
  type CodemodeCallSubmission as CodemodeCallSubmissionValue,
  type CodemodeOperation,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { hasPermission, isDeveloperSetupGrant, requireSessionAuthorization } from "@opengeni/core";
import {
  CodemodeToolApprovalRequiredError,
  getActiveSessionTurnForExecution,
  getAttemptToolCatalog,
  getCodemodeOperation,
  readTurnCodemodeOperation,
  submitCodemodeOperation,
  type SessionTurnForExecution,
} from "@opengeni/db";
import { getSession, requireWorkspace } from "@opengeni/db";
import {
  allowedFirstPartyMcpToolsForSession,
  resolveSessionFirstPartyMcpTools,
  resolveFirstPartyDelegationSecret,
  type FirstPartyMcpToolPolicySettings,
} from "@opengeni/config";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  signDelegatedAccessToken,
  readTurnExecutionPolicyV1,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  type Permission,
  type Session,
} from "@opengeni/contracts";
import {
  SITE_FRAME_HEADER,
  SITE_FRAME_ID_HEADER,
  SITE_PREVIEW_FRAME,
  siteFrameFromHeaders,
  siteHostWorkspacePath,
  siteRequestHeaders,
  siteSessionPath,
} from "@opengeni/contracts/site-session-http";
import { permissionsRequiredByFirstPartyTools } from "./mcp/first-party-tool-permissions";
import { isPreparedMcpConnectPath, preparedMcpProxyPermissions } from "./prepared-mcp-permissions";

/** The REST authority a Codemode SDK proxy token may ever carry. */
export const CODEMODE_SESSION_PROXY_PERMISSION_CEILING = [
  "workspace:read",
  "sessions:read",
  "sessions:create",
  "sessions:control",
] as const satisfies readonly Permission[];

/**
 * Proxy permissions = the session's effective first-party permissions, cut
 * down to what its exact model-visible tool selection could actually
 * exercise (plus workspace:read for the context routes), under the fixed
 * ceiling above. A session whose selection has no session_* tool therefore
 * gets only workspace:read and every proxied /sessions handler refuses it,
 * exactly as its MCP surface would.
 */
export function codemodeSessionProxyPermissions(
  settings: FirstPartyMcpToolPolicySettings,
  session: Pick<Session, "firstPartyMcpTools" | "firstPartyMcpPermissions">,
): Permission[] {
  const sessionPermissions = session.firstPartyMcpPermissions ?? [
    ...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  ];
  const selection = allowedFirstPartyMcpToolsForSession(settings, session.firstPartyMcpTools);
  const requiredBySelection = new Set<Permission>([
    "workspace:read",
    ...permissionsRequiredByFirstPartyTools(selection),
  ]);
  return CODEMODE_SESSION_PROXY_PERMISSION_CEILING.filter(
    (permission) => requiredBySelection.has(permission) && sessionPermissions.includes(permission),
  );
}

const FRAME_ID = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * The route a Codemode SDK proxy request may take. The agent's own SDK calls
 * keep the workspace prefix boundary under the proxy permission ceiling. A
 * request a local Site preview forwarded from page code carries the frame
 * marker and is held to the `SITE_OPERATIONS` allowlist; it stays marked as
 * a preview frame (never a published Site) so the API records its origin and
 * keeps it to the sessions it started.
 */
function codemodeProxyRoute(request: Request, path: string) {
  const frame = siteFrameFromHeaders((name) => request.headers.get(name));
  if (!frame) {
    return {
      path: (workspaceId: string) => siteHostWorkspacePath(path, workspaceId),
      frameHeaders: null,
    };
  }
  const frameId = frame.frameId && FRAME_ID.test(frame.frameId) ? frame.frameId : null;
  return {
    path: (workspaceId: string) => siteSessionPath(path, workspaceId, request.method),
    frameHeaders: {
      [SITE_FRAME_HEADER]: SITE_PREVIEW_FRAME,
      ...(frameId ? { [SITE_FRAME_ID_HEADER]: frameId } : {}),
    },
  };
}

/** Reuse normal REST handlers, including their resource/command authorization.
 * The exact attempt is checked before issuing this internal-only credential. */
export async function codemodeSessionRequest(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  request: Request,
  path: string,
  resolveProxySettings?: (session: Session) => FirstPartyMcpToolPolicySettings,
): Promise<Request> {
  const route = codemodeProxyRoute(request, path);
  route.path(grant.workspaceId);
  const { authority, turn, catalog } = await requireActiveCodemodeCatalog(deps, grant);
  const session = await getSession(deps.db, authority.workspaceId, authority.sessionId);
  const secret = resolveFirstPartyDelegationSecret(deps.settings);
  if (!session || !secret) throw new CodemodeAuthorityError("invalid_grant");
  const selection = resolveSessionFirstPartyMcpTools(
    resolveProxySettings?.(session) ?? deps.settings,
    session,
    (await requireWorkspace(deps.db, authority.workspaceId)).settings,
  ).filter((name) =>
    catalog.entries.some(
      (entry) => entry.identity.serverId === "opengeni" && entry.identity.toolName === name,
    ),
  );
  const permissions = codemodeSessionProxyPermissions(
    resolveProxySettings?.(session) ?? deps.settings,
    { ...session, firstPartyMcpTools: selection },
  );
  if (isPreparedMcpConnectPath(route.path(grant.workspaceId), request.method)) {
    if (selection.includes("custom_mcp_setup_request"))
      permissions.push(
        ...preparedMcpProxyPermissions(
          catalog,
          session.firstPartyMcpPermissions ?? [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
        ),
      );
  }
  const turnPolicy = readTurnExecutionPolicyV1(turn.metadata);
  const initialPolicy = readTurnExecutionPolicyV1(session.metadata);
  const restricted =
    isDeveloperSetupGrant(grant) ||
    (turnPolicy.kind === "valid" &&
      turnPolicy.policy.credentialRestriction === "developer_setup") ||
    (initialPolicy.kind === "valid" &&
      initialPolicy.policy.credentialRestriction === "developer_setup");
  const token = await signDelegatedAccessToken(secret, {
    ...authority,
    permissions,
    principalKind: "agent_attempt",
    ...(restricted ? { credentialRestriction: "developer_setup" as const } : {}),
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const target = new URL(request.url);
  const rewritten = route.path(authority.workspaceId);
  const url = new URL(rewritten, target.origin);
  const headers = siteRequestHeaders(request.headers);
  for (const [name, value] of Object.entries(route.frameHeaders ?? {})) headers.set(name, value);
  headers.set("authorization", `Bearer ${token}`);
  headers.set(OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION);
  return new Request(url, {
    method: request.method,
    headers,
    signal: request.signal,
    ...(request.body ? { body: await request.text() } : {}),
  });
}

export type CodemodeGrantAuthority = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  subjectId: string;
};

export type CodemodeAuthorityFailureReason =
  | "invalid_grant"
  | "inactive_attempt"
  | "catalog_mismatch";

const CODEMODE_AUTHORITY_FAILURE_MESSAGES: Record<CodemodeAuthorityFailureReason, string> = {
  invalid_grant: "Codemode bearer does not carry valid execution-attempt authority",
  inactive_attempt: "Codemode execution attempt is no longer active",
  catalog_mismatch: "Codemode tool catalog does not match the active execution attempt",
};

export class CodemodeAuthorityError extends Error {
  readonly code: `codemode_${CodemodeAuthorityFailureReason}`;

  constructor(readonly reason: CodemodeAuthorityFailureReason) {
    super(CODEMODE_AUTHORITY_FAILURE_MESSAGES[reason]);
    this.name = "CodemodeAuthorityError";
    this.code = `codemode_${reason}`;
  }
}

export class CodemodeCatalogNotReadyError extends Error {
  readonly code = "codemode_catalog_not_ready";

  constructor() {
    super("Codemode tool catalog is not ready for the active execution attempt");
    this.name = "CodemodeCatalogNotReadyError";
  }
}

export class CodemodeCatalogStaleError extends Error {
  readonly code = "codemode_catalog_stale";

  constructor() {
    super("Codemode tool catalog is stale for the active execution attempt");
    this.name = "CodemodeCatalogStaleError";
  }
}

export function codemodeAuthorityForGrant(grant: AccessGrant): CodemodeGrantAuthority | null {
  const metadata = grant.metadata;
  if (
    grant.principalKind !== "agent_attempt" ||
    metadata?.delegated !== true ||
    typeof metadata.sessionId !== "string" ||
    typeof metadata.turnId !== "string" ||
    typeof metadata.attemptId !== "string" ||
    typeof metadata.executionGeneration !== "number" ||
    !Number.isInteger(metadata.executionGeneration) ||
    metadata.executionGeneration < 1
  ) {
    return null;
  }
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: metadata.sessionId,
    turnId: metadata.turnId,
    attemptId: metadata.attemptId,
    executionGeneration: metadata.executionGeneration,
    subjectId: grant.subjectId,
  };
}

export function isCodemodeGrant(grant: AccessGrant): boolean {
  return (
    hasPermission(grant.permissions, "codemode:call") && codemodeAuthorityForGrant(grant) !== null
  );
}

export function requireMatchingCodemodeCatalog(
  authority: CodemodeGrantAuthority,
  catalog: AttemptToolCatalog | null,
): AttemptToolCatalog {
  if (!catalog) throw new CodemodeCatalogNotReadyError();
  if (
    catalog.accountId !== authority.accountId ||
    catalog.workspaceId !== authority.workspaceId ||
    catalog.sessionId !== authority.sessionId ||
    catalog.turnId !== authority.turnId ||
    catalog.attemptId !== authority.attemptId ||
    catalog.executionGeneration !== authority.executionGeneration
  ) {
    throw new CodemodeAuthorityError("catalog_mismatch");
  }
  return catalog;
}

export async function requireActiveCodemodeCatalog(
  deps: ApiRouteDeps,
  grant: AccessGrant,
): Promise<{
  authority: CodemodeGrantAuthority;
  catalog: AttemptToolCatalog;
  turn: SessionTurnForExecution;
}> {
  if (!isCodemodeGrant(grant)) throw new CodemodeAuthorityError("invalid_grant");
  const authority = codemodeAuthorityForGrant(grant)!;
  await requireSessionAuthorization(deps, grant, {
    sessionId: authority.sessionId,
    operation: "session.codemode.call",
    surface: "codemode",
  });
  const active = await getActiveSessionTurnForExecution(
    deps.db,
    authority.workspaceId,
    authority.sessionId,
  );
  if (
    !active ||
    active.status !== "running" ||
    active.id !== authority.turnId ||
    active.activeAttemptId !== authority.attemptId ||
    active.executionGeneration !== authority.executionGeneration
  ) {
    throw new CodemodeAuthorityError("inactive_attempt");
  }
  const catalog = requireMatchingCodemodeCatalog(
    authority,
    await getAttemptToolCatalog(deps.db, {
      accountId: authority.accountId,
      workspaceId: authority.workspaceId,
      attemptId: authority.attemptId,
    }),
  );
  return { authority, catalog, turn: active };
}

export async function submitAndDispatchCodemodeCall(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  rawRequest: unknown,
  signal?: AbortSignal,
): Promise<CodemodeCallSubmissionValue> {
  const { durableApproval, ...request } = CodemodeCallRequest.parse(rawRequest);
  const { authority, catalog } = await requireActiveCodemodeCatalog(deps, grant);
  if (request.catalogDigest !== catalog.digest) throw new CodemodeCatalogStaleError();
  const submitted = await submitCodemodeOperation(deps.db, {
    ...authority,
    ...(durableApproval ? { durableApproval: true } : {}),
    call: {
      ...request,
      caller: { kind: "codemode", subjectId: authority.subjectId },
    },
  });
  let operation = submitted.operation;
  let dispatch: CodemodeCallSubmissionValue["dispatch"] = terminal(operation)
    ? "terminal"
    : operation.state === "running"
      ? "already_running"
      : "unavailable";
  if (codemodeOperationNeedsDispatch(operation)) {
    const readOperation = () =>
      getCodemodeOperation(deps.db, {
        accountId: authority.accountId,
        workspaceId: authority.workspaceId,
        attemptId: authority.attemptId,
        operationId: operation.operationId,
      });
    // Listen before dispatching so a fast settlement cannot be missed. The
    // settlement event is committed with the operation row, so its arrival
    // means one read returns the terminal operation.
    const wake = codemodeSettlementWake();
    const unsubscribe = await deps.bus
      .subscribe(authority.workspaceId, authority.sessionId, (events) => {
        if (events.some((event) => isCodemodeSettlementEvent(event, operation.operationId))) {
          wake.notify();
        }
      })
      .catch(() => null);
    try {
      try {
        const reply = await deps.bus.request(
          codemodeDispatchSubject(authority.workspaceId, authority.attemptId),
          encodeCodemodeDispatchRequest({
            version: 1,
            operationId: operation.operationId,
            catalogDigest: catalog.digest,
          }),
          { timeoutMs: CODEMODE_DISPATCH_TIMEOUT_MS },
        );
        dispatch = decodeCodemodeDispatchAck(reply.data).status;
      } catch {
        dispatch = "unavailable";
      }
      operation = await refreshAdmittedCodemodeOperation(operation, readOperation);
      // An executing call usually settles within moments. Return its result in
      // this response so clients need no polling round; a longer call returns
      // still running and is read as before.
      if (
        unsubscribe &&
        !terminal(operation) &&
        (dispatch === "accepted" || dispatch === "already_running")
      ) {
        operation = await awaitCodemodeSettlement({
          operation,
          read: readOperation,
          wake,
          budgetMs: CODEMODE_SUBMIT_SETTLE_WAIT_MS,
          fallbackReadMs: CODEMODE_SETTLE_FALLBACK_READ_MS,
          ...(signal ? { signal } : {}),
        });
      }
      if (terminal(operation)) dispatch = "terminal";
      else if (operation.state === "running" && dispatch === "unavailable") {
        dispatch = "already_running";
      }
    } finally {
      unsubscribe?.();
    }
  }
  return CodemodeCallSubmission.parse({ operation, dispatch });
}

/**
 * How long a submission holds its request open for the call to settle. Most
 * tool calls finish well within it; a longer call returns still running.
 */
export const CODEMODE_SUBMIT_SETTLE_WAIT_MS = 8_000;
/** Safety-net read cadence if the live settlement event is missed. */
export const CODEMODE_SETTLE_FALLBACK_READ_MS = 400;

export function isCodemodeSettlementEvent(
  event: { type: string; payload?: unknown },
  operationId: string,
): boolean {
  if (event.type !== "agent.toolCall.output") return false;
  const payload = event.payload;
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { id?: unknown }).id === operationId
  );
}

export type CodemodeSettlementWake = {
  notify(): void;
  /** Resolve on the next notification (or one already pending), a timeout or abort. */
  wait(timeoutMs: number, signal?: AbortSignal): Promise<void>;
};

export function codemodeSettlementWake(): CodemodeSettlementWake {
  let pending = false;
  let release: (() => void) | null = null;
  return {
    notify() {
      pending = true;
      release?.();
    },
    async wait(timeoutMs, signal) {
      if (!pending && !signal?.aborted) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            release = null;
            resolve();
          };
          const timer = setTimeout(done, Math.max(0, timeoutMs));
          signal?.addEventListener("abort", done, { once: true });
          release = done;
        });
      }
      pending = false;
    },
  };
}

/**
 * Wait, within a budget, for an executing operation to settle. Waits only
 * while the operation is queued or running; approval and terminal states
 * return at once. Read failures keep the last known row.
 */
export async function awaitCodemodeSettlement(input: {
  operation: CodemodeOperation;
  read: () => Promise<CodemodeOperation | null>;
  wake: CodemodeSettlementWake;
  budgetMs: number;
  fallbackReadMs: number;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<CodemodeOperation> {
  const now = input.now ?? (() => performance.now());
  const deadline = now() + input.budgetMs;
  let operation = input.operation;
  while (operation.state === "queued" || operation.state === "running") {
    const remaining = deadline - now();
    if (remaining <= 0 || input.signal?.aborted) break;
    await input.wake.wait(Math.min(input.fallbackReadMs, remaining), input.signal);
    if (input.signal?.aborted) break;
    operation = (await input.read().catch(() => null)) ?? operation;
  }
  return operation;
}

export function codemodeOperationNeedsDispatch(operation: CodemodeOperation): boolean {
  return operation.state === "queued" || operation.state === "running";
}

export async function readCodemodeOperation(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  operationId: string,
  options: { durableApproval?: boolean } = {},
): Promise<CodemodeOperation | null> {
  const { authority } = await requireActiveCodemodeCatalog(deps, grant);
  const operation = await readTurnCodemodeOperation(deps.db, {
    ...authority,
    callerSubjectId: authority.subjectId,
    operationId,
  });
  if (operation?.state === "waiting_for_approval" && !options.durableApproval)
    throw new CodemodeToolApprovalRequiredError();
  if (!operation || options.durableApproval) return operation;
  const { durableApproval: _capability, approvalRequestId: _requestId, ...legacy } = operation;
  return legacy;
}

function terminal(operation: CodemodeOperation): boolean {
  return ["completed", "failed", "outcome_unknown", "cancelled"].includes(operation.state);
}

export async function refreshAdmittedCodemodeOperation(
  admitted: CodemodeOperation,
  read: () => Promise<CodemodeOperation | null>,
): Promise<CodemodeOperation> {
  try {
    return (await read()) ?? admitted;
  } catch {
    // Admission is already durable. Returning the known row lets the client
    // continue with the same operation id instead of turning a refresh outage
    // into an unmarked post-commit failure.
    return admitted;
  }
}
