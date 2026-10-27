import { sql } from "drizzle-orm";
import { SessionMachineAccess } from "@opengeni/contracts";
import { rawRows, withWorkspaceSubjectRls, type Database } from "./database";
import { machineOwnerLookupGranted } from "./machine-owner-wait";

/** Explanation only; never adds the machine to discovery or authorizes its use. */
export async function getSessionMachineAccess(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string; subjectId: string },
): Promise<SessionMachineAccess | null> {
  return withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`
      select get_session_machine_access(${input.accountId}::uuid, ${input.workspaceId}::uuid,
        ${input.sessionId}::uuid) as result
    `,
    );
    if (!row?.result) return null;
    const access = SessionMachineAccess.parse(row.result);
    // Messages only wait once the runtime can look up the machine's owner
    // (`machine-owner-wait.ts`); until then they still run and are refused, so
    // saying they wait would be wrong.
    if (access.waitingMessages?.length && !(await machineOwnerLookupGranted(tx))) {
      const { waitingMessages: _withheld, ...rest } = access;
      return rest;
    }
    return access;
  });
}

/**
 * The personal machine's owner lets the agent continue, under the owner's
 * authority, with results other people's work left waiting in this chat.
 * Returns how many now continue. Throws a permission error for anyone else,
 * and an object-state error while the chat is not continuing the owner's own
 * work.
 */
export async function continueSessionWaitingWork(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string; subjectId: string },
): Promise<number> {
  return withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const [row] = await rawRows<{ continued: number | null }>(
      tx,
      sql`
      select opengeni_private.continue_session_waiting_work_v1(${input.accountId}::uuid, ${input.workspaceId}::uuid,
        ${input.sessionId}::uuid) as continued
    `,
    );
    return row?.continued ?? 0;
  });
}
