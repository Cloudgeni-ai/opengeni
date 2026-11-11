import { sql, type SQL } from "drizzle-orm";
import { rawRows, type Database } from "./database";
import * as schema from "./schema";

// A chat that runs on a member's personal machine can only start work its
// owner caused (the attempt admission trigger enforces it). A queued message
// another person sent there therefore cannot run, so it waits: it is not
// runnable work, it never steers or blocks the chat, and the owner's next own
// message takes it in as context (or it runs once the chat moves to a machine
// it may use). Whether a message waits is decided live from the chat's current
// machine, never frozen at acceptance.
//
// The owner lookup is a runtime definer that 0978 creates withheld: a release
// that does not know it rejects a runtime EXECUTE grant on it, so a later
// migration grants it once this release is the previous one. Until then the
// lookup reports no personal machine, nothing waits, and the chat behaves as
// before (the admission trigger still refuses the message when it is claimed).

/**
 * Model context on each waiting message the owner's turn takes in. Written
 * once into that turn's durable history and never re-rendered.
 */
export const WAITED_FOR_MACHINE_OWNER_MODEL_CONTEXT =
  "This message waited because the chat runs on a personal machine and only the machine's owner can start work there. It reaches you with the owner's next message, which follows it. Act on it only as far as the owner's message asks.";

const MACHINE_OWNER_LOOKUP = "opengeni_private.session_machine_owner_subject_v1(uuid, uuid, uuid)";

/**
 * Whether the runtime may call the machine-owner lookup yet. False while its
 * EXECUTE grant is withheld (or the routine is absent). A separate statement:
 * EXECUTE is checked when a statement starts, so a guard inside the calling
 * statement would not avoid the permission error.
 */
export async function machineOwnerLookupGranted(db: Pick<Database, "execute">): Promise<boolean> {
  const [row] = await rawRows<{ granted: boolean | null }>(
    db,
    sql`select has_function_privilege(to_regprocedure(${MACHINE_OWNER_LOOKUP})::oid, 'EXECUTE')
      as granted`,
  );
  return row?.granted === true;
}

/**
 * The person who owns the personal machine the chat currently runs on, or null
 * when it runs on a shared machine, a cloud machine or none (or the caller's
 * scope does not match, or the lookup is not granted yet). Explanation only:
 * it authorizes nothing.
 */
export async function sessionMachineOwnerSubject(
  db: Pick<Database, "execute">,
  input: { accountId: string | null; workspaceId: string; sessionId: string },
): Promise<string | null> {
  if (!(await machineOwnerLookupGranted(db))) return null;
  const account =
    input.accountId === null
      ? sql`nullif(current_setting('opengeni.account_id', true), '')::uuid`
      : sql`${input.accountId}::uuid`;
  const [row] = await rawRows<{ owner: string | null }>(
    db,
    sql`select opengeni_private.session_machine_owner_subject_v1(${account},
      ${input.workspaceId}::uuid, ${input.sessionId}::uuid) as owner`,
  );
  return row?.owner ?? null;
}

/**
 * The `session_turns` row is a person's queued message that waits for the
 * machine owner: it has never started and nobody but `ownerSubjectId` caused it.
 * The causal person is read exactly as the admission trigger reads it.
 */
export function waitsForMachineOwnerSql(ownerSubjectId: string): SQL {
  const turns = schema.sessionTurns;
  return sql`(${turns.status} = 'queued' and ${turns.source} in ('user', 'api')
    and ${turns.startedAt} is null
    and coalesce(nullif(btrim(${turns.initiatingHumanSubjectId}), ''),
      case when ${turns.initiatorKind} = 'subject'
        then nullif(btrim(${turns.initiatorSubjectId}), '') end)
      is distinct from ${ownerSubjectId})`;
}

/** Excludes waiting messages from a queued-turn predicate; a no-op off personal machines. */
export function notWaitingForMachineOwnerSql(ownerSubjectId: string | null): SQL {
  return ownerSubjectId === null ? sql`true` : sql`not ${waitsForMachineOwnerSql(ownerSubjectId)}`;
}

/**
 * Whether the chat has a queued turn that can start: any queued turn except a
 * message waiting for the machine owner. Pass `sources` to look only at those.
 */
export async function runnableQueuedTurnExists(
  db: Pick<Database, "execute">,
  input: {
    accountId: string | null;
    workspaceId: string;
    sessionId: string;
    sources?: readonly ("user" | "api")[];
  },
): Promise<boolean> {
  const turns = schema.sessionTurns;
  const sourceFilter = input.sources
    ? sql`and ${turns.source} in (${sql.join(
        input.sources.map((source) => sql`${source}`),
        sql`, `,
      )})`
    : sql``;
  const queued = await rawRows<{ waits_possible: boolean }>(
    db,
    sql`select (${turns.source} in ('user', 'api') and ${turns.startedAt} is null) as waits_possible
      from ${turns}
      where ${turns.workspaceId} = ${input.workspaceId} and ${turns.sessionId} = ${input.sessionId}
        and ${turns.status} = 'queued' ${sourceFilter}
      order by 1
      limit 1`,
  );
  const first = queued[0];
  if (!first) return false;
  // A queued turn that could not be a waiting message is always runnable.
  if (!first.waits_possible) return true;
  const owner = await sessionMachineOwnerSubject(db, input);
  if (owner === null) return true;
  const [runnable] = await rawRows<{ id: string }>(
    db,
    sql`select ${turns.id} as id from ${turns}
      where ${turns.workspaceId} = ${input.workspaceId} and ${turns.sessionId} = ${input.sessionId}
        and ${turns.status} = 'queued' ${sourceFilter}
        and ${notWaitingForMachineOwnerSql(owner)}
      limit 1`,
  );
  return runnable !== undefined;
}
