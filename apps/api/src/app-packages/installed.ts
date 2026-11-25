import type {
  AccessGrant,
  AppPackage,
  AppPackageAutomation,
  AppPackageProblem,
  AppPackageSkill,
} from "@opengeni/contracts";
import { readSkill, type ApiRouteDeps } from "@opengeni/core";
import { getAppPackageInstall, getScheduledTask, type AppPackageInstall } from "@opengeni/db";
import { reason } from "./service";

/**
 * What an app installed from a package carries beyond its version and data
 * definitions: its version label, the Skills linked to it (their current
 * files, edited or not) and its automations, for its export (and the
 * state an upgrade saves to go back to).
 */
export async function exportPackageExtras(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  appId: string,
  notExported: AppPackageProblem[],
): Promise<Pick<AppPackage, "packageVersion" | "skills" | "automations">> {
  let install: AppPackageInstall | null;
  try {
    install = await getAppPackageInstall(deps.db, grant.workspaceId, appId);
  } catch (error) {
    notExported.push({ part: "skill", reason: reason(error, "reading its Skills") });
    return {};
  }
  if (!install) return {};
  const skills: AppPackageSkill[] = [];
  for (const link of install.skills) {
    try {
      const record = await readSkill(
        deps.db,
        { accountId: grant.accountId, workspaceId: grant.workspaceId },
        link.skillId,
      );
      if (!record || record.files.length === 0) {
        notExported.push({ part: "skill", name: link.name, reason: "It was removed" });
        continue;
      }
      skills.push({
        name: record.title ?? link.name,
        description: record.description ?? "",
        files: record.files.map(({ path, content }) => ({ path, content })),
      });
    } catch (error) {
      notExported.push({ part: "skill", name: link.name, reason: reason(error, "reading it") });
    }
  }
  const automations: AppPackageAutomation[] = [];
  for (const link of install.automations) {
    let task: Awaited<ReturnType<typeof getScheduledTask>>;
    try {
      task = await getScheduledTask(deps.db, grant.workspaceId, link.taskId);
    } catch (error) {
      notExported.push({
        part: "automation",
        name: link.name,
        reason: reason(error, "reading it"),
      });
      continue;
    }
    // Removed here: nothing to export.
    if (!task) continue;
    automations.push({
      // The name it came with, which links it to the app (a rename here stays here).
      name: link.name,
      prompt: task.agentConfig.prompt.replaceAll(appId, "{{appId}}"),
      schedule: task.schedule as Record<string, unknown>,
    });
  }
  return {
    ...(install.packageVersion ? { packageVersion: install.packageVersion } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(automations.length > 0 ? { automations } : {}),
  };
}
