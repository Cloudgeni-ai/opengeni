import type { Settings } from "@opengeni/config";
import {
  resolveWorkspaceSessionDefaults,
  type LimitDecision,
  type OrganizationModelDefaults,
  type WorkspaceSessionDefaults,
} from "@opengeni/contracts";
import {
  admissibleWorkspaceModel,
  checkLimit,
  loadWorkspaceModelSelectionInput,
  resolveWorkspaceCatalogSettings,
  resolveWorkspaceModelSelection,
  selectDefaultSessionModel,
  type WorkspaceModelSelection,
} from "@opengeni/core";
import { getOrganizationModelDefaults, getWorkspace, type Database } from "@opengeni/db";

/** Resolve the current catalog before applying the viewer's workspace policy. */
export async function loadSiteModelSelectionInput(
  deps: { db: Database; settings: Settings; catalogSourceSettings?: Settings },
  scope: { accountId: string; workspaceId: string; subjectId: string },
) {
  const catalog = await resolveWorkspaceCatalogSettings(
    deps.db,
    deps.catalogSourceSettings ?? deps.settings,
    scope,
  );
  return loadWorkspaceModelSelectionInput(deps.db, catalog.settings, scope);
}

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
  /** The Site agent's model (or the workspace default it resolves to), not a subscription. */
  { kind: "same"; model: string } | { kind: "fallback"; model: string } | { kind: "unavailable" };

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
  // Always the concrete model: a session created without one would take the
  // workspace's ordinary default, which may be a subscription.
  // The fallback is paid with credits, as the publish dialog says.
  const credited = input.selections.filter((selection) => selection.model.cost === "credits");
  if (
    admissibleWorkspaceModel(credited, chosen) &&
    !isSubscriptionBilledModel(input.selections, chosen)
  )
    return { kind: "same", model: chosen };
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

/** Actual catalog billing, not just provider-name heuristics, fences every admission. */
export async function siteCreditModelIds(
  deps: { db: Database; settings: Settings },
  scope: { accountId: string; workspaceId: string },
  siteId: string,
): Promise<string[]> {
  return (await siteCreditModelSelections(deps, scope, siteId)).map(
    (selection) => selection.model.id,
  );
}

/** The admissible credit-billed model selections people outside the workspace may use. */
export async function siteCreditModelSelections(
  deps: { db: Database; settings: Settings },
  scope: { accountId: string; workspaceId: string },
  siteId: string,
): Promise<WorkspaceModelSelection[]> {
  const input = await loadSiteModelSelectionInput(deps, {
    ...scope,
    subjectId: `site:${siteId}`,
  });
  return resolveWorkspaceModelSelection(input).filter(
    (selection) =>
      selection.model.cost === "credits" &&
      admissibleWorkspaceModel([selection], selection.model.id),
  );
}

/** Load the workspace's model selection and decide for people outside the workspace. */
export async function resolveSiteOutsideModel(
  deps: { db: Database; settings: Settings },
  scope: { accountId: string; workspaceId: string },
  input: { siteId: string; agentModel: string | null },
): Promise<SiteOutsideModelChoice> {
  const [selectionInput, workspace, organization] = await Promise.all([
    loadSiteModelSelectionInput(deps, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      // The Site's own principal: it holds no personal subscription authority.
      subjectId: `site:${input.siteId}`,
    }),
    getWorkspace(deps.db, scope.workspaceId),
    getOrganizationModelDefaults(deps.db, scope.accountId),
  ]);
  return siteOutsideModelChoice({
    settings: selectionInput.settings,
    selections: resolveWorkspaceModelSelection(selectionInput),
    agentModel: input.agentModel,
    workspaceDefaults: resolveWorkspaceSessionDefaults(workspace?.settings ?? {}),
    organizationDefaults: organization.sessionDefaults ?? null,
  });
}

/** Core refusals that mean the workspace can't pay for the turn. */
const UNFUNDED_LIMIT_CODES: ReadonlySet<string> = new Set([
  "insufficient_credits",
  "allowance_exhausted",
]);

/** Whether a core admission refusal (402) means the workspace can't pay. */
export function siteUnfundedLimitCode(code: unknown): boolean {
  return typeof code === "string" && UNFUNDED_LIMIT_CODES.has(code);
}

/**
 * Whether the workspace can pay for a turn by someone outside it on this
 * credit-billed model right now: core's own admission check for a new agent
 * run, with no person's allowance behind it, as an outside visitor's turn
 * has none. A Site whose assistant would only answer "no credits" reports
 * the assistant as unavailable instead of offering it.
 */
export async function siteOutsideModelFunding(
  deps: { db: Database; settings: Settings },
  scope: { accountId: string; workspaceId: string },
  model: string,
): Promise<LimitDecision> {
  return checkLimit(deps, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    initiatingHumanSubjectId: null,
    action: "agent_run:create",
    quantity: 1,
    model,
  });
}
