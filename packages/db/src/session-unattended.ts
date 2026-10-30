import { and, eq } from "drizzle-orm";
import { withWorkspaceSessionActivityRls, type Database } from "./database";
import * as schema from "./schema";

export type SetSessionUnattendedResult =
  | { status: "updated" }
  | { status: "not_found" }
  | { status: "archived" };

function sessionRow(input: { workspaceId: string; sessionId: string }) {
  return and(
    eq(schema.sessions.workspaceId, input.workspaceId),
    eq(schema.sessions.id, input.sessionId),
  );
}

/**
 * Record an explicit unattended choice for a chat (its switch or the API). It
 * applies from the next turn and a person's later message never changes it.
 * Callers authorize the request.
 */
export async function setSessionUnattendedSetting(
  db: Database,
  input: { workspaceId: string; sessionId: string; unattended: boolean },
): Promise<SetSessionUnattendedResult> {
  return await withWorkspaceSessionActivityRls(
    db,
    input.workspaceId,
    async (scoped) =>
      await scoped.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        const [row] = await tx
          .select({
            unattendedSetting: schema.sessions.unattendedSetting,
            contentArchiveState: schema.sessions.contentArchiveState,
          })
          .from(schema.sessions)
          .where(sessionRow(input))
          .for("no key update")
          .limit(1);
        if (!row) return { status: "not_found" as const };
        if (row.contentArchiveState !== null) return { status: "archived" as const };
        const setting = input.unattended ? "unattended" : "attended";
        if (row.unattendedSetting !== setting) {
          await tx
            .update(schema.sessions)
            .set({ unattendedSetting: setting })
            .where(sessionRow(input));
        }
        return { status: "updated" as const };
      }),
  );
}

/**
 * A person wrote in the chat: an automation's unattended default ends and the
 * chat runs attended from the next turn. An explicit choice is left alone.
 * Returns whether the setting changed.
 */
export async function endSessionUnattendedDefault(
  db: Database,
  input: { workspaceId: string; sessionId: string },
): Promise<boolean> {
  return await withWorkspaceSessionActivityRls(
    db,
    input.workspaceId,
    async (scoped) => await endSessionUnattendedDefaultInTransaction(scoped, input),
  );
}

/** `endSessionUnattendedDefault` inside a caller's workspace-scoped transaction. */
export async function endSessionUnattendedDefaultInTransaction(
  tx: Database,
  input: { workspaceId: string; sessionId: string },
): Promise<boolean> {
  const updated = await tx
    .update(schema.sessions)
    .set({ unattendedSetting: "attended" })
    .where(and(sessionRow(input), eq(schema.sessions.unattendedSetting, "unattended_by_default")))
    .returning({ id: schema.sessions.id });
  return updated.length > 0;
}
