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
  if (operation.state === "queued") {
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
