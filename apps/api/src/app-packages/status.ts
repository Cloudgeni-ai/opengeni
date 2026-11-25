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

/**
 * Installed apps the caller sees (docs/app-packages.md "Installed
 * packages"): each one's version, whether it or its Skills were changed
 * here, its automations, whether it can go back, and a ready-made update.
 */
export async function listAppPackageStatus(
  deps: ApiRouteDeps,
  grant: AccessGrant,
): Promise<ListAppPackageStatusResponse> {
  const viewer = await siteViewerForGrant(deps.db, grant);
  const installs = await listAppPackageInstalls(deps.db, grant.workspaceId, viewer);
  if (installs.length === 0) return { apps: [] };
  const skills = installs.some((install) => install.skills.length > 0)
    ? new Map(
        (
          await listSkills(
            deps.db,
            { accountId: grant.accountId, workspaceId: grant.workspaceId },
            { scope: "workspace", metadataOnly: true, limit: 1000 },
          )
        ).map((record) => [record.id, record]),
      )
    : new Map();
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
