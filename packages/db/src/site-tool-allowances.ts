import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./database";
import { withWorkspaceSubjectRls } from "./database";
import * as schema from "./schema";

/**
 * "Always allow for this Site": one person's standing consent for one Site to
 * run one tool on one connection. Personal (RLS: own subject only). The
 * connector is the canonical server, never an account route, and a tool
 * without a connection uses the empty connection id.
 */
export type SiteToolAllowanceKey = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  siteId: string;
  serverId: string;
  toolName: string;
  connectionId: string | null;
};

export type SiteToolAllowance = Omit<
  SiteToolAllowanceKey,
  "accountId" | "workspaceId" | "subjectId"
> & {
  createdAt: string;
};

function keyWhere(input: Omit<SiteToolAllowanceKey, "accountId">) {
  return and(
    eq(schema.siteToolAllowances.workspaceId, input.workspaceId),
    eq(schema.siteToolAllowances.subjectId, input.subjectId),
    eq(schema.siteToolAllowances.siteId, input.siteId),
    eq(schema.siteToolAllowances.serverId, input.serverId),
    eq(schema.siteToolAllowances.toolName, input.toolName),
    eq(schema.siteToolAllowances.connectionId, input.connectionId ?? ""),
  );
}

export async function recordSiteToolAllowance(
  db: Database,
  input: SiteToolAllowanceKey,
): Promise<void> {
  await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    await tx
      .insert(schema.siteToolAllowances)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        siteId: input.siteId,
        serverId: input.serverId,
        toolName: input.toolName,
        connectionId: input.connectionId ?? "",
      })
      .onConflictDoNothing();
  });
}

export async function hasSiteToolAllowance(
  db: Database,
  input: SiteToolAllowanceKey,
): Promise<boolean> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const [row] = await tx
      .select({ siteId: schema.siteToolAllowances.siteId })
      .from(schema.siteToolAllowances)
      .where(and(keyWhere(input), eq(schema.siteToolAllowances.accountId, input.accountId)))
      .limit(1);
    return row !== undefined;
  });
}

export async function listSiteToolAllowances(
  db: Database,
  input: { workspaceId: string; subjectId: string; siteId: string },
): Promise<SiteToolAllowance[]> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.siteToolAllowances)
      .where(
        and(
          eq(schema.siteToolAllowances.workspaceId, input.workspaceId),
          eq(schema.siteToolAllowances.subjectId, input.subjectId),
          eq(schema.siteToolAllowances.siteId, input.siteId),
        ),
      )
      .orderBy(
        asc(schema.siteToolAllowances.serverId),
        asc(schema.siteToolAllowances.toolName),
        asc(schema.siteToolAllowances.connectionId),
      )
      .limit(500);
    return rows.map((row) => ({
      siteId: row.siteId,
      serverId: row.serverId,
      toolName: row.toolName,
      connectionId: row.connectionId === "" ? null : row.connectionId,
      createdAt: row.createdAt.toISOString(),
    }));
  });
}

/** Removes every standing consent this person gave the Site. */
export async function clearSiteToolAllowances(
  db: Database,
  input: { workspaceId: string; subjectId: string; siteId: string },
): Promise<number> {
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const removed = await tx
      .delete(schema.siteToolAllowances)
      .where(
        and(
          eq(schema.siteToolAllowances.workspaceId, input.workspaceId),
          eq(schema.siteToolAllowances.subjectId, input.subjectId),
          eq(schema.siteToolAllowances.siteId, input.siteId),
        ),
      )
      .returning({ siteId: schema.siteToolAllowances.siteId });
    return removed.length;
  });
}
