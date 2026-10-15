import type { Settings } from "@opengeni/config";
import {
  resolveWorkspaceSessionDefaults,
  type OrganizationModelDefaults,
  type WorkspaceSessionDefaults,
} from "@opengeni/contracts";
import {
  admissibleWorkspaceModel,
  loadWorkspaceModelSelectionInput,
  resolveWorkspaceModelSelection,
  selectDefaultSessionModel,
  type WorkspaceModelSelection,
} from "@opengeni/core";
import { getOrganizationModelDefaults, getWorkspace, type Database } from "@opengeni/db";

/**
 * The model of a Site agent conversation by who the viewer is.
 *
 * People outside the workspace (invited people and public visitors) never
 * use a subscription-billed model (a connected Codex, Claude or other
 * subscription): Site limits measure real money, and visitors must not use
 * up a subscription's rate limits or terms. When the Site agent's model is a
 * subscription model (or the workspace default it falls back to is one),
 * they get the workspace's default credit-billed model instead, chosen the
 * same way as the workspace's ordinary default over the credit-billed models
 * only. When the workspace has none, they are refused. Workspace members use
 * the Site agent's model, subscriptions included.
 */
export type SiteOutsideModelChoice =
  | { kind: "same"; model: string | null }
  | { kind: "fallback"; model: string }
  | { kind: "unavailable" };

/** Whether a model is billed through a subscription rather than credits. */
export function isSubscriptionBilledModel(
  selections: readonly WorkspaceModelSelection[],
  model: string,
): boolean {
  const selection = selections.find((candidate) => candidate.model.id === model);
  if (selection) return selection.model.cost === "subscription";
  return (
    model.startsWith("codex/") ||
    model.startsWith("supergrok/") ||
    /(^|-)(claude-)?subscription\//u.test(model)
  );
}

/** The decision for people outside the workspace, from already-loaded selections. */
export function siteOutsideModelChoice(input: {
  settings: Settings;
  selections: readonly WorkspaceModelSelection[];
  /** The Site agent's model; null uses the workspace default. */
  agentModel: string | null;
  workspaceDefaults: WorkspaceSessionDefaults | null;
  organizationDefaults: OrganizationModelDefaults["sessionDefaults"] | null;
}): SiteOutsideModelChoice {
  const base = {
    settings: input.settings,
    workspaceDefaults: input.workspaceDefaults,
    organizationDefaults: input.organizationDefaults,
  };
  const chosen =
    input.agentModel ??
    selectDefaultSessionModel({ ...base, selections: input.selections, creditsAvailable: true })
      .model;
  if (!isSubscriptionBilledModel(input.selections, chosen))
    return { kind: "same", model: input.agentModel };
  const credited = input.selections.filter((selection) => selection.model.cost !== "subscription");
  const fallback = selectDefaultSessionModel({
    ...base,
    selections: credited,
    creditsAvailable: true,
  }).model;
  return admissibleWorkspaceModel(credited, fallback) &&
    !isSubscriptionBilledModel(input.selections, fallback)
    ? { kind: "fallback", model: fallback }
    : { kind: "unavailable" };
}

/** Load the workspace's model selection and decide for people outside the workspace. */
export async function resolveSiteOutsideModel(
  deps: { db: Database; settings: Settings },
  scope: { accountId: string; workspaceId: string },
  input: { siteId: string; agentModel: string | null },
): Promise<SiteOutsideModelChoice> {
  const [selectionInput, workspace, organization] = await Promise.all([
    loadWorkspaceModelSelectionInput(deps.db, deps.settings, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      // The Site's own principal: it holds no personal subscription authority.
      subjectId: `site:${input.siteId}`,
    }),
    getWorkspace(deps.db, scope.workspaceId),
    getOrganizationModelDefaults(deps.db, scope.accountId),
  ]);
  return siteOutsideModelChoice({
    settings: deps.settings,
    selections: resolveWorkspaceModelSelection(selectionInput),
    agentModel: input.agentModel,
    workspaceDefaults: resolveWorkspaceSessionDefaults(workspace?.settings ?? {}),
    organizationDefaults: organization.sessionDefaults ?? null,
  });
}
