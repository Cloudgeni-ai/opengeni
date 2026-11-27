import {
  CreateScheduledTaskRequest,
  type AccessGrant,
  type AppPackageAutomation,
  type AppPackageProblem,
} from "@opengeni/contracts";
import {
  createValidatedScheduledTask,
  hasPermission,
  requireLimit,
  syncCreatedScheduledTask,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { AppPackageInstallAutomation } from "@opengeni/db";
import { reason } from "./service";

/**
 * The automations an app package carries (docs/app-packages.md#automations):
 * scheduled agent runs, such as a daily "update the work summary". Each is
 * added as an ordinary automation, switched off and owned by the installer,
 * who turns it on. `{{appId}}` in its prompt becomes the app's id. Upgrades
 * add new ones (by name) and keep the app's existing ones as they are.
 */

/** The automation as created for one app. */
export function automationPrompt(automation: AppPackageAutomation, appId: string): string {
  return automation.prompt.replaceAll("{{appId}}", appId);
}

export async function addPackageAutomations(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  input: {
    appId: string;
    automations: readonly AppPackageAutomation[];
    existing: readonly AppPackageInstallAutomation[];
    /** An agent's chat creates them as the agent (its own tools and permissions). */
    surface: "http" | "first_party_mcp";
  },
  problems: AppPackageProblem[],
): Promise<{ automations: AppPackageInstallAutomation[]; added: string[] }> {
  const automations = [...input.existing];
  const added: string[] = [];
  const missing = input.automations.filter(
    (automation) => !automations.some((entry) => entry.name === automation.name),
  );
  if (missing.length === 0) return { automations, added };
  if (!hasPermission(grant.permissions, "scheduled_tasks:manage", grant.permissionMode)) {
    for (const automation of missing)
      problems.push({
        part: "automation",
        name: automation.name,
        reason: "Adding automations needs permission to manage automations in this workspace",
      });
    return { automations, added };
  }
  for (const automation of missing) {
    try {
      const payload = CreateScheduledTaskRequest.parse({
        name: automation.name,
        schedule: automation.schedule,
        status: "paused",
        agentConfig: { prompt: automationPrompt(automation, input.appId) },
        metadata: { appPackage: { appId: input.appId } },
      });
      await requireLimit(deps, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        action: "schedule:create",
        quantity: 1,
      });
      const task = await createValidatedScheduledTask({
        settings: deps.settings,
        db: deps.db,
        objectStorage: deps.objectStorage,
        grant,
        payload,
        toolsProvided: false,
        sessionAuthorization: deps.sessionAuthorization,
        authorizationSurface: input.surface,
      });
      automations.push({ taskId: task.id, name: automation.name });
      added.push(automation.name);
      await syncCreatedScheduledTask({ db: deps.db, workflowClient: deps.workflowClient, task });
    } catch (error) {
      problems.push({
        part: "automation",
        name: automation.name,
        reason: reason(error, "adding an automation"),
      });
    }
  }
  return { automations, added };
}
