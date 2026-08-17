import type { ScheduledTask as ScheduledTaskValue } from "@opengeni/contracts";
import { deleteScheduledTaskLifecycle, type ApiRouteDeps } from "@opengeni/core";
import type { TemporalScheduleCleanupClaim } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import * as z4 from "zod/v4";
import {
  cleanupAtlassianScheduleAuthorization,
  preflightAtlassianScheduleAuthorization,
  revokeAtlassianScheduleAuthorization,
} from "./integrations/atlassian";
import {
  cleanupKnowledgeSourceScheduleAuthorization,
  preflightKnowledgeSourceScheduleAuthorization,
  revokeKnowledgeSourceScheduleAuthorization,
} from "./integrations/google-drive";
import { processTemporalScheduleCleanupClaims } from "./temporal-schedule-cleanup";

const ScheduledConnectorCleanupV1 = z4.object({
  version: z4.literal(1),
  taskId: z4.string().uuid(),
  accountId: z4.string().uuid(),
  workspaceId: z4.string().uuid(),
  connectorKind: z4.enum(["google_drive", "atlassian"]),
  connectionId: z4.string().uuid(),
  connectionVersion: z4.number().int().positive(),
  sourceId: z4.string().uuid(),
  sourceLifecycleGeneration: z4.number().int().positive(),
  sourceConfigGeneration: z4.number().int().positive(),
  externalSourceId: z4.string().min(1).max(512),
  subjectId: z4.string().min(1).max(1024),
});

async function preflightConnectorAuthorization(
  deps: ApiRouteDeps,
  task: ScheduledTaskValue,
  subjectId: string,
): Promise<void> {
  if (task.action.kind !== "knowledge_source_sync") return;
  if (task.metadata.connectorKind === "atlassian") {
    await preflightAtlassianScheduleAuthorization(deps, { task, subjectId });
    return;
  }
  if (task.metadata.connectorKind === "google_drive") {
    await preflightKnowledgeSourceScheduleAuthorization(deps, { task, subjectId });
    return;
  }
  throw new HTTPException(409, {
    message: "knowledge source schedule connector cannot be durably disabled",
  });
}

async function revokeConnectorAuthorization(
  deps: ApiRouteDeps,
  task: ScheduledTaskValue,
  subjectId: string,
): Promise<void> {
  if (task.action.kind !== "knowledge_source_sync") return;
  if (task.metadata.connectorKind === "atlassian") {
    await revokeAtlassianScheduleAuthorization(deps, { task, subjectId });
    return;
  }
  if (task.metadata.connectorKind === "google_drive") {
    await revokeKnowledgeSourceScheduleAuthorization(deps, { task, subjectId });
    return;
  }
  throw new HTTPException(409, {
    message: "knowledge source schedule connector cannot be durably disabled",
  });
}

/** Execute one exact connector obligation frozen into the tombstone outbox row. */
export async function cleanupScheduledTaskConnectorAuthorization(
  deps: ApiRouteDeps,
  claim: TemporalScheduleCleanupClaim,
): Promise<void> {
  if (!claim.connectorCleanupSnapshot) return;
  const cleanup = ScheduledConnectorCleanupV1.parse(claim.connectorCleanupSnapshot);
  const subjectId = claim.connectorCleanupSubjectId;
  if (
    !subjectId ||
    claim.scheduledTaskId !== cleanup.taskId ||
    claim.accountId !== cleanup.accountId ||
    claim.workspaceId !== cleanup.workspaceId ||
    cleanup.subjectId !== subjectId
  ) {
    throw new Error("scheduled connector cleanup receipt is contradictory");
  }
  if (cleanup.connectorKind === "atlassian") {
    await cleanupAtlassianScheduleAuthorization(deps, cleanup);
    return;
  }
  if (cleanup.connectorKind === "google_drive") {
    await cleanupKnowledgeSourceScheduleAuthorization(deps, cleanup);
    return;
  }
  throw new Error("scheduled connector cleanup receipt has an unsupported connector");
}

/** Shared HTTP/MCP domain operation: authorize, tombstone, persist, then accelerate cleanup. */
export async function deleteScheduledTaskWithDurableCleanup(
  deps: ApiRouteDeps,
  input: { workspaceId: string; taskId: string; subjectId: string },
): Promise<{ task: ScheduledTaskValue; changed: boolean }> {
  const result = await deleteScheduledTaskLifecycle({
    db: deps.db,
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    subjectId: input.subjectId,
    preflightConnectorAuthorization: async (task) =>
      await preflightConnectorAuthorization(deps, task, input.subjectId),
    cleanupConnectorAuthorization: async (db, task) =>
      await revokeConnectorAuthorization({ ...deps, db }, task, input.subjectId),
    processCleanupClaims: async (claims) => {
      await processTemporalScheduleCleanupClaims(
        {
          db: deps.db,
          cleanupConnectorAuthorization: async (claim) =>
            await cleanupScheduledTaskConnectorAuthorization(deps, claim),
          deleteSchedule: async (temporalScheduleId) =>
            await deps.workflowClient.deleteScheduledTaskSchedule({ temporalScheduleId }),
        },
        claims,
      );
    },
  });
  return { task: result.task, changed: result.changed };
}
