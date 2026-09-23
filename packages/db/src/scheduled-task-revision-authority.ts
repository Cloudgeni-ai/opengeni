import { sql } from "drizzle-orm";
import { ScheduledTaskRunAcceptedExecution } from "@opengeni/contracts";
import { rawRows, withRlsContext, type Database } from "./database";

export async function getScheduledTaskRevisionAuthority(
  db: Database,
  input: { accountId: string; workspaceId: string; taskId: string; taskAuthorityRevision: number },
): Promise<{
  subjectId: string;
  organizationMembershipId: string;
  membershipAuthorizationRevision: number;
} | null> {
  return withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const [row] = await rawRows<{ authority: unknown }>(
        tx,
        sql`
      select scheduled_task_revision_authority_snapshot(
        ${input.accountId}::uuid, ${input.workspaceId}::uuid,
        ${input.taskId}::uuid, ${input.taskAuthorityRevision}::bigint
      ) as authority`,
      );
      return row?.authority
        ? ScheduledTaskRunAcceptedExecution.shape.causalHumanAuthority.parse(row.authority)
        : null;
    },
  );
}
