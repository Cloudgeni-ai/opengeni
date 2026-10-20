import { sql } from "drizzle-orm";
import {
  rawRows,
  setSubjectRlsContext,
  withSessionActivityRlsContext,
  type Database,
} from "./database";

// ---- the per-session active-sandbox pointer (epoch-fenced swap) -----------
export type ActiveSandboxPointer = {
  activeSandboxId: string | null;
  activeEpoch: number;
  // Effective absolute Connected Machine root. Null/relative values can exist on
  // legacy rows and are resolved against the current persisted Hello root.
  workingDir: string | null;
};

/**
 * Why a swap did not happen. Only `epoch_changed` is a lost race; the rest are
 * decisions about the target or the chat that a retry alone will not change.
 */
export type ActiveSandboxSwapRefusal =
  | "epoch_changed"
  | "chat_unavailable"
  | "not_permitted"
  | "target_unavailable";

// THE SWAP. Repoint a session at `targetSandboxId` (NULL == back to the group
// sandbox) and BUMP active_epoch under a fence: the write is gated on the
// session's current active_epoch == expectedEpoch, so a concurrent double-swap
// (two callers both reading epoch N) lets exactly ONE win — the loser sees
// swapped:false and re-reads. The bumped epoch fences any in-flight op cached
// against the old pointer, which then retries against the new active sandbox.
// integer epoch returns a JS number; Number()-coerced defensively (lease lesson).
export async function setActiveSandbox(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    targetSandboxId: string | null;
    expectedEpoch: number;
    subjectId?: string;
    /** Explicit owner click, never implicit create-time or scheduled seeding. */
    consentToCurrentTurn?: boolean;
    personalMachineAttempt?: {
      turnId: string;
      attemptId: string;
      executionGeneration: number;
      initiatingHumanSubjectId: string;
    };
    // The session's working directory to write alongside the pointer. OMITTED
    // (undefined) ⇒ the column is left UNCHANGED (a plain swap/attach never touches
    // it); a string sets it; null clears it back to the default. Per-session
    // working dir is seeded create-time through this CAS, not the row INSERT.
    workingDir?: string | null;
  },
): Promise<{
  swapped: boolean;
  pointer: ActiveSandboxPointer | null;
  refusal?: ActiveSandboxSwapRefusal;
}> {
  return await withSessionActivityRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      let personalEnrollmentId: string | null = null;
      // Take the session lock before machine locks, matching attempt claim.
      // A lost CAS must not leave behind consent for a move that did not happen.
      const [session] = await scopedDb.execute<{
        active_epoch: number;
        active_turn_id: string | null;
      }>(sql`
        select active_epoch, active_turn_id from sessions
        where workspace_id = ${input.workspaceId} and id = ${input.sessionId}
        for no key update
      `);
      if (!session) return { swapped: false, pointer: null, refusal: "chat_unavailable" };
      if (Number(session.active_epoch) !== input.expectedEpoch) {
        return { swapped: false, pointer: null, refusal: "epoch_changed" };
      }
      if (input.targetSandboxId !== null) {
        if (input.subjectId) {
          await setSubjectRlsContext(scopedDb, input.subjectId);
          if (input.personalMachineAttempt) {
            await scopedDb.execute(sql`select set_config(
              'opengeni.initiating_human_subject_id',
              ${input.personalMachineAttempt.initiatingHumanSubjectId}, true
            )`);
          }
          const [authorization] = await rawRows<{ authorized: boolean }>(
            scopedDb,
            sql`select authorize_scoped_sandbox_attach(
              ${input.accountId}::uuid, ${input.workspaceId}::uuid,
              ${input.targetSandboxId}::uuid
            ) as authorized`,
          );
          if (authorization?.authorized !== true) {
            return { swapped: false, pointer: null, refusal: "not_permitted" };
          }
          const [target] = await rawRows<{
            value: { scope?: string; enrollmentId?: string | null } | null;
          }>(
            scopedDb,
            sql`select get_scoped_sandbox(
              ${input.accountId}::uuid, ${input.workspaceId}::uuid,
              ${input.targetSandboxId}::uuid
            ) as value`,
          );
          if (!target?.value) {
            return { swapped: false, pointer: null, refusal: "target_unavailable" };
          }
          if (target.value.scope === "user") {
            if (!target.value.enrollmentId) {
              return { swapped: false, pointer: null, refusal: "target_unavailable" };
            }
            personalEnrollmentId = target.value.enrollmentId;
            if (!input.personalMachineAttempt && !input.consentToCurrentTurn) {
              const [recovering] = await scopedDb.execute<{ present: boolean }>(sql`
                select exists(select 1 from session_turns
                  where workspace_id = ${input.workspaceId} and session_id = ${input.sessionId}
                    and status = 'recovering') as present
              `);
              if (session.active_turn_id || recovering?.present) {
                return { swapped: false, pointer: null, refusal: "not_permitted" };
              }
            }
            if (input.personalMachineAttempt) {
              const [admission] = await rawRows<{ authorized: boolean }>(
                scopedDb,
                sql`select authorize_session_attempt_personal_machine(
                  ${input.accountId}::uuid, ${input.workspaceId}::uuid,
                  ${input.sessionId}::uuid, ${input.personalMachineAttempt.turnId}::uuid,
                  ${input.personalMachineAttempt.attemptId}::uuid,
                  ${input.personalMachineAttempt.executionGeneration}::integer,
                  ${personalEnrollmentId}::uuid
                ) as authorized`,
              );
              if (admission?.authorized !== true) {
                return { swapped: false, pointer: null, refusal: "not_permitted" };
              }
            }
          }
        } else {
          const [target] = await scopedDb.execute<{
            kind: string;
            enrollment_id: string | null;
          }>(sql`
          select kind, enrollment_id
          from sandboxes
          where workspace_id = ${input.workspaceId} and id = ${input.targetSandboxId}
          for share
        `);
          if (!target) {
            return { swapped: false, pointer: null, refusal: "target_unavailable" };
          }
          if (target.kind === "selfhosted") {
            // SHARE conflicts with removeEnrollment's UPDATE lock. If removal
            // wins first, this read observes revoked; if attach wins first,
            // removal observes the committed pointer and blocks safely.
            if (!target.enrollment_id) {
              return { swapped: false, pointer: null, refusal: "target_unavailable" };
            }
            const [enrollment] = await scopedDb.execute<{ status: string }>(sql`
            select status
            from enrollments
            where workspace_id = ${input.workspaceId} and id = ${target.enrollment_id}
            for share
          `);
            if (!enrollment || enrollment.status !== "active") {
              return { swapped: false, pointer: null, refusal: "target_unavailable" };
            }
          }
        }
      }
      const rows = await scopedDb.execute<{
        active_sandbox_id: string | null;
        active_epoch: number | string;
        working_dir: string | null;
      }>(sql`
      update sessions set
        active_sandbox_id = ${input.targetSandboxId},
        active_epoch      = active_epoch + 1,
        working_dir       = ${input.workingDir === undefined ? sql`working_dir` : input.workingDir},
        updated_at        = now()
      where workspace_id = ${input.workspaceId} and id = ${input.sessionId}
        and active_epoch = ${input.expectedEpoch}
      returning active_sandbox_id, active_epoch, working_dir
    `);
      const row = rows[0];
      if (!row) {
        return { swapped: false, pointer: null, refusal: "epoch_changed" };
      }
      if (personalEnrollmentId && input.consentToCurrentTurn && !input.personalMachineAttempt) {
        await scopedDb.execute(sql`select consent_session_turn_personal_machine(
          ${input.accountId}::uuid, ${input.workspaceId}::uuid,
          ${input.sessionId}::uuid, ${personalEnrollmentId}::uuid
        )`);
      }
      if (personalEnrollmentId && input.personalMachineAttempt) {
        const [preUse] = await rawRows<{ authorized: boolean }>(
          scopedDb,
          sql`select assert_session_attempt_personal_machine(
            ${input.accountId}::uuid, ${input.workspaceId}::uuid,
            ${input.sessionId}::uuid, ${input.personalMachineAttempt.turnId}::uuid,
            ${input.personalMachineAttempt.attemptId}::uuid,
            ${input.personalMachineAttempt.executionGeneration}::integer,
            ${personalEnrollmentId}::uuid, true
          ) as authorized`,
        );
        if (preUse?.authorized !== true) {
          throw new Error("personal Connected Machine authority was not live after attach");
        }
      }
      return {
        swapped: true,
        pointer: {
          activeSandboxId: row.active_sandbox_id ?? null,
          activeEpoch: Number(row.active_epoch),
          workingDir: row.working_dir ?? null,
        },
      };
    },
  );
}
