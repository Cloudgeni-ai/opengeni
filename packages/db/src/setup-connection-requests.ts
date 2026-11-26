import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, withSessionRlsActorContext, type Database } from "./database";

const ROUTINE = "opengeni_private.request_setup_connection_v1(uuid, uuid, text, text, text, text)";

/**
 * Ask the workspace's admins, in their inbox, to connect something a setup
 * needs (migration 1599). The routine trusts only this transaction's scope:
 * the requester is the scope's subject. Returns how many notices were opened
 * or reopened (0 when they were already asked), or null when nobody can be
 * asked: no admin it may ask here, or the database still withholds the
 * routine from the runtime (1599 creates it withheld; a later migration
 * grants it).
 */
export async function requestSetupConnection(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    requesterSubjectId: string;
    requesterLabel: string;
    provider: string;
    name: string;
    link: string;
  },
): Promise<number | null> {
  const scope = { accountId: input.accountId, workspaceId: input.workspaceId };
  return await withSessionRlsActorContext({ subjectId: input.requesterSubjectId }, () =>
    withRlsContext(db, scope, async (tx) => {
      const [privilege] = await rawRows<{ allowed: boolean }>(
        tx,
        sql`select to_regprocedure(${ROUTINE}) is not null
        and has_function_privilege(${ROUTINE}, 'EXECUTE') as allowed`,
      );
      if (privilege?.allowed !== true) return null;
      const [row] = await rawRows<{ asked: number | string | null }>(
        tx,
        sql`select opengeni_private.request_setup_connection_v1(
        ${input.accountId}::uuid,
        ${input.workspaceId}::uuid,
        ${input.requesterLabel},
        ${input.provider},
        ${input.name},
        ${input.link}
      ) as asked`,
      );
      const asked = Number(row?.asked ?? -1);
      return asked < 0 ? null : asked;
    }),
  );
}
