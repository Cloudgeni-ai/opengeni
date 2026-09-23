import { siteRequestHeaders } from "@opengeni/contracts/site-session-http";
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
import { hasPermission, requireSessionAuthorization } from "@opengeni/core";
import {
  getActiveSessionTurnForExecution,
  getAttemptToolCatalog,
  getCodemodeOperation,
  submitCodemodeOperation,
} from "@opengeni/db";
import { getSession } from "@opengeni/db";
import {
  allowedFirstPartyMcpToolsForSession,
  resolveFirstPartyDelegationSecret,
  type Settings,
} from "@opengeni/config";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  signDelegatedAccessToken,
  siteSessionPath,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  type Permission,
  type Session,
} from "@opengeni/contracts";
import { permissionsRequiredByFirstPartyTools } from "./mcp/first-party-tool-permissions";

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
  settings: Pick<Settings, "defaultFirstPartyMcpTools" | "allowedFirstPartyMcpTools">,
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

/** Reuse normal REST handlers, including their resource/command authorization.
 * The exact attempt is checked before issuing this internal-only credential. */
export async function codemodeSessionRequest(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  request: Request,
  path: string,
): Promise<Request> {
  siteSessionPath(path, grant.workspaceId, request.method);
  const { authority } = await requireActiveCodemodeCatalog(deps, grant);
  const session = await getSession(deps.db, authority.workspaceId, authority.sessionId);
  const secret = resolveFirstPartyDelegationSecret(deps.settings);
  if (!session || !secret) throw new CodemodeAuthorityError("invalid_grant");
  const permissions = codemodeSessionProxyPermissions(deps.settings, session);
  const token = await signDelegatedAccessToken(secret, {
    ...authority,
    permissions,
    principalKind: "agent_attempt",
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const target = new URL(request.url);
  const rewritten = siteSessionPath(path, authority.workspaceId, request.method);
  const url = new URL(rewritten, target.origin);
  const headers = siteRequestHeaders(request.headers);
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
): Promise<{ authority: CodemodeGrantAuthority; catalog: AttemptToolCatalog }> {
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
  return { authority, catalog };
}

export async function submitAndDispatchCodemodeCall(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  rawRequest: unknown,
): Promise<CodemodeCallSubmissionValue> {
  const request = CodemodeCallRequest.parse(rawRequest);
  const { authority, catalog } = await requireActiveCodemodeCatalog(deps, grant);
  if (request.catalogDigest !== catalog.digest) throw new CodemodeCatalogStaleError();
  const submitted = await submitCodemodeOperation(deps.db, {
    ...authority,
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
    operation = await refreshAdmittedCodemodeOperation(operation, () =>
      getCodemodeOperation(deps.db, {
        accountId: authority.accountId,
        workspaceId: authority.workspaceId,
        attemptId: authority.attemptId,
        operationId: operation.operationId,
      }),
    );
    if (terminal(operation)) dispatch = "terminal";
    else if (operation.state === "running" && dispatch === "unavailable") {
      dispatch = "already_running";
    }
  }
  return CodemodeCallSubmission.parse({ operation, dispatch });
}

export function codemodeOperationNeedsDispatch(operation: CodemodeOperation): boolean {
  return operation.state === "queued" || operation.state === "running";
}

export async function readCodemodeOperation(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  operationId: string,
): Promise<CodemodeOperation | null> {
  if (!isCodemodeGrant(grant)) throw new CodemodeAuthorityError("invalid_grant");
  const authority = codemodeAuthorityForGrant(grant)!;
  return await getCodemodeOperation(deps.db, {
    accountId: authority.accountId,
    workspaceId: authority.workspaceId,
    attemptId: authority.attemptId,
    operationId,
  });
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
