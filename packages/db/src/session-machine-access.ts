import { sql } from "drizzle-orm";
import { SessionMachineAccess } from "@opengeni/contracts";
import { rawRows, withWorkspaceSubjectRls, type Database } from "./database";

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
    return row?.result ? SessionMachineAccess.parse(row.result) : null;
  });
}
