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

/**
 * Why the workspace can't pay for an outsider's turn: no credits for the
 * model, or the workspace's usage allowance is used up.
 */
export type SiteAgentUnfundedReason = "no_credits" | "allowance_exhausted";

/**
 * The reason a core admission decision means the workspace can't pay, or
 * null when it was allowed or refused for anything else (a static cap, for
 * example, which a turn reports itself).
 */
export function siteUnfundedReason(decision: LimitDecision): SiteAgentUnfundedReason | null {
  if (decision.allowed) return null;
  if (decision.code === "insufficient_credits") return "no_credits";
  if (decision.code === "allowance_exhausted") return "allowance_exhausted";
  return null;
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

/** How long `site.config` reuses a workspace's funding answer for a model. */
export const SITE_OUTSIDE_FUNDING_MEMO_MS = 30_000;
const SITE_OUTSIDE_FUNDING_MEMO_MAX = 2_000;
const outsideFundingMemo = new Map<
  string,
  { answer: Promise<SiteAgentUnfundedReason | null>; expiresAt: number }
>();

/**
 * Reuse one funding answer per key for SITE_OUTSIDE_FUNDING_MEMO_MS from
 * `now`. Concurrent callers share the check in flight; a failed check is
 * forgotten as soon as it fails, so the next caller runs it again. Bounded:
 * expired answers are swept first, then the oldest live one is dropped.
 */
export function rememberSiteOutsideFunding(
  key: string,
  now: number,
  check: () => Promise<SiteAgentUnfundedReason | null>,
): Promise<SiteAgentUnfundedReason | null> {
  const memo = outsideFundingMemo.get(key);
  if (memo && memo.expiresAt > now) return memo.answer;
  outsideFundingMemo.delete(key);
  if (outsideFundingMemo.size >= SITE_OUTSIDE_FUNDING_MEMO_MAX) {
    for (const [stale, entry] of outsideFundingMemo)
      if (entry.expiresAt <= now) outsideFundingMemo.delete(stale);
    // Still full of live answers: drop the oldest (Map keeps insertion order).
    const oldest = outsideFundingMemo.keys().next();
    if (outsideFundingMemo.size >= SITE_OUTSIDE_FUNDING_MEMO_MAX && !oldest.done)
      outsideFundingMemo.delete(oldest.value);
  }
  const answer = check();
  const entry = { answer, expiresAt: now + SITE_OUTSIDE_FUNDING_MEMO_MS };
  outsideFundingMemo.set(key, entry);
  answer.catch(() => {
    if (outsideFundingMemo.get(key) === entry) outsideFundingMemo.delete(key);
  });
  return answer;
}

/**
 * Why the workspace can't pay for an outsider's turn on this model, or null
 * when it can (or was refused for something else), for `site.config`: a
 * public read made on every visitor page load. The answer is reused per
 * account, workspace and model for SITE_OUTSIDE_FUNDING_MEMO_MS, so a burst
 * of visitors runs core's admission check once; adding credits shows within
 * that window. A failed check is not remembered and is rethrown. Turns
 * still run core's own admission, so a stale answer only changes whether
 * the assistant is offered, never whether a turn is paid for.
 */
export function siteOutsideModelUnfundedReason(
  deps: { db: Database; settings: Settings },
  scope: { accountId: string; workspaceId: string },
  model: string,
  now: number = Date.now(),
): Promise<SiteAgentUnfundedReason | null> {
  return rememberSiteOutsideFunding(
    `${scope.accountId}\u0000${scope.workspaceId}\u0000${model}`,
    now,
    async () => siteUnfundedReason(await siteOutsideModelFunding(deps, scope, model)),
  );
}

/** Forget remembered funding answers, for tests. */
export function clearSiteOutsideFundingMemo(): void {
  outsideFundingMemo.clear();
}
