import { sql } from "drizzle-orm";
import { rawRows, withWorkspaceRls, type Database } from "./database";

/**
 * Apps installed or upgraded from a package (migration 1566,
 * docs/app-packages.md "Installed packages"): the package's version label,
 * the app version the package wrote, the Skills and automations that came
 * with it, and the app's saved states before each upgrade. Callers have
 * already opened the app as the person (or list only apps the viewer sees);
 * everything runs under the workspace's row-level security.
 */

export type AppPackageInstallSkill = { skillId: string; name: string; revisionId: string | null };
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
  previous: { packageVersion: string | null; savedAt: string } | null;
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

/**
 * Installed apps the viewer can see (every workspace app plus their own Only
 * me ones; a null subject sees workspace apps only), with their latest saved
 * state. At most 500, most recently changed first.
 */
export async function listAppPackageInstalls(
  db: Database,
  workspaceId: string,
  viewer: { subjectId: string | null },
): Promise<AppPackageInstallListing[]> {
  return await withWorkspaceRls(db, workspaceId, async (tx) => {
    const rows = await rawRows<
      InstallRow & {
        artifact_id: string;
        title: string;
        package_id: string | null;
        current_version_id: string | null;
        status: string;
        previous_version: string | null;
        previous_at: Date | string | null;
      }
    >(
      tx,
      sql`select i.artifact_id, i.package_version, i.version_id, i.skills, i.automations,
          a.title, a.package_id, a.current_version_id, a.status,
          s.package_version as previous_version, s.created_at as previous_at
        from app_package_installs i
        join workspace_artifacts a on a.id = i.artifact_id and a.workspace_id = i.workspace_id
        left join lateral (
          select package_version, created_at from app_package_snapshots
          where artifact_id = i.artifact_id and workspace_id = i.workspace_id
          order by created_at desc, id desc limit 1
        ) s on true
        where i.workspace_id = ${workspaceId}::uuid
          and (a.visibility = 'workspace_shared'
            or (${viewer.subjectId}::text is not null and a.owner_subject_id = ${viewer.subjectId}::text))
        order by a.updated_at desc, a.id desc
        limit 500`,
    );
    return rows.map((row) => ({
      ...fromRow(row),
      appId: row.artifact_id,
      title: row.title,
      packageId: row.package_id,
      currentVersionId: row.current_version_id,
      archived: row.status === "archived",
      previous: row.previous_at
        ? {
            packageVersion: row.previous_version,
            savedAt: new Date(row.previous_at).toISOString(),
          }
        : null,
    }));
  });
}

/**
 * Save the app's state before an applied upgrade, once per upgrade
 * (`operationKey`), and keep only the latest `keep`.
 */
export async function saveAppPackageSnapshot(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    appId: string;
    packageVersion: string | null;
    operationKey: string;
    package: Record<string, unknown>;
    keep: number;
  },
): Promise<void> {
  await withWorkspaceRls(db, input.workspaceId, async (tx) => {
    await tx.execute(
      sql`insert into app_package_snapshots
          (account_id, workspace_id, artifact_id, package_version, operation_key, package)
        values (${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.appId}::uuid,
          ${input.packageVersion}, ${input.operationKey}, ${JSON.stringify(input.package)}::jsonb)
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
  package: Record<string, unknown>;
  savedAt: string;
};

/** The app's latest saved state, or null when it has none. */
export async function latestAppPackageSnapshot(
  db: Database,
  workspaceId: string,
  appId: string,
): Promise<AppPackageSnapshot | null> {
  return await withWorkspaceRls(db, workspaceId, async (tx) => {
    const [row] = await rawRows<{
      id: string;
      package_version: string | null;
      package: Record<string, unknown>;
      created_at: Date | string;
    }>(
      tx,
      sql`select id, package_version, package, created_at from app_package_snapshots
        where workspace_id = ${workspaceId}::uuid and artifact_id = ${appId}::uuid
        order by created_at desc, id desc limit 1`,
    );
    return row
      ? {
          id: row.id,
          packageVersion: row.package_version,
          package: row.package,
          savedAt: new Date(row.created_at).toISOString(),
        }
      : null;
  });
}

/** Drop a saved state once the app went back to it. */
export async function deleteAppPackageSnapshot(
  db: Database,
  workspaceId: string,
  snapshotId: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (tx) => {
    await tx.execute(
      sql`delete from app_package_snapshots
        where workspace_id = ${workspaceId}::uuid and id = ${snapshotId}::uuid`,
    );
  });
}
