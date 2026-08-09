import type {
  DurableLearningAuthorityAdapter,
  DurableLearningAuthorityWriteResult,
} from "./durable-learning-router";
import { routeDurableLearning } from "./durable-learning-router";
import { durableLearningStableAttemptId } from "./durable-learning-router";
import {
  DURABLE_LEARNING_CONTRACT_VERSION,
  type DurableLearningRouterResponse,
  type KnowledgeMemoryKind,
} from "@opengeni/contracts";
import {
  correctWorkspaceMemory,
  createDurableLearningAttemptLedger,
  getDurableLearningMemoryWriteResult,
  saveWorkspaceMemory,
  type Database,
  type MemoryEmbedder,
  type SaveWorkspaceMemoryResult,
} from "@opengeni/db";

export type WorkspaceMemoryDurableLearningAdapterOptions = {
  db: Database;
  embedder?: MemoryEmbedder;
  onWriteResult?: (result: SaveWorkspaceMemoryResult) => void;
  onWriteError?: (error: unknown) => void;
};

export type LegacyWorkspaceMemoryLearningWriteInput = {
  db: Database;
  embedder?: MemoryEmbedder;
  accountId: string;
  workspaceId: string;
  sessionId: string | null;
  actor: { kind: "human" | "agent"; subjectId: string };
  initiatingHumanSubjectId: string;
  text: string;
  kind: KnowledgeMemoryKind;
  confidence?: number;
  pinned?: boolean;
  replacesId?: string | null;
  metadata?: Record<string, unknown>;
  attemptId?: string;
};

function memoryKindForSubject(kind: string): "semantic" | "episodic" {
  return kind === "history" ? "episodic" : "semantic";
}

function memoryRollbackToken(memoryId: string): string {
  return `memory:${memoryId}`;
}

function memoryIdFromRollbackToken(token: string): string | null {
  const match =
    /^memory:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(
      token,
    );
  return match?.[1] ?? null;
}

/**
 * Concrete adapter for the existing Workspace Memory write gate. Other
 * canonical authorities install their own adapters; this function never calls
 * or falls back to them.
 */
export function createWorkspaceMemoryDurableLearningAdapter(
  options: WorkspaceMemoryDurableLearningAdapterOptions,
): DurableLearningAuthorityAdapter {
  return {
    async write({ attempt, request, decision }): Promise<DurableLearningAuthorityWriteResult> {
      if (
        decision.destination !== "memory" ||
        decision.scope?.kind !== "workspace" ||
        decision.authority !== "active"
      ) {
        throw new Error(
          "The Workspace Memory adapter accepts only active workspace Memory decisions",
        );
      }
      const legacy = request.origin === "legacy_memory_save" ? request.subject.legacyMemory : null;
      let result: SaveWorkspaceMemoryResult;
      try {
        result = await saveWorkspaceMemory(
          options.db,
          {
            accountId: attempt.accountId,
            workspaceId: attempt.workspaceId,
            sessionId: attempt.sessionId,
            text: request.subject.content,
            kind: legacy?.kind ?? memoryKindForSubject(request.subject.kind),
            ...(legacy?.confidence !== null && legacy?.confidence !== undefined
              ? { confidence: legacy.confidence }
              : {}),
            ...(legacy?.pinned !== null && legacy?.pinned !== undefined
              ? { pinned: legacy.pinned }
              : {}),
            ...(request.subject.replacesResourceId
              ? { replacesId: request.subject.replacesResourceId }
              : {}),
            metadata: {
              ...(legacy?.metadata ?? {}),
            },
            durableLearningOperation: {
              attemptId: attempt.id,
              inputHash: attempt.inputHash,
            },
            origin: attempt.actor.kind === "human" ? "human" : "agent",
          },
          options.embedder,
        );
      } catch (error) {
        options.onWriteError?.(error);
        throw error;
      }
      options.onWriteResult?.(result);
      const ownedByAttempt =
        result.memory.metadata.durableLearningAttemptId === attempt.id &&
        result.memory.metadata.durableLearningInputHash === attempt.inputHash;
      const changed =
        ownedByAttempt || !result.deduped || result.updated || result.superseded !== null;
      const rollbackSupported = ownedByAttempt && !result.updated && result.superseded === null;
      return {
        outcome: changed ? "applied" : "noop",
        resource: {
          surface: "memory",
          id: result.memory.id,
          version: result.memory.updatedAt,
          status: result.memory.status,
        },
        effectiveBoundary: "next_accepted_attempt",
        rollback: {
          supported: rollbackSupported,
          targetAttemptId: null,
          token: rollbackSupported ? memoryRollbackToken(result.memory.id) : null,
        },
      };
    },

    async rollback({ attempt, rollbackToken, reason }) {
      const memoryId = memoryIdFromRollbackToken(rollbackToken);
      if (!memoryId) throw new Error("The Memory rollback token is invalid");
      const result = await correctWorkspaceMemory(options.db, {
        accountId: attempt.accountId,
        workspaceId: attempt.workspaceId,
        id: memoryId,
        reason,
        sessionId: attempt.sessionId,
        durableLearningOperation: {
          attemptId: attempt.id,
          inputHash: attempt.inputHash,
        },
      });
      return {
        resource: {
          surface: "memory",
          id: result.memory.id,
          version: result.memory.updatedAt,
          status: result.memory.status,
        },
        effectiveBoundary: "next_accepted_attempt",
      };
    },
  };
}

function subjectKindForLegacyMemory(
  kind: KnowledgeMemoryKind,
): "fact" | "decision" | "preference" | "procedure" | "history" {
  switch (kind) {
    case "preference":
      return "preference";
    case "procedural":
      return "procedure";
    case "episodic":
      return "history";
    case "semantic":
      return "fact";
    case "decision":
      return "decision";
  }
}

/**
 * Compatibility integration for every current active Workspace Memory writer.
 * New explicit/autonomous callers should use the generic router contract rather
 * than this legacy-only convenience function.
 */
export async function routeLegacyWorkspaceMemoryWrite(
  input: LegacyWorkspaceMemoryLearningWriteInput,
): Promise<{
  router: DurableLearningRouterResponse;
  memory: SaveWorkspaceMemoryResult | null;
}> {
  let memory: SaveWorkspaceMemoryResult | null = null;
  let writeError: unknown = null;
  const attemptId =
    input.attemptId ??
    durableLearningStableAttemptId({
      source: "legacy-workspace-memory",
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      actor: input.actor,
      initiatingHumanSubjectId: input.initiatingHumanSubjectId,
      text: input.text,
      kind: input.kind,
      confidence: input.confidence ?? null,
      pinned: input.pinned ?? null,
      replacesId: input.replacesId ?? null,
      metadata: input.metadata ?? {},
    });
  let router: DurableLearningRouterResponse;
  try {
    router = await routeDurableLearning(
      {
        contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
        operation: "write",
        attemptId,
        origin: "legacy_memory_save",
        requestedAuthority: "active",
        requestedScope: { kind: "workspace" },
        targetSurface: "memory",
        subject: {
          kind: subjectKindForLegacyMemory(input.kind),
          content: input.text,
          stableKey: null,
          title: null,
          summary: null,
          roleKey: null,
          replacesResourceId: input.replacesId ?? null,
          legacyMemory: {
            kind: input.kind,
            confidence: input.confidence ?? null,
            pinned: input.pinned ?? null,
            metadata: input.metadata ?? {},
          },
        },
        evidence: [],
      },
      {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        actor: input.actor,
        initiatingHumanSubjectId: input.initiatingHumanSubjectId,
        sessionId: input.sessionId,
        grants: {
          organization: false,
          workspace: true,
          selfUser: false,
          roleKeys: [],
          sessionIds: input.sessionId ? [input.sessionId] : [],
          ephemeralSessionIds: [],
          activate: true,
        },
        learningPolicy: null,
        availableSurfaces: {
          memory: true,
          preferenceRegistry: false,
          instructionPolicy: false,
          companyProfile: false,
          documentsEvidence: false,
        },
      },
      {
        ledger: createDurableLearningAttemptLedger(input.db),
        authorities: {
          memory: createWorkspaceMemoryDurableLearningAdapter({
            db: input.db,
            ...(input.embedder ? { embedder: input.embedder } : {}),
            onWriteResult: (result) => {
              memory = result;
            },
            onWriteError: (error) => {
              writeError = error;
            },
          }),
        },
      },
    );
  } catch (error) {
    if (writeError !== null) throw writeError;
    throw error;
  }
  if (writeError !== null) throw writeError;
  if (
    memory === null &&
    (router.receipt.outcome === "applied" || router.receipt.outcome === "noop") &&
    router.receipt.resource?.surface === "memory"
  ) {
    memory = await getDurableLearningMemoryWriteResult(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      attemptId: router.receipt.attemptId,
      inputHash: router.receipt.inputHash,
    });
    if (
      memory === null ||
      memory.memory.id !== router.receipt.resource.id ||
      memory.memory.updatedAt !== router.receipt.resource.version ||
      memory.memory.status !== router.receipt.resource.status
    ) {
      throw new Error(
        "Completed durable-learning Memory replay has no matching immutable authority result",
      );
    }
  }
  return { router, memory };
}
