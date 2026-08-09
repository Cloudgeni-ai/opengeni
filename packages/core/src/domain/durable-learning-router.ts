import { createHash } from "node:crypto";
import {
  DURABLE_LEARNING_CONTRACT_VERSION,
  DurableLearningAuthorityContext,
  DurableLearningRequest,
  DurableLearningRouteDecision,
  type DurableLearningAttempt,
  type DurableLearningDecisionCode,
  type DurableLearningReceipt,
  type DurableLearningRequest as DurableLearningRequestType,
  type DurableLearningResolvedAuthority,
  type DurableLearningResolvedScope,
  type DurableLearningResolvedSurface,
  type DurableLearningRouterResponse,
  type DurableLearningWriteRequest,
} from "@opengeni/contracts";

const MEMORY_SUBJECTS = new Set(["fact", "decision", "observation", "history"]);
const PREFERENCE_SUBJECTS = new Set([
  "preference",
  "procedure",
  "working_method",
  "skill_guidance",
]);
const INSTRUCTION_POLICY_SUBJECTS = new Set([
  "workspace_charter",
  "mandatory_operating_context",
  "workspace_goal",
]);
const COMPANY_PROFILE_SUBJECTS = new Set([
  "company_identity",
  "company_mission",
  "company_product",
  "company_customer",
  "company_goal",
  "company_constraint",
]);
const DOCUMENT_SUBJECTS = new Set(["document", "connector_content", "transcript"]);

const ALLOWED_SCOPES: Record<DurableLearningResolvedSurface, ReadonlySet<string>> = {
  memory: new Set(["workspace", "user", "role", "session", "ephemeral"]),
  preference_registry: new Set(["organization", "workspace", "user"]),
  instruction_policy: new Set(["workspace", "role"]),
  company_profile: new Set(["organization"]),
  documents_evidence: new Set(["organization", "workspace", "user"]),
};

const SUBJECTS_BY_SURFACE: Record<DurableLearningResolvedSurface, ReadonlySet<string>> = {
  memory: MEMORY_SUBJECTS,
  preference_registry: PREFERENCE_SUBJECTS,
  instruction_policy: INSTRUCTION_POLICY_SUBJECTS,
  company_profile: COMPANY_PROFILE_SUBJECTS,
  documents_evidence: DOCUMENT_SUBJECTS,
};

export class DurableLearningAttemptConflictError extends Error {
  readonly name = "DurableLearningAttemptConflictError";
  readonly code = "ATTEMPT_REUSED_WITH_DIFFERENT_INPUT" as const;
}

export class DurableLearningAttemptInProgressError extends Error {
  readonly name = "DurableLearningAttemptInProgressError";
  readonly code = "ATTEMPT_IN_PROGRESS" as const;
}

export type DurableLearningAttemptReservation = {
  attempt: DurableLearningAttempt;
  receipt: DurableLearningReceipt | null;
  claimId: string | null;
};

export type DurableLearningAttemptLedger = {
  reserveAttempt: (attempt: DurableLearningAttempt) => Promise<DurableLearningAttemptReservation>;
  completeAttempt: (
    attempt: DurableLearningAttempt,
    receipt: DurableLearningReceipt,
    claimId: string,
  ) => Promise<DurableLearningReceipt>;
  renewAttemptClaim: (attempt: DurableLearningAttempt, claimId: string) => Promise<boolean>;
  getCompletedAttempt: (
    accountId: string,
    workspaceId: string,
    attemptId: string,
  ) => Promise<{ attempt: DurableLearningAttempt; receipt: DurableLearningReceipt } | null>;
};

export type DurableLearningAuthorityWriteResult = {
  outcome: "applied" | "proposed" | "evidence_recorded" | "noop";
  resource: DurableLearningReceipt["resource"];
  effectiveBoundary: DurableLearningReceipt["effectiveBoundary"];
  rollback: DurableLearningReceipt["rollback"];
};

export type DurableLearningAuthorityRollbackResult = {
  resource: DurableLearningReceipt["resource"];
  effectiveBoundary: DurableLearningReceipt["effectiveBoundary"];
};

export type DurableLearningAuthorityAdapter = {
  write: (input: {
    attempt: DurableLearningAttempt;
    request: DurableLearningWriteRequest;
    decision: DurableLearningRouteDecision;
  }) => Promise<DurableLearningAuthorityWriteResult>;
  rollback: (input: {
    attempt: DurableLearningAttempt;
    targetAttempt: DurableLearningAttempt;
    targetReceipt: DurableLearningReceipt;
    rollbackToken: string;
    reason: string;
  }) => Promise<DurableLearningAuthorityRollbackResult>;
};

export type DurableLearningRouterPorts = {
  ledger: DurableLearningAttemptLedger;
  authorities: Partial<Record<DurableLearningResolvedSurface, DurableLearningAuthorityAdapter>>;
  now?: () => Date;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function durableLearningInputHash(
  request: DurableLearningRequestType,
  context: DurableLearningAuthorityContext,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize({ request, context })), "utf8")
    .digest("hex");
}

function decision(input: {
  disposition: DurableLearningRouteDecision["disposition"];
  code: DurableLearningDecisionCode;
  destination?: DurableLearningResolvedSurface | null;
  scope?: DurableLearningResolvedScope | null;
  authority?: DurableLearningResolvedAuthority | null;
  policySnapshotId?: string | null;
  reasons: string[];
  clarificationFields?: Array<"requestedScope" | "requestedAuthority" | "targetSurface">;
}): DurableLearningRouteDecision {
  return DurableLearningRouteDecision.parse({
    disposition: input.disposition,
    code: input.code,
    destination: input.destination ?? null,
    scope: input.scope ?? null,
    authority: input.authority ?? null,
    policySnapshotId: input.policySnapshotId ?? null,
    reasons: input.reasons,
    clarificationFields: input.clarificationFields ?? [],
  });
}

function scopeAuthorized(
  scope: DurableLearningResolvedScope,
  context: DurableLearningAuthorityContext,
): boolean {
  switch (scope.kind) {
    case "organization":
      return context.grants.organization;
    case "workspace":
      return context.grants.workspace;
    case "user":
      return (
        context.grants.selfUser &&
        context.initiatingHumanSubjectId !== null &&
        scope.subjectId === context.initiatingHumanSubjectId
      );
    case "role":
      return context.grants.roleKeys.includes(scope.roleKey);
    case "session":
      return context.grants.sessionIds.includes(scope.sessionId);
    case "ephemeral":
      return context.grants.ephemeralSessionIds.includes(scope.sessionId);
  }
}

function surfaceAvailable(
  surface: DurableLearningResolvedSurface,
  context: DurableLearningAuthorityContext,
): boolean {
  switch (surface) {
    case "memory":
      return context.availableSurfaces.memory;
    case "preference_registry":
      return context.availableSurfaces.preferenceRegistry;
    case "instruction_policy":
      return context.availableSurfaces.instructionPolicy;
    case "company_profile":
      return context.availableSurfaces.companyProfile;
    case "documents_evidence":
      return context.availableSurfaces.documentsEvidence;
  }
}

function activeAuthority(
  request: DurableLearningWriteRequest,
  context: DurableLearningAuthorityContext,
): DurableLearningRouteDecision | "active" | "proposal" | "evidence_only" {
  if (request.targetSurface === "documents_evidence") {
    if (request.requestedAuthority !== "evidence_only") {
      return decision({
        disposition: "rejected",
        code: "SUBJECT_SURFACE_MISMATCH",
        destination: "documents_evidence",
        scope: request.requestedScope as DurableLearningResolvedScope,
        reasons: ["Documents and connector content are evidence, never prompt authority."],
      });
    }
    return "evidence_only";
  }

  if (request.requestedAuthority === "evidence_only") {
    return decision({
      disposition: "rejected",
      code: "SUBJECT_SURFACE_MISMATCH",
      destination: request.targetSurface as DurableLearningResolvedSurface,
      scope: request.requestedScope as DurableLearningResolvedScope,
      reasons: ["Evidence-only writes must use the Documents/RAG evidence surface."],
    });
  }

  if (request.origin === "autonomous_learning") {
    if (context.learningPolicy === null) {
      return decision({
        disposition: "rejected",
        code: "LEARNING_POLICY_REQUIRED",
        destination: request.targetSurface as DurableLearningResolvedSurface,
        scope: request.requestedScope as DurableLearningResolvedScope,
        reasons: ["Autonomous learning requires an immutable resolved learning-policy snapshot."],
      });
    }
    if (context.learningPolicy.mode === "off") {
      return decision({
        disposition: "rejected",
        code: "LEARNING_POLICY_OFF",
        destination: request.targetSurface as DurableLearningResolvedSurface,
        scope: request.requestedScope as DurableLearningResolvedScope,
        policySnapshotId: context.learningPolicy.snapshotId,
        reasons: ["The resolved learning policy disables autonomous durable writes."],
      });
    }
    if (request.requestedAuthority === "proposal" || context.learningPolicy.mode === "suggest") {
      return "proposal";
    }
  }

  if (request.requestedAuthority === "proposal") return "proposal";
  if (request.requestedAuthority === "active") {
    if (request.origin !== "legacy_memory_save" && !context.grants.activate) {
      return decision({
        disposition: "rejected",
        code: "ACTIVATION_NOT_AUTHORIZED",
        destination: request.targetSurface as DurableLearningResolvedSurface,
        scope: request.requestedScope as DurableLearningResolvedScope,
        policySnapshotId: context.learningPolicy?.snapshotId ?? null,
        reasons: ["The frozen authority context does not permit activation."],
      });
    }
    return "active";
  }
  return "proposal";
}

/**
 * Pure routing authority. It classifies no natural language and resolves no
 * policy. Callers must provide the requested surface/scope plus the immutable
 * authority and learning-policy facts produced by their owning components.
 */
export function planDurableLearningWrite(
  rawRequest: DurableLearningWriteRequest,
  rawContext: DurableLearningAuthorityContext,
): DurableLearningRouteDecision {
  const request = DurableLearningRequest.parse(rawRequest) as DurableLearningWriteRequest;
  const context = DurableLearningAuthorityContext.parse(rawContext);

  const clarificationFields: Array<"requestedScope" | "requestedAuthority" | "targetSurface"> = [];
  if (request.requestedScope.kind === "unspecified") clarificationFields.push("requestedScope");
  if (request.requestedAuthority === "unspecified") clarificationFields.push("requestedAuthority");
  if (request.targetSurface === "unspecified") clarificationFields.push("targetSurface");
  if (clarificationFields.length > 0) {
    const code =
      clarificationFields[0] === "requestedScope"
        ? "SCOPE_REQUIRED"
        : clarificationFields[0] === "requestedAuthority"
          ? "AUTHORITY_REQUIRED"
          : "SURFACE_REQUIRED";
    return decision({
      disposition: "clarification_required",
      code,
      reasons: ["The router does not infer ambiguous scope, authority, or destination."],
      clarificationFields,
    });
  }

  const surface = request.targetSurface as DurableLearningResolvedSurface;
  const scope = request.requestedScope as DurableLearningResolvedScope;
  const legacyMemorySubject =
    request.origin === "legacy_memory_save" &&
    surface === "memory" &&
    (PREFERENCE_SUBJECTS.has(request.subject.kind) || MEMORY_SUBJECTS.has(request.subject.kind));
  if (!SUBJECTS_BY_SURFACE[surface].has(request.subject.kind) && !legacyMemorySubject) {
    return decision({
      disposition: "rejected",
      code: "SUBJECT_SURFACE_MISMATCH",
      destination: surface,
      scope,
      reasons: [`Subject kind ${request.subject.kind} cannot be written to ${surface}.`],
    });
  }
  if (!ALLOWED_SCOPES[surface].has(scope.kind)) {
    return decision({
      disposition: "rejected",
      code: "SCOPE_NOT_SUPPORTED_BY_SURFACE",
      destination: surface,
      scope,
      reasons: [`Surface ${surface} does not support ${scope.kind} scope.`],
    });
  }
  if (context.initiatingHumanSubjectId === null && request.origin !== "migration") {
    return decision({
      disposition: "rejected",
      code: "INITIATING_HUMAN_REQUIRED",
      destination: surface,
      scope,
      reasons: ["Durable learning cannot infer human authority from an agent or service actor."],
    });
  }
  if (!scopeAuthorized(scope, context)) {
    return decision({
      disposition: "rejected",
      code: "SCOPE_NOT_AUTHORIZED",
      destination: surface,
      scope,
      reasons: ["The exact frozen authority context does not grant the requested scope."],
    });
  }
  if (request.evidence.some((item) => item.eligibility !== "eligible")) {
    return decision({
      disposition: "rejected",
      code: "EVIDENCE_INELIGIBLE",
      destination: surface,
      scope,
      reasons: ["Every referenced evidence item must remain currently eligible."],
    });
  }
  if (!surfaceAvailable(surface, context)) {
    return decision({
      disposition: "rejected",
      code: "SURFACE_NOT_AVAILABLE",
      destination: surface,
      scope,
      reasons: [`The canonical ${surface} authority is not available in this deployment.`],
    });
  }
  if (
    request.origin === "legacy_memory_save" &&
    (surface !== "memory" ||
      scope.kind !== "workspace" ||
      request.requestedAuthority !== "active" ||
      request.subject.legacyMemory === null)
  ) {
    return decision({
      disposition: "rejected",
      code: "LEGACY_MEMORY_SAVE_CONTRACT_VIOLATION",
      destination: surface,
      scope,
      reasons: ["Legacy memory_save is preserved only as an active workspace Memory write."],
    });
  }
  if (request.origin !== "legacy_memory_save" && request.subject.legacyMemory !== null) {
    return decision({
      disposition: "rejected",
      code: "LEGACY_MEMORY_SAVE_CONTRACT_VIOLATION",
      destination: surface,
      scope,
      reasons: [
        "Legacy Memory kind and metadata are accepted only from memory_save compatibility.",
      ],
    });
  }
  if (
    surface === "preference_registry" &&
    (request.subject.stableKey === null ||
      request.subject.title === null ||
      request.subject.summary === null)
  ) {
    return decision({
      disposition: "rejected",
      code: "SUBJECT_SURFACE_MISMATCH",
      destination: surface,
      scope,
      reasons: ["Preference writes require a stable key, title, and bounded summary."],
    });
  }
  if (surface === "instruction_policy" && scope.kind === "role") {
    if (request.subject.roleKey === null || request.subject.roleKey !== scope.roleKey) {
      return decision({
        disposition: "rejected",
        code: "SUBJECT_SURFACE_MISMATCH",
        destination: surface,
        scope,
        reasons: ["Role-policy subject and scope keys must match exactly."],
      });
    }
  }

  const authority = activeAuthority(request, context);
  if (typeof authority !== "string") return authority;
  return decision({
    disposition: "route",
    code: "ROUTED",
    destination: surface,
    scope,
    authority,
    policySnapshotId: context.learningPolicy?.snapshotId ?? null,
    reasons: [
      `Routed exactly once to ${surface}.`,
      ...(legacyMemorySubject && PREFERENCE_SUBJECTS.has(request.subject.kind)
        ? [
            "Legacy preference/procedural Memory remains effective until a separate canonical promotion supersedes it.",
          ]
        : []),
      authority === request.requestedAuthority
        ? `Requested ${authority} authority was preserved.`
        : `Requested ${request.requestedAuthority} authority was reduced to ${authority}.`,
    ],
  });
}

function buildAttempt(
  request: DurableLearningRequestType,
  context: DurableLearningAuthorityContext,
  now: Date,
): DurableLearningAttempt {
  return {
    id: request.attemptId,
    contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
    accountId: context.accountId,
    workspaceId: context.workspaceId,
    inputHash: durableLearningInputHash(request, context),
    request,
    actor: context.actor,
    initiatingHumanSubjectId: context.initiatingHumanSubjectId,
    sessionId: context.sessionId,
    createdAt: now.toISOString(),
  };
}

async function complete(
  ports: DurableLearningRouterPorts,
  attempt: DurableLearningAttempt,
  receipt: DurableLearningReceipt,
  claimId: string,
): Promise<DurableLearningRouterResponse> {
  return {
    receipt: await ports.ledger.completeAttempt(attempt, receipt, claimId),
    idempotency: "created",
  };
}

const DURABLE_LEARNING_CLAIM_HEARTBEAT_MS = 30_000;

async function withClaimHeartbeat<T>(
  ports: DurableLearningRouterPorts,
  attempt: DurableLearningAttempt,
  claimId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let stopped = false;
  let heartbeatFailure: unknown = null;
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat
      .then(async () => {
        if (stopped) return;
        if (!(await ports.ledger.renewAttemptClaim(attempt, claimId))) {
          throw new DurableLearningAttemptInProgressError(
            "Durable-learning attempt execution claim was lost",
          );
        }
      })
      .catch((error: unknown) => {
        heartbeatFailure = error;
      });
  }, DURABLE_LEARNING_CLAIM_HEARTBEAT_MS);
  timer.unref?.();

  try {
    const result = await operation();
    stopped = true;
    clearInterval(timer);
    await heartbeat;
    if (heartbeatFailure) throw heartbeatFailure;
    return result;
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}

export async function routeDurableLearning(
  rawRequest: DurableLearningRequestType,
  rawContext: DurableLearningAuthorityContext,
  ports: DurableLearningRouterPorts,
): Promise<DurableLearningRouterResponse> {
  const request = DurableLearningRequest.parse(rawRequest);
  const context = DurableLearningAuthorityContext.parse(rawContext);
  const now = ports.now?.() ?? new Date();
  const candidateAttempt = buildAttempt(request, context, now);
  const reservation = await ports.ledger.reserveAttempt(candidateAttempt);
  if (reservation.attempt.inputHash !== candidateAttempt.inputHash) {
    throw new DurableLearningAttemptConflictError(
      "Durable-learning attempt id was reused with different immutable input",
    );
  }
  if (reservation.receipt !== null) {
    return { receipt: reservation.receipt, idempotency: "replayed" };
  }
  if (reservation.claimId === null) {
    throw new DurableLearningAttemptInProgressError(
      "Durable-learning attempt is already executing; retry the same attempt id",
    );
  }
  const attempt = reservation.attempt;
  const claimId = reservation.claimId;
  const receiptCreatedAt = attempt.createdAt;

  if (request.operation === "rollback") {
    const target = await ports.ledger.getCompletedAttempt(
      context.accountId,
      context.workspaceId,
      request.targetAttemptId,
    );
    if (target === null) {
      return await complete(
        ports,
        attempt,
        {
          contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
          attemptId: attempt.id,
          inputHash: attempt.inputHash,
          outcome: "rejected",
          decision: decision({
            disposition: "rejected",
            code: "ROLLBACK_TARGET_NOT_FOUND",
            reasons: ["The target attempt is not visible in this account and workspace."],
          }),
          resource: null,
          effectiveBoundary: "not_applicable",
          rollback: { supported: false, targetAttemptId: request.targetAttemptId, token: null },
          createdAt: receiptCreatedAt,
        },
        claimId,
      );
    }
    const destination = target.receipt.decision.destination;
    const rollbackToken = target.receipt.rollback.token;
    const adapter = destination ? ports.authorities[destination] : undefined;
    if (!target.receipt.rollback.supported || rollbackToken === null || !adapter) {
      return await complete(
        ports,
        attempt,
        {
          contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
          attemptId: attempt.id,
          inputHash: attempt.inputHash,
          outcome: "rejected",
          decision: decision({
            disposition: "rejected",
            code: "ROLLBACK_NOT_SUPPORTED",
            destination,
            reasons: ["The target receipt does not expose an authorized rollback operation."],
          }),
          resource: target.receipt.resource,
          effectiveBoundary: "not_applicable",
          rollback: { supported: false, targetAttemptId: request.targetAttemptId, token: null },
          createdAt: receiptCreatedAt,
        },
        claimId,
      );
    }
    const result = await withClaimHeartbeat(
      ports,
      attempt,
      claimId,
      async () =>
        await adapter.rollback({
          attempt,
          targetAttempt: target.attempt,
          targetReceipt: target.receipt,
          rollbackToken,
          reason: request.reason,
        }),
    );
    return await complete(
      ports,
      attempt,
      {
        contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
        attemptId: attempt.id,
        inputHash: attempt.inputHash,
        outcome: "rolled_back",
        decision: decision({
          disposition: "route",
          code: "ROUTED",
          destination,
          reasons: [`Rollback routed to the original ${destination} authority.`],
        }),
        resource: result.resource,
        effectiveBoundary: result.effectiveBoundary,
        rollback: { supported: false, targetAttemptId: request.targetAttemptId, token: null },
        createdAt: receiptCreatedAt,
      },
      claimId,
    );
  }

  const routeDecision = planDurableLearningWrite(request, context);
  if (routeDecision.disposition !== "route") {
    return await complete(
      ports,
      attempt,
      {
        contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
        attemptId: attempt.id,
        inputHash: attempt.inputHash,
        outcome:
          routeDecision.disposition === "clarification_required"
            ? "clarification_required"
            : "rejected",
        decision: routeDecision,
        resource: null,
        effectiveBoundary: "not_applicable",
        rollback: { supported: false, targetAttemptId: null, token: null },
        createdAt: receiptCreatedAt,
      },
      claimId,
    );
  }

  const destination = routeDecision.destination!;
  const adapter = ports.authorities[destination];
  if (!adapter) {
    return await complete(
      ports,
      attempt,
      {
        contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
        attemptId: attempt.id,
        inputHash: attempt.inputHash,
        outcome: "rejected",
        decision: decision({
          disposition: "rejected",
          code: "SURFACE_NOT_AVAILABLE",
          destination,
          scope: routeDecision.scope as DurableLearningResolvedScope,
          authority: routeDecision.authority,
          policySnapshotId: routeDecision.policySnapshotId,
          reasons: [`No canonical ${destination} authority adapter is installed.`],
        }),
        resource: null,
        effectiveBoundary: "not_applicable",
        rollback: { supported: false, targetAttemptId: null, token: null },
        createdAt: receiptCreatedAt,
      },
      claimId,
    );
  }

  let result: DurableLearningAuthorityWriteResult;
  try {
    result = await withClaimHeartbeat(
      ports,
      attempt,
      claimId,
      async () => await adapter.write({ attempt, request, decision: routeDecision }),
    );
  } catch {
    return await complete(
      ports,
      attempt,
      {
        contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
        attemptId: attempt.id,
        inputHash: attempt.inputHash,
        outcome: "failed",
        decision: decision({
          disposition: "rejected",
          code: "AUTHORITY_WRITE_FAILED",
          destination,
          scope: routeDecision.scope as DurableLearningResolvedScope,
          authority: routeDecision.authority,
          policySnapshotId: routeDecision.policySnapshotId,
          reasons: ["The selected canonical authority did not complete the write."],
        }),
        resource: null,
        effectiveBoundary: "not_applicable",
        rollback: { supported: false, targetAttemptId: null, token: null },
        createdAt: receiptCreatedAt,
      },
      claimId,
    );
  }
  return await complete(
    ports,
    attempt,
    {
      contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
      attemptId: attempt.id,
      inputHash: attempt.inputHash,
      outcome: result.outcome,
      decision: routeDecision,
      resource: result.resource,
      effectiveBoundary: result.effectiveBoundary,
      rollback: result.rollback,
      createdAt: receiptCreatedAt,
    },
    claimId,
  );
}
