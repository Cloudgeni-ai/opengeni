import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";

const ROUTINE = "opengeni_private.request_setup_connection_v1(uuid, text, text, text, text, text)";

/**
 * Ask the workspace's admins, in their inbox, to connect something a setup
 * needs (migration 1580). Returns how many admins were asked, or null while
 * the database still withholds the routine from the runtime (1580 creates it
 * withheld; a later migration grants it).
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
  return await withRlsContext(db, scope, async (tx) => {
    const [privilege] = await rawRows<{ allowed: boolean }>(
      tx,
      sql`select to_regprocedure(${ROUTINE}) is not null
        and has_function_privilege(${ROUTINE}, 'EXECUTE') as allowed`,
    );
    if (privilege?.allowed !== true) return null;
    const [row] = await rawRows<{ asked: number | string | null }>(
      tx,
      sql`select opengeni_private.request_setup_connection_v1(
        ${input.workspaceId}::uuid,
        ${input.requesterSubjectId},
        ${input.requesterLabel},
        ${input.provider},
        ${input.name},
        ${input.link}
      ) as asked`,
    );
    return Number(row?.asked ?? 0);
  });
}
