import {
  enqueueMemorySlackPublication,
  getCurrentMemorySlackPublicationConfiguration,
  type Database,
  type EnqueueMemorySlackPublicationResult,
} from "@opengeni/db";

/**
 * Narrow post-persistence port for the immutable durable-learning v1 attempt/receipt contract.
 * The router owns validation, authority, routing, and persistence. This adapter
 * consumes only the fields required to create a bounded notification projection.
 */
export type DurableLearningSlackOutcome = {
  attempt: {
    id: string;
    accountId: string;
    workspaceId: string;
    inputHash: string;
    actor: { kind: "human" | "agent" | "service"; subjectId: string };
    initiatingHumanSubjectId: string | null;
    sessionId: string | null;
    request:
      | {
          operation: "write";
          subject: {
            kind: string;
            summary: string | null;
          };
          evidence: Array<{ kind: string }>;
        }
      | {
          operation: "rollback";
          targetAttemptId: string;
        };
  };
  receipt: {
    attemptId: string;
    inputHash: string;
    outcome:
      | "applied"
      | "proposed"
      | "evidence_recorded"
      | "noop"
      | "clarification_required"
      | "rejected"
      | "rolled_back"
      | "failed";
    decision: {
      code: string;
      destination: string | null;
      scope: { kind: string } | null;
      authority: string | null;
    };
    resource: {
      surface: string;
      id: string;
      version: string | null;
      status: string;
    } | null;
    createdAt: string;
  };
};

export type DurableLearningSlackPublicationResult =
  | {
      kind:
        | "contract_mismatch"
        | "not_workspace_scoped"
        | "connector_evidence_untrusted"
        | "summary_required"
        | "policy_quiet";
      enqueue: null;
    }
  | { kind: "enqueued"; enqueue: EnqueueMemorySlackPublicationResult };

export async function publishDurableLearningOutcomeToSlack(
  db: Database,
  outcome: DurableLearningSlackOutcome,
): Promise<DurableLearningSlackPublicationResult> {
  const { attempt, receipt } = outcome;
  if (attempt.id !== receipt.attemptId || attempt.inputHash !== receipt.inputHash) {
    return { kind: "contract_mismatch", enqueue: null };
  }
  if (receipt.decision.scope?.kind !== "workspace") {
    return { kind: "not_workspace_scoped", enqueue: null };
  }
  if (
    attempt.request.operation === "write" &&
    attempt.request.evidence.some((evidence) => evidence.kind === "connector")
  ) {
    // The v1 router contract intentionally does not identify connector providers.
    // Fail closed rather than risk republishing a Slack-derived learning outcome.
    return { kind: "connector_evidence_untrusted", enqueue: null };
  }

  const summary = durableLearningSummary(outcome);
  if (!summary) return { kind: "summary_required", enqueue: null };
  const importance = durableLearningImportance(outcome);
  const configuration = await getCurrentMemorySlackPublicationConfiguration(
    db,
    attempt.workspaceId,
  );
  const deliveryMode = configuration?.autoImportances.includes(importance)
    ? "auto"
    : configuration?.reviewImportances.includes(importance)
      ? "review"
      : null;
  if (!configuration?.enabled || !deliveryMode) {
    return { kind: "policy_quiet", enqueue: null };
  }

  const enqueue = await enqueueMemorySlackPublication(db, {
    accountId: attempt.accountId,
    workspaceId: attempt.workspaceId,
    sourceType: "durable_learning",
    sourceId: receipt.attemptId,
    sourceVersion: receipt.inputHash,
    sourceIdempotencyKey: `durable-learning:${receipt.attemptId}`,
    projection: {
      summary,
      outcome: receipt.outcome,
      decisionCode: receipt.decision.code,
      destination: receipt.decision.destination,
      authority: receipt.decision.authority,
      resource: receipt.resource
        ? {
            surface: receipt.resource.surface,
            id: receipt.resource.id,
            version: receipt.resource.version,
            status: receipt.resource.status,
          }
        : null,
      occurredAt: receipt.createdAt,
    },
    importance,
    deliveryMode,
    actor: {
      kind: attempt.actor.kind,
      subjectId: attempt.actor.subjectId,
      initiatingHumanSubjectId: attempt.initiatingHumanSubjectId,
      sessionId: attempt.sessionId,
      attemptId: attempt.id,
    },
  });
  return { kind: "enqueued", enqueue };
}

export function durableLearningImportance(
  outcome: DurableLearningSlackOutcome,
): "major" | "normal" | "minor" {
  if (outcome.receipt.outcome === "failed" || outcome.receipt.outcome === "rolled_back") {
    return "major";
  }
  if (outcome.receipt.outcome === "noop" || outcome.receipt.outcome === "clarification_required") {
    return "minor";
  }
  if (
    outcome.attempt.request.operation === "write" &&
    ["decision", "workspace_charter", "mandatory_operating_context", "workspace_goal"].includes(
      outcome.attempt.request.subject.kind,
    )
  ) {
    return "major";
  }
  return "normal";
}

function durableLearningSummary(outcome: DurableLearningSlackOutcome): string | null {
  if (outcome.attempt.request.operation === "rollback") {
    const destination = outcome.receipt.decision.destination ?? "governed knowledge";
    return `Rolled back a durable learning change for ${destination}.`;
  }
  const summary = outcome.attempt.request.subject.summary?.replace(/\s+/g, " ").trim();
  return summary ? summary.slice(0, 512) : null;
}
