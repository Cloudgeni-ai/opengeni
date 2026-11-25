import {
  compareAppPackageVersions,
  parseAppPackage,
  type AccessGrant,
  type AppPackageStatus,
  type ListAppPackageStatusResponse,
} from "@opengeni/contracts";
import { appTemplates, listSkills, siteViewerForGrant, type ApiRouteDeps } from "@opengeni/core";
import { listAppPackageInstalls } from "@opengeni/db";
import { skillModified } from "./skills";

/** The latest ready-made version of each package that has one: package id to template. */
function readyMadeVersions(): Map<string, { templateKey: string; packageVersion: string }> {
  const versions = new Map<string, { templateKey: string; packageVersion: string }>();
  for (const template of appTemplates()) {
    const { package: pkg } = parseAppPackage(template.package);
    if (!pkg.packageId || !pkg.packageVersion) continue;
    const known = versions.get(pkg.packageId);
    if (!known || compareAppPackageVersions(pkg.packageVersion, known.packageVersion) > 0)
      versions.set(pkg.packageId, {
        templateKey: template.key,
        packageVersion: pkg.packageVersion,
      });
  }
  return versions;
}

type SkillRecords = Awaited<ReturnType<typeof listSkills>>;

/** The linked workspace Skills that still exist, by id, paging past any number of Skills. */
async function linkedSkills(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  ids: ReadonlySet<string>,
): Promise<Map<string, SkillRecords[number]>> {
  const found = new Map<string, SkillRecords[number]>();
  const context = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  let after: { stableKey: string; id: string } | undefined;
  for (;;) {
    const page = await listSkills(deps.db, context, {
      scope: "workspace",
      metadataOnly: true,
      limit: 500,
      ...(after ? { after } : {}),
    });
    for (const record of page) if (ids.has(record.id)) found.set(record.id, record);
    const last = page.at(-1);
    if (page.length < 500 || !last || found.size === ids.size) return found;
    after = { stableKey: last.stableKey, id: last.id };
  }
}

/**
 * Installed apps the caller sees (docs/app-packages.md#updates-and-going-back):
 * each one's version, whether it or its Skills were changed here, its
 * automations, whether it can go back, and a ready-made update.
 */
export async function listAppPackageStatus(
  deps: ApiRouteDeps,
  grant: AccessGrant,
): Promise<ListAppPackageStatusResponse> {
  const viewer = await siteViewerForGrant(deps.db, grant);
  const installs = await listAppPackageInstalls(deps.db, grant.workspaceId, viewer);
  if (installs.length === 0) return { apps: [] };
  const ids = new Set(installs.flatMap((install) => install.skills.map((link) => link.skillId)));
  const skills = ids.size > 0 ? await linkedSkills(deps, grant, ids) : new Map();
  const updates = readyMadeVersions();
  const apps: AppPackageStatus[] = installs.map((install) => {
    const ready = install.packageId ? updates.get(install.packageId) : undefined;
    return {
      appId: install.appId,
      title: install.title,
      packageId: install.packageId,
      packageVersion: install.packageVersion,
      archived: install.archived,
      modified: Boolean(
        install.versionId &&
        install.currentVersionId &&
        install.versionId !== install.currentVersionId,
      ),
      skills: install.skills
        .filter((link) => skills.has(link.skillId))
        .map((link) => ({
          id: link.skillId,
          name: link.name,
          modified: skillModified(skills.get(link.skillId) ?? null, link),
        })),
      automations: install.automations.map((entry) => ({ id: entry.taskId, name: entry.name })),
      previous: install.previous,
      update:
        ready && compareAppPackageVersions(ready.packageVersion, install.packageVersion ?? "0") > 0
          ? ready
          : null,
    };
  });
  return { apps };
}
