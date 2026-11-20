// The customizable sidebar (docs/sidebar-layout.md, migration 1515): the
// workspace default (subject_id NULL) and each person's own changes on top,
// as JSON the API validates, with a compare-and-set revision. Presentation
// only: the API resolves every app against the reader's own access.
import { sql } from "drizzle-orm";
import { withRlsContext, type Database } from "./database";
import type { WorkspaceArtifactViewer } from "./workspace-artifacts";

export type SidebarLayoutScopeKey = { accountId: string; workspaceId: string };

export type SidebarLayoutRow = {
  layout: unknown;
  revision: number;
  updatedAt: string;
  updatedBy: string | null;
};

type RawRow = {
  subject_id: string | null;
  layout: unknown;
  revision: number;
  updated_at: Date | string;
  updated_by: string | null;
};

function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

function mapRow(row: RawRow): SidebarLayoutRow {
  return {
    layout: row.layout,
    revision: Number(row.revision),
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedBy: row.updated_by,
  };
}

/** The workspace default and, when `subjectId` is given, that person's own changes. */
export async function readSidebarLayouts(
  db: Database,
  scope: SidebarLayoutScopeKey,
  subjectId: string | null,
): Promise<{ workspace: SidebarLayoutRow | null; personal: SidebarLayoutRow | null }> {
  return await withRlsContext(
    db,
    scope,
    async (tx) => {
      const found = rows<RawRow>(
        await tx.execute(sql`
        select subject_id, layout, revision, updated_at, updated_by from sidebar_layouts
        where account_id = ${scope.accountId}::uuid and workspace_id = ${scope.workspaceId}::uuid
          and (subject_id is null${subjectId === null ? sql`` : sql` or subject_id = ${subjectId}`})`),
      );
      const workspace = found.find((row) => row.subject_id === null);
      const personal = subjectId === null ? undefined : found.find((row) => row.subject_id === subjectId);
      return {
        workspace: workspace ? mapRow(workspace) : null,
        personal: personal ? mapRow(personal) : null,
      };
    },
    { accessMode: "read only" },
  );
}

/**
 * Write one layout if its revision is still `expectedRevision` (0: no row
 * yet). Returns the new row, or null when someone else changed it meanwhile.
 */
export async function writeSidebarLayout(
  db: Database,
  scope: SidebarLayoutScopeKey,
  input: {
    /** Null: the workspace default. */
    subjectId: string | null;
    expectedRevision: number;
    layout: unknown;
    updatedBy: string | null;
  },
): Promise<SidebarLayoutRow | null> {
  const layout = JSON.stringify(input.layout);
  return await withRlsContext(db, scope, async (tx) => {
    const subjectMatch =
      input.subjectId === null ? sql`subject_id is null` : sql`subject_id = ${input.subjectId}`;
    if (input.expectedRevision === 0) {
      const inserted = rows<RawRow>(
        await tx.execute(sql`
        insert into sidebar_layouts (account_id, workspace_id, subject_id, layout, revision, updated_by)
        values (${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${input.subjectId},
          ${layout}::jsonb, 1, ${input.updatedBy})
        on conflict ${
          input.subjectId === null
            ? sql`(workspace_id) where subject_id is null`
            : sql`(workspace_id, subject_id) where subject_id is not null`
        } do nothing
        returning subject_id, layout, revision, updated_at, updated_by`),
      );
      return inserted[0] ? mapRow(inserted[0]) : null;
    }
    const updated = rows<RawRow>(
      await tx.execute(sql`
      update sidebar_layouts set layout = ${layout}::jsonb, revision = revision + 1,
        updated_by = ${input.updatedBy}, updated_at = now()
      where account_id = ${scope.accountId}::uuid and workspace_id = ${scope.workspaceId}::uuid
        and ${subjectMatch} and revision = ${input.expectedRevision}
      returning subject_id, layout, revision, updated_at, updated_by`),
    );
    return updated[0] ? mapRow(updated[0]) : null;
  });
}

export type SidebarAppSummary = { appId: string; title: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What the sidebar can show about apps for this viewer: the active apps among
 * `appIds` they can open, the workspace's pinned apps and their recently
 * opened ones. Archived, deleted and other people's Only me apps are left out.
 */
export async function readSidebarApps(
  db: Database,
  scope: SidebarLayoutScopeKey,
  input: {
    viewer: WorkspaceArtifactViewer;
    appIds: readonly string[];
    pinnedLimit: number;
    recentLimit: number;
  },
): Promise<{
  apps: Map<string, SidebarAppSummary>;
  pinned: SidebarAppSummary[];
  recent: SidebarAppSummary[];
}> {
  const ids = [...new Set(input.appIds.filter((id) => UUID.test(id)).map((id) => id.toLowerCase()))];
  const viewerSubject = input.viewer.subjectId;
  const visible = sql`a.account_id = ${scope.accountId}::uuid and a.workspace_id = ${scope.workspaceId}::uuid
    and a.status = 'active'
    and (a.visibility = 'workspace_shared'${
      viewerSubject === null ? sql`` : sql` or a.owner_subject_id = ${viewerSubject}::text`
    })`;
  return await withRlsContext(
    db,
    scope,
    async (tx) => {
      const [byId, pinned, recent] = await Promise.all([
        ids.length
          ? tx.execute(sql`select a.id::text as id, a.title from workspace_artifacts a
              where ${visible} and a.id = any(${`{${ids.join(",")}}`}::uuid[])`)
          : Promise.resolve([]),
        input.pinnedLimit > 0
          ? tx.execute(sql`select a.id::text as id, a.title from workspace_artifacts a
              join opengeni_private.list_artifact_pins(${scope.accountId}::uuid, ${scope.workspaceId}::uuid) pins
                on pins.kind = 'site' and pins.artifact_id = a.id::text
              where ${visible}
              order by lower(a.title), a.id limit ${input.pinnedLimit}`)
          : Promise.resolve([]),
        input.recentLimit > 0 && viewerSubject !== null
          ? tx.execute(sql`select a.id::text as id, a.title from site_opens o
              join workspace_artifacts a on a.workspace_id = o.workspace_id and a.id = o.site_id
              where o.workspace_id = ${scope.workspaceId}::uuid and o.subject_id = ${viewerSubject}
                and ${visible}
              order by o.opened_at desc, a.id limit ${input.recentLimit}`)
          : Promise.resolve([]),
      ]);
      const summary = (row: { id: string; title: string }) => ({ appId: row.id, title: row.title });
      return {
        apps: new Map(
          rows<{ id: string; title: string }>(byId).map((row) => [row.id, summary(row)]),
        ),
        pinned: rows<{ id: string; title: string }>(pinned).map(summary),
        recent: rows<{ id: string; title: string }>(recent).map(summary),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
