import { asc, eq } from "drizzle-orm";

import { type Database, rlsContextForWorkspace, WorkspaceNotFoundError } from "./database";
import { isWorkspaceEuOnly } from "./organization-inference-residency";
import * as schema from "./schema";

/**
 * EU-only content stays in EU-only workspaces. Content from an EU-only
 * workspace may reach another workspace only when that workspace is EU-only
 * too; content from any other workspace may go anywhere. Every check is per
 * workspace pair and asks only `isWorkspaceEuOnly`, so a per-workspace switch
 * applies here without changing callers. A failed read throws: nothing moves.
 * See docs/organization-tenancy.md.
 */
export type WorkspaceContentFlowEnd = { accountId: string; workspaceId: string };

export const WORKSPACE_CONTENT_FLOW_REFUSED_MESSAGE =
  "Not supported in EU-only workspaces: content from an EU-only workspace can only go to another EU-only workspace.";

export class WorkspaceContentFlowRefusedError extends Error {
  readonly code = "region_restricted" as const;
  constructor(
    readonly sourceWorkspaceId: string,
    readonly targetWorkspaceId: string,
  ) {
    super(WORKSPACE_CONTENT_FLOW_REFUSED_MESSAGE);
    this.name = "WorkspaceContentFlowRefusedError";
  }
}

function sameWorkspace(left: WorkspaceContentFlowEnd, right: WorkspaceContentFlowEnd): boolean {
  return left.accountId === right.accountId && left.workspaceId === right.workspaceId;
}

/**
 * A workspace with the organization it really belongs to, read from the
 * workspace itself; null when there is no such workspace.
 */
export async function workspaceContentFlowEnd(
  db: Database,
  workspaceId: string,
): Promise<WorkspaceContentFlowEnd | null> {
  try {
    const { accountId } = await rlsContextForWorkspace(db, workspaceId);
    return { accountId, workspaceId };
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) return null;
    throw error;
  }
}

/** Refuse when content from `source` would reach `target` and only `source` is EU-only. */
export async function assertWorkspaceContentFlowAllowed(
  db: Database,
  input: { source: WorkspaceContentFlowEnd; target: WorkspaceContentFlowEnd },
): Promise<void> {
  if (sameWorkspace(input.source, input.target)) return;
  if (!(await isWorkspaceEuOnly(db, input.source))) return;
  if (await isWorkspaceEuOnly(db, input.target)) return;
  throw new WorkspaceContentFlowRefusedError(input.source.workspaceId, input.target.workspaceId);
}

/**
 * For a step that sends content into the other workspace and brings its
 * content back: allowed only when content may flow both ways.
 */
export async function assertWorkspaceContentExchangeAllowed(
  db: Database,
  input: { here: WorkspaceContentFlowEnd; there: WorkspaceContentFlowEnd },
): Promise<void> {
  if (sameWorkspace(input.here, input.there)) return;
  const here = await isWorkspaceEuOnly(db, input.here);
  const there = await isWorkspaceEuOnly(db, input.there);
  if (here && !there)
    throw new WorkspaceContentFlowRefusedError(input.here.workspaceId, input.there.workspaceId);
  if (there && !here)
    throw new WorkspaceContentFlowRefusedError(input.there.workspaceId, input.here.workspaceId);
}

/**
 * For a step that can bring content from any workspace of an organization to
 * `target` (an organization-wide connection): allowed when `target` is
 * EU-only, or when no workspace of that organization is.
 */
export async function assertOrganizationContentFlowAllowed(
  db: Database,
  input: { sourceAccountId: string; target: WorkspaceContentFlowEnd },
): Promise<void> {
  if (await isWorkspaceEuOnly(db, input.target)) return;
  const workspaces = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.accountId, input.sourceAccountId))
    .orderBy(asc(schema.workspaces.id));
  for (const { id } of workspaces) {
    await assertWorkspaceContentFlowAllowed(db, {
      source: { accountId: input.sourceAccountId, workspaceId: id },
      target: input.target,
    });
  }
}
