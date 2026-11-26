import { sql } from "drizzle-orm";
import { rawRows, withWorkspaceRls, type Database } from "./database";

/**
 * Apps installed or upgraded from a package (migration 1571,
 * docs/app-packages.md#updates-and-going-back): the package's version label,
 * the app version the package wrote, the Skills and automations that came
 * with it, and the app's saved states before each upgrade. Callers have
 * already opened the app as the person (or list only apps the viewer sees);
 * everything runs under the workspace's row-level security.
 */

export type AppPackageInstallSkill = {
  skillId: string;
  name: string;
  /** The revision the package wrote, live on the Skill. */
  revisionId: string | null;
  /** A revision the package saved for review (Agent learning), not live yet. */
  pendingRevisionId?: string | null | undefined;
};
export type AppPackageInstallAutomation = { taskId: string; name: string };

export type AppPackageInstall = {
  packageVersion: string | null;
  /** The app version the package published or matched; null when unknown. */
  versionId: string | null;
  skills: AppPackageInstallSkill[];
  automations: AppPackageInstallAutomation[];
};

type InstallRow = {
  package_version: string | null;
  version_id: string | null;
  skills: AppPackageInstallSkill[];
  automations: AppPackageInstallAutomation[];
};

const fromRow = (row: InstallRow): AppPackageInstall => ({
  packageVersion: row.package_version,
  versionId: row.version_id,
  skills: Array.isArray(row.skills) ? row.skills : [],
  automations: Array.isArray(row.automations) ? row.automations : [],
});

export async function getAppPackageInstall(
  db: Database,
  workspaceId: string,
  appId: string,
): Promise<AppPackageInstall | null> {
  return await withWorkspaceRls(db, workspaceId, async (tx) => {
    const [row] = await rawRows<InstallRow>(
      tx,
      sql`select package_version, version_id, skills, automations from app_package_installs
        where workspace_id = ${workspaceId}::uuid and artifact_id = ${appId}::uuid`,
    );
    return row ? fromRow(row) : null;
  });
}

/** Record (or replace) what an install or applied upgrade left on the app. */
export async function putAppPackageInstall(
  db: Database,
  input: { accountId: string; workspaceId: string; appId: string } & AppPackageInstall,
): Promise<void> {
  await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    await tx.execute(
      sql`insert into app_package_installs
          (account_id, workspace_id, artifact_id, package_version, version_id, skills, automations)
        values (${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.appId}::uuid,
          ${input.packageVersion}, ${input.versionId}::uuid,
          ${JSON.stringify(input.skills)}::jsonb, ${JSON.stringify(input.automations)}::jsonb)
        on conflict (artifact_id) do update set
          package_version = excluded.package_version, version_id = excluded.version_id,
          skills = excluded.skills, automations = excluded.automations, updated_at = now()`,
    );
  });
}

export type AppPackageInstallListing = AppPackageInstall & {
  appId: string;
  title: string;
  packageId: string | null;
  currentVersionId: string | null;
  archived: boolean;
  previous: { id: string; packageVersion: string | null; savedAt: string } | null;
};

/**
 * The Skills linked to any app installed from this package here (copies of
 * one package share their Skills).
 */
export async function appPackageSkillIds(
  db: Database,
  workspaceId: string,
  packageId: string,
): Promise<Set<string>> {
  return await withWorkspaceRls(db, workspaceId, async (tx) => {
    const rows = await rawRows<{ skill_id: string }>(
      tx,
      sql`select distinct link->>'skillId' as skill_id
        from app_package_installs i
        join workspace_artifacts a on a.id = i.artifact_id and a.workspace_id = i.workspace_id
        cross join lateral jsonb_array_elements(i.skills) as link
        where i.workspace_id = ${workspaceId}::uuid and a.package_id = ${packageId}::uuid`,
    );
    return new Set(rows.map((row) => row.skill_id));
  });
}

/** The links active apps hold to one Skill (copies of a package share it). */
export async function appPackageSkillLinks(
  db: Database,
  workspaceId: string,
  skillId: string,
): Promise<Array<{ revisionId: string | null; pendingRevisionId: string | null }>> {
  return await withWorkspaceRls(db, workspaceId, async (tx) => {
    const rows = await rawRows<{ revision_id: string | null; pending_revision_id: string | null }>(
      tx,
      sql`select link->>'revisionId' as revision_id, link->>'pendingRevisionId' as pending_revision_id
        from app_package_installs i
        join workspace_artifacts a on a.id = i.artifact_id and a.workspace_id = i.workspace_id
        cross join lateral jsonb_array_elements(i.skills) as link
        where i.workspace_id = ${workspaceId}::uuid and a.status = 'active'
          and link->>'skillId' = ${skillId}`,
    );
    return rows.map((row) => ({
      revisionId: row.revision_id,
      pendingRevisionId: row.pending_revision_id,
    }));
  });
}

/**
 * Point every app linked to this Skill at its new revision (or, saved for
 * review, at the revision waiting for approval), so copies of one package
 * that share the Skill don't show it as changed there.
 */
export async function relinkAppPackageSkill(
  db: Database,
  workspaceId: string,
  link: { skillId: string } & (
    | { revisionId: string; pendingRevisionId?: undefined }
    | { revisionId?: undefined; pendingRevisionId: string }
  ),
): Promise<void> {
  const patch = link.revisionId
    ? { revisionId: link.revisionId, pendingRevisionId: null }
    : { pendingRevisionId: link.pendingRevisionId };
  await withWorkspaceRls(db, workspaceId, async (tx) => {
    await tx.execute(
      sql`update app_package_installs i set skills = (
          select jsonb_agg(case when entry->>'skillId' = ${link.skillId}
            then entry || ${JSON.stringify(patch)}::jsonb
            else entry end order by ord)
          from jsonb_array_elements(i.skills) with ordinality as e(entry, ord))
        where i.workspace_id = ${workspaceId}::uuid
          and i.skills @> ${JSON.stringify([{ skillId: link.skillId }])}::jsonb`,
    );
  });
}

/**
 * Apps installed from a package that the viewer can see (every workspace app
 * plus their own Only me ones; a null subject sees workspace apps only),
 * including ones installed before installs were recorded, with their latest
 * saved state not yet gone back to. At most 500, most recently changed first.
 */
export async function listAppPackageInstalls(
  db: Database,
  workspaceId: string,
  viewer: { subjectId: string | null },
): Promise<AppPackageInstallListing[]> {
  return await withWorkspaceRls(db, workspaceId, async (tx) => {
    const rows = await rawRows<
      Partial<InstallRow> & {
        artifact_id: string;
        title: string;
        package_id: string | null;
        current_version_id: string | null;
        status: string;
        previous_id: string | null;
        previous_version: string | null;
        previous_at: Date | string | null;
      }
    >(
      tx,
      sql`select a.id as artifact_id, i.package_version, i.version_id, i.skills, i.automations,
          a.title, a.package_id, a.current_version_id, a.status,
          s.id as previous_id, s.package_version as previous_version, s.created_at as previous_at
        from workspace_artifacts a
        left join app_package_installs i on i.artifact_id = a.id and i.workspace_id = a.workspace_id
        left join lateral (
          select id, package_version, created_at from app_package_snapshots
          where artifact_id = a.id and workspace_id = a.workspace_id and consumed_at is null
          order by created_at desc, id desc limit 1
        ) s on true
        where a.workspace_id = ${workspaceId}::uuid
          and (i.artifact_id is not null or a.package_id is not null)
          and (a.visibility = 'workspace_shared'
            or (${viewer.subjectId}::text is not null and a.owner_subject_id = ${viewer.subjectId}::text))
        order by a.updated_at desc, a.id desc
        limit 500`,
    );
    return rows.map((row) => ({
      ...fromRow({
        package_version: row.package_version ?? null,
        version_id: row.version_id ?? null,
        skills: row.skills ?? [],
        automations: row.automations ?? [],
      }),
      appId: row.artifact_id,
      title: row.title,
      packageId: row.package_id,
      currentVersionId: row.current_version_id,
      archived: row.status === "archived",
      previous: row.previous_id
        ? {
            id: row.previous_id,
            packageVersion: row.previous_version,
            savedAt: new Date(row.previous_at!).toISOString(),
          }
        : null,
    }));
  });
}

/**
 * Save the app's state before an applied upgrade, once per upgrade
 * (`operationKey`), and keep only the latest `keep`. The state is the app
 * version it was at plus its definitions as a package without the app's
 * files, which stay in the app's version history.
 */
export async function saveAppPackageSnapshot(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    appId: string;
    packageVersion: string | null;
    versionId: string;
    operationKey: string;
    package: Record<string, unknown>;
    keep: number;
  },
): Promise<void> {
  await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    await tx.execute(
      sql`insert into app_package_snapshots
          (account_id, workspace_id, artifact_id, package_version, version_id, operation_key, package)
        values (${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.appId}::uuid,
          ${input.packageVersion}, ${input.versionId}::uuid, ${input.operationKey},
          ${JSON.stringify(input.package)}::jsonb)
        on conflict (artifact_id, operation_key) do nothing`,
    );
    await tx.execute(
      sql`delete from app_package_snapshots where workspace_id = ${input.workspaceId}::uuid
        and artifact_id = ${input.appId}::uuid and id not in (
          select id from app_package_snapshots where workspace_id = ${input.workspaceId}::uuid
            and artifact_id = ${input.appId}::uuid
          order by created_at desc, id desc limit ${Math.max(1, input.keep)})`,
    );
  });
}

export type AppPackageSnapshot = {
  id: string;
  packageVersion: string | null;
  /** The app version to go back to. */
  versionId: string;
  /** The definitions, as a package without the app's files. */
  package: Record<string, unknown>;
  savedAt: string;
};

type SnapshotRow = {
  id: string;
  package_version: string | null;
  version_id: string;
  package: Record<string, unknown>;
  created_at: Date | string;
};

/**
 * One saved state of the app: the one with this id (also after the app went
 * back to it), else the one this request already went back to (a retry),
 * else its latest not yet gone back to. Null when there is none.
 */
export async function getAppPackageSnapshot(
  db: Database,
  workspaceId: string,
  appId: string,
  by: { id: string } | { restoreKey: string | null },
): Promise<AppPackageSnapshot | null> {
  return await withWorkspaceRls(db, workspaceId, async (tx) => {
    const columns = sql`select id, package_version, version_id, package, created_at
      from app_package_snapshots
      where workspace_id = ${workspaceId}::uuid and artifact_id = ${appId}::uuid`;
    let [row] =
      "id" in by
        ? await rawRows<SnapshotRow>(tx, sql`${columns} and id = ${by.id}::uuid`)
        : by.restoreKey
          ? await rawRows<SnapshotRow>(
              tx,
              sql`${columns} and consumed_restore_key = ${by.restoreKey} limit 1`,
            )
          : [];
    if (!row && !("id" in by))
      [row] = await rawRows<SnapshotRow>(
        tx,
        sql`${columns} and consumed_at is null order by created_at desc, id desc limit 1`,
      );
    return row
      ? {
          id: row.id,
          packageVersion: row.package_version,
          versionId: row.version_id,
          package: row.package,
          savedAt: new Date(row.created_at).toISOString(),
        }
      : null;
  });
}

/**
 * Mark a saved state as gone back to (by this request), so "Restore previous
 * version" offers the one before it and a retry still finds it.
 */
export async function consumeAppPackageSnapshot(
  db: Database,
  workspaceId: string,
  input: { snapshotId: string; restoreKey: string },
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (tx) => {
    await tx.execute(
      sql`update app_package_snapshots
        set consumed_at = now(), consumed_restore_key = ${input.restoreKey}
        where workspace_id = ${workspaceId}::uuid and id = ${input.snapshotId}::uuid
          and consumed_at is null`,
    );
  });
}
