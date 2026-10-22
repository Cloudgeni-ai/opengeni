import { sql } from "drizzle-orm";

import type { Database } from "./database";
import {
  rawRows,
  setSubjectRlsContext,
  withRlsContext,
  withSessionActivityRlsContext,
} from "./database";
import * as schema from "./schema";

/** Who can use a Connected Machine: everyone in its workspace, or one person. */
export type MachineAudience = "workspace" | "only_me";

/**
 * What the change does to one thing on the machine. move_off: the chat leaves
 * the machine (its files stay). keep: the owner's chat stays and keeps its
 * audience. make_only_me / pause: a schedule that runs on the machine.
 * remove_first: the same computer is connected a second time; that copy has to
 * be removed before the switch.
 */
export type MachineAudienceAction = "move_off" | "keep" | "make_only_me" | "pause" | "remove_first";

export type MachineAudienceItem = {
  kind: "chat" | "schedule" | "duplicate_connection";
  action: MachineAudienceAction;
  sessionId?: string;
  scheduledTaskId?: string;
  enrollmentId?: string;
  workspaceId?: string;
  relation?: "other_member" | "owner_shared" | "owner_private" | "other_workspace";
  visibility?: "user_private" | "workspace_shared";
  title?: string | null;
  name?: string | null;
  ownerSubjectId?: string | null;
  /** A running turn in this chat stops for good. */
  stopsTurn?: boolean;
  /** Commands the agent still runs there that stop. */
  stopsCommands?: number;
};

export type MachineAudienceSummary = {
  /** The owner's chats that keep working with no change. */
  keptChats: number;
  /** The owner's shared chats that stay on the machine and stay shared. */
  keptSharedChats: number;
  movedOffChats: number;
  schedulesMadeOnlyMe: number;
  schedulesPaused: number;
  stoppedTurns: number;
  stoppedCommands: number;
  /** People who get an inbox notice. */
  notifiedPeople: number;
};

export type MachineAudiencePreviewRecord = {
  enrollmentId: string;
  sandboxId: string;
  machineName: string;
  currentAudience: MachineAudience;
  targetAudience: MachineAudience;
  generation: number;
  ownerSubjectId: string;
  summary: MachineAudienceSummary;
  retiredRecordCount: number;
  items: MachineAudienceItem[];
  /** False only when the same computer is connected a second time. */
  ready: boolean;
};

export type MachineAudienceRefusal =
  | "machine_not_found"
  | "organization_machine"
  | "invalid_target"
  | "already_target"
  | "owner_not_member"
  | "owner_lacks_workspace_access"
  | "not_machine_owner";

export type MachineAudienceChangeRecord =
  | {
      outcome: "changed";
      enrollmentId: string;
      sandboxId: string;
      previousAudience: MachineAudience;
      audience: MachineAudience;
      ownerSubjectId: string | null;
      previousGeneration: number;
      generation: number;
      summary: MachineAudienceSummary;
      detachedSessionIds: string[];
      keptSessionIds: string[];
      stoppedAttemptIds: string[];
      pausedScheduleIds: string[];
      onlyMeScheduleIds: string[];
      reauthorizedAttemptIds: string[];
      retiredEnrollmentIds: string[];
    }
  | { outcome: "blocked"; preview: MachineAudiencePreviewRecord }
  | { outcome: "stale"; generation: number }
  | { outcome: "refused"; refusal: MachineAudienceRefusal };

type AudienceRequest = {
  accountId: string;
  /** The machine's home workspace (the route workspace). */
  workspaceId: string;
  /** The authenticated caller. */
  subjectId: string;
  enrollmentId: string;
  target: MachineAudience;
  /** Who will own the machine when the target is Only me. */
  ownerSubjectId: string | null;
  /**
   * Whether the new owner may have Only me schedules. When not, their
   * Workspace schedules on the machine pause instead of becoming Only me.
   */
  schedulesMayBeOnlyMe: boolean;
};

function targetScope(target: MachineAudience): "user" | "workspace" {
  return target === "only_me" ? "user" : "workspace";
}

function previewRecord(value: unknown): MachineAudiencePreviewRecord | MachineAudienceRefusal {
  const record = value as Record<string, unknown>;
  if (typeof record["refusal"] === "string") return record["refusal"] as MachineAudienceRefusal;
  return {
    ...(record as unknown as MachineAudiencePreviewRecord),
    generation: Number(record["generation"]),
  };
}

/**
 * The plan for changing who can use one Connected Machine: everything the one
 * confirmation will do. Reads only; the change recomputes the same plan under
 * the machine lock and applies it.
 */
export async function previewMachineAudienceChange(
  db: Database,
  input: AudienceRequest,
): Promise<MachineAudiencePreviewRecord | MachineAudienceRefusal> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.subjectId);
      const [row] = await rawRows<{ value: unknown }>(
        scopedDb,
        sql`select preview_connected_machine_audience_change(
          ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.enrollmentId}::uuid,
          ${targetScope(input.target)}, ${input.ownerSubjectId},
          ${input.schedulesMayBeOnlyMe}::boolean
        ) as value`,
      );
      return previewRecord(row?.value ?? { refusal: "machine_not_found" });
    },
  );
}

/**
 * Change who can use one Connected Machine in place, in one transaction: move
 * other people's chats off, stop their running turns, pause or narrow the
 * schedules on it, notify the people affected and move the machine's
 * authority. The enrollment, sandbox, credentials and live connection are
 * kept, so the connected agent and the owner's running work carry on.
 */
export async function changeMachineAudience(
  db: Database,
  input: AudienceRequest & { expectedGeneration: number },
): Promise<MachineAudienceChangeRecord> {
  return await withSessionActivityRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.subjectId);
      const [row] = await rawRows<{ value: Record<string, unknown> }>(
        scopedDb,
        sql`select change_connected_machine_audience(
          ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.enrollmentId}::uuid,
          ${input.expectedGeneration}::bigint, ${targetScope(input.target)},
          ${input.ownerSubjectId}, ${input.schedulesMayBeOnlyMe}::boolean
        ) as value`,
      );
      const value = row?.value ?? { outcome: "refused", refusal: "machine_not_found" };
      const outcome = value["outcome"];
      if (outcome === "blocked") {
        const preview = previewRecord(value["preview"]);
        if (typeof preview === "string") return { outcome: "refused", refusal: preview };
        return { outcome, preview };
      }
      if (outcome === "stale") {
        return { outcome, generation: Number(value["generation"]) };
      }
      if (outcome === "refused") {
        return { outcome, refusal: value["refusal"] as MachineAudienceRefusal };
      }
      const changed = {
        ...(value as unknown as Extract<MachineAudienceChangeRecord, { outcome: "changed" }>),
        previousGeneration: Number(value["previousGeneration"]),
        generation: Number(value["generation"]),
      };
      await scopedDb.insert(schema.auditEvents).values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        action: "connected_machine.audience_changed",
        targetType: "enrollment",
        targetId: input.enrollmentId,
        metadata: {
          sandboxId: changed.sandboxId,
          previousAudience: changed.previousAudience,
          audience: changed.audience,
          ownerSubjectId: changed.ownerSubjectId,
          previousGeneration: changed.previousGeneration,
          generation: changed.generation,
          summary: changed.summary,
          detachedSessionIds: changed.detachedSessionIds,
          keptSessionIds: changed.keptSessionIds,
          stoppedAttemptIds: changed.stoppedAttemptIds,
          pausedScheduleIds: changed.pausedScheduleIds,
          onlyMeScheduleIds: changed.onlyMeScheduleIds,
          reauthorizedAttemptIds: changed.reauthorizedAttemptIds,
          retiredEnrollmentIds: changed.retiredEnrollmentIds,
        },
      });
      return changed;
    },
  );
}
