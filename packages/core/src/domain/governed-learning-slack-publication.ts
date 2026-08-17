import type {
  GovernedLearningActivationReceipt,
  GovernedLearningActivationUndoReceipt,
} from "@opengeni/contracts";
import {
  enqueueMemorySlackPublication,
  getCurrentMemorySlackPublicationConfiguration,
  resolveGovernedLearningEvidenceOrigin,
  type Database,
  type EnqueueMemorySlackPublicationResult,
  type GovernedLearningEvidenceOrigin,
} from "@opengeni/db";

/**
 * Narrow post-persistence notification port for governed-learning activation
 * and undo receipts (migration 0269). The evaluator/controller own policy,
 * authority, and the immutable receipts; this adapter only projects bounded,
 * content-free facts into the existing Slack publication outbox. It never
 * reads proposal content, evidence bytes, or destination bodies.
 */
export type GovernedLearningSlackEvent =
  | {
      kind: "activated";
      receipt: GovernedLearningActivationReceipt;
      sessionId: string | null;
      attemptId: string | null;
    }
  | { kind: "undone"; receipt: GovernedLearningActivationUndoReceipt };

export type GovernedLearningSlackPublicationResult =
  | {
      kind: "evidence_origin_unresolved" | "slack_derived_evidence" | "policy_quiet";
      enqueue: null;
    }
  | { kind: "enqueued"; enqueue: EnqueueMemorySlackPublicationResult };

export type GovernedLearningSlackProjection = {
  summary: string;
  outcome: "activated" | "undone";
  destination: "instruction_policy" | "preference";
  sourceKind: "scoped-knowledge-evidence" | "task-note" | null;
  destinationRevisionId: string;
  destinationVersion: number;
  activationReceiptId: string;
  undoReceiptId: string | null;
  occurredAt: string;
};

const DESTINATION_LABEL: Record<"instruction_policy" | "preference", string> = {
  instruction_policy: "workspace instruction policy",
  preference: "workspace preference",
};
const SOURCE_LABEL: Record<"scoped-knowledge-evidence" | "task-note", string> = {
  "scoped-knowledge-evidence": "workspace knowledge evidence",
  "task-note": "a task note",
};

export function governedLearningSlackImportance(
  event: GovernedLearningSlackEvent,
): "major" | "normal" | "minor" {
  if (event.kind === "undone") return "major";
  return event.receipt.destination === "instruction_policy" ? "major" : "normal";
}

export function governedLearningSlackProjection(
  event: GovernedLearningSlackEvent,
): GovernedLearningSlackProjection {
  if (event.kind === "activated") {
    const receipt = event.receipt;
    return {
      summary: `Automatically activated a ${DESTINATION_LABEL[receipt.destination]} learned from ${SOURCE_LABEL[receipt.sourceKind]} (revision ${receipt.destinationNewVersion}). Review or undo it under Learning & autonomy.`,
      outcome: "activated",
      destination: receipt.destination,
      sourceKind: receipt.sourceKind,
      destinationRevisionId: receipt.destinationRevisionId,
      destinationVersion: receipt.destinationNewVersion,
      activationReceiptId: receipt.id,
      undoReceiptId: null,
      occurredAt: receipt.effectiveAt,
    };
  }
  const receipt = event.receipt;
  return {
    summary: `Undid an automatic ${DESTINATION_LABEL[receipt.destination]} activation (revision ${receipt.destinationOldVersion} → ${receipt.destinationNewVersion}).`,
    outcome: "undone",
    destination: receipt.destination,
    sourceKind: null,
    destinationRevisionId: receipt.destinationActivatedRevisionId,
    destinationVersion: receipt.destinationNewVersion,
    activationReceiptId: receipt.activationReceiptId,
    undoReceiptId: receipt.id,
    occurredAt: receipt.effectiveAt,
  };
}

/** Evidence that itself came from a Slack knowledge connector must never republish to Slack. */
export function governedLearningEvidenceIsSlackDerived(
  origin: GovernedLearningEvidenceOrigin,
): boolean {
  return origin.kind === "document" && /slack/iu.test(origin.providerKey ?? "");
}

export async function publishGovernedLearningEventToSlack(
  db: Database,
  event: GovernedLearningSlackEvent,
  options: {
    resolveEvidenceOrigin?: typeof resolveGovernedLearningEvidenceOrigin;
    configuration?: typeof getCurrentMemorySlackPublicationConfiguration;
    enqueue?: typeof enqueueMemorySlackPublication;
  } = {},
): Promise<GovernedLearningSlackPublicationResult> {
  const workspaceId = event.receipt.workspaceId;
  if (event.kind === "activated") {
    // Loop prevention: evidence that came from a Slack knowledge connector
    // must not be republished to Slack. Task-note evidence is always local.
    const origin = await (options.resolveEvidenceOrigin ?? resolveGovernedLearningEvidenceOrigin)(
      db,
      { workspaceId, evidenceId: event.receipt.evidenceId },
    );
    if (!origin) return { kind: "evidence_origin_unresolved", enqueue: null };
    if (governedLearningEvidenceIsSlackDerived(origin)) {
      return { kind: "slack_derived_evidence", enqueue: null };
    }
  }
  const importance = governedLearningSlackImportance(event);
  const configuration = await (
    options.configuration ?? getCurrentMemorySlackPublicationConfiguration
  )(db, workspaceId);
  const deliveryMode = configuration?.autoImportances.includes(importance)
    ? "auto"
    : configuration?.reviewImportances.includes(importance)
      ? "review"
      : null;
  if (!configuration?.enabled || !deliveryMode) return { kind: "policy_quiet", enqueue: null };

  const projection = governedLearningSlackProjection(event);
  const receipt = event.receipt;
  const enqueue = await (options.enqueue ?? enqueueMemorySlackPublication)(db, {
    accountId: receipt.accountId,
    workspaceId,
    sourceType: "durable_learning",
    sourceId: receipt.id,
    sourceVersion: String(projection.destinationVersion),
    sourceIdempotencyKey: `governed-learning:${event.kind}:${receipt.id}`,
    projection: { ...projection },
    importance,
    deliveryMode,
    actor: {
      kind: "service",
      subjectId: receipt.serviceActorSubjectId,
      initiatingHumanSubjectId: receipt.initiatingHumanSubjectId,
      sessionId: event.kind === "activated" ? event.sessionId : null,
      attemptId: event.kind === "activated" ? event.attemptId : null,
    },
  });
  return { kind: "enqueued", enqueue };
}
