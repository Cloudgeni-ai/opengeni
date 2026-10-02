import { useWorkspaceSessions } from "@opengeni/react";
import { useCallback, useMemo } from "react";

import { apiBaseUrl } from "@/api";
import { useAppContext } from "@/context";
import { captureAnalyticsEvent } from "@/lib/analytics-observer";
import {
  apiOriginFor,
  codingAgentSetup,
  isAppCreatedSession,
  type CodingAgentSetup,
} from "@/lib/coding-agent-setup";
import { getStartedItems, getStartedProgress, type GetStartedItem } from "@/lib/get-started";
import { creditsMarginLabel } from "@/lib/model-payment";
import {
  firstChatModel,
  intentsForUse,
  type FirstAgentAnswers,
  type FirstAgentUse,
} from "@/lib/first-agent";
import {
  intentAnalyticsProperties,
  markOnboarding,
  onboardingJourneyStorageKey,
  sameIntents,
  updateOnboardingJourney,
  useOnboardingJourney,
  type OnboardingJourney,
  type OnboardingMark,
} from "@/lib/onboarding-journey";
import { DEVELOPMENT_WORKSPACE_NAME } from "@/lib/onboarding-paths";
import { modelUsesCredits } from "@/lib/model-policy";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import { useOrganizationCredits, type OrganizationCredits } from "@/lib/use-organization-credits";
import { useWorkspaceModelCatalog } from "@/lib/use-workspace-model-catalog";
import { administersOrganization } from "@/lib/workspaces";
import type { WorkspaceModelCatalogModel } from "@opengeni/sdk";

export type GetStartedState = Readonly<{
  organizationId: string | null;
  journeyKey: string | null;
  journey: OnboardingJourney | null;
  items: GetStartedItem[];
  progress: { done: number; total: number };
  /** The shared workspace the Build path uses, when it still exists. */
  developmentWorkspaceId: string | null;
  personalWorkspaceId: string | null;
  canManageModels: boolean;
  canCreateApiKeys: boolean;
  canCreateWorkspaces: boolean;
  /** The deployment offers Codex (ChatGPT plans). */
  codexEnabled: boolean;
  /** Opengeni credits here, and the markup on the provider's price ("5%"). */
  credits: OrganizationCredits & { margin: string | null; sold: boolean };
  /**
   * What new chats here can run on: GPT-6 Luna on Opengeni credits (the trial
   * grant, or credits bought), any usable default, or nothing yet. Null while
   * the catalog loads or fails.
   */
  firstChatModel: { id: string; reasoningEffort: string } | null;
  modelReady: boolean | null;
  /** Coding-agent setup for this workspace (MCP sign-in when the server allows it). */
  codingAgent: CodingAgentSetup;
  github: { available: boolean; connected: boolean | null; mode: "workspace" | "personal" | null };
  dismiss: () => void;
  restore: () => void;
  mark: (mark: OnboardingMark) => void;
  /** Keeps what was entered in first run. */
  updateFirstAgent: (update: Partial<FirstAgentAnswers>) => void;
  /** Answers "what do you want to use Opengeni for?", starting the journey when there is none. */
  chooseUse: (use: FirstAgentUse) => void;
  /**
   * The organization's shared Development workspace a product's agent lives
   * in (API keys reach shared workspaces only), created when missing and
   * allowed. Resolves to its id, or null.
   */
  ensureDevelopmentWorkspace: () => Promise<string | null>;
}>;

/** "GPT-6 Luna · Codex": the default new chats use here, and who pays for it. */
export function defaultModelLabel(
  model: Pick<WorkspaceModelCatalogModel, "label" | "cost" | "source">,
  billingMode: "disabled" | "stripe",
): string {
  const payer =
    model.cost === "free"
      ? "Free"
      : model.cost === "credits"
        ? billingMode === "stripe"
          ? "Opengeni credits"
          : "Included"
        : model.cost === "subscription"
          ? model.source === "supergrok"
            ? "SuperGrok"
            : "Your ChatGPT plan"
          : "Your API key";
  return `${model.label} · ${payer}`;
}

/**
 * Everything the Get started card and page show, from live data. `enabled`
 * false (no journey, dismissed card) keeps the reads off the new-chat page.
 */
export function useGetStarted(
  workspaceId: string,
  { enabled = true }: { enabled?: boolean } = {},
): GetStartedState {
  const context = useAppContext();
  const { accessContext, clientConfig } = context;
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const organizationId = workspace?.accountId ?? accessContext.defaultAccountId ?? null;
  const journeyKey = organizationId
    ? onboardingJourneyStorageKey(accessContext.subjectId, organizationId)
    : null;
  const journey = useOnboardingJourney(journeyKey);
  const catalog = useWorkspaceModelCatalog(enabled ? workspaceId : null);
  const sessions = useWorkspaceSessions({ limit: 10, enabled });
  const organizationCredits = useOrganizationCredits(organizationId, { enabled });

  const organizationWorkspaces = context.workspaces.filter(
    (candidate) => candidate.accountId === organizationId,
  );
  const developmentWorkspaceId =
    organizationWorkspaces.find(
      (candidate) =>
        candidate.id === journey?.developmentWorkspaceId && candidate.kind === "shared",
    )?.id ??
    organizationWorkspaces.find(
      (candidate) => candidate.kind === "shared" && candidate.name === DEVELOPMENT_WORKSPACE_NAME,
    )?.id ??
    null;
  const personalWorkspaceId =
    organizationWorkspaces.find((candidate) => candidate.kind === "personal")?.id ?? null;

  const canManageModels = administersOrganization({
    accessContext,
    clientConfig,
    accountId: organizationId,
  });
  const canCreateWorkspaces = canManageModels;
  const canCreateApiKeys = organizationId
    ? hasAccountPermission(accessContext, organizationId, "api_keys:manage")
    : false;

  const githubStatus = context.githubStatus;
  const workspaceGitHub =
    Boolean(githubStatus) &&
    githubStatus?.status !== "disabled" &&
    (githubStatus?.status === "bound" || Boolean(githubStatus?.installUrl)) &&
    hasWorkspacePermission(accessContext, workspaceId, "github:manage");
  const personalGitHub = Boolean(context.personalGitHubStatus?.enabled);
  const github = {
    available: workspaceGitHub || personalGitHub,
    connected:
      githubStatus?.status === "bound" || context.personalGitHubStatus?.connection
        ? true
        : githubStatus || context.personalGitHubStatus
          ? false
          : null,
    mode: workspaceGitHub ? ("workspace" as const) : personalGitHub ? ("personal" as const) : null,
  };

  const codingAgent = codingAgentSetup({
    mcpOAuthEnabled: clientConfig.mcpOAuthEnabled === true,
    apiOrigin: apiOriginFor(apiBaseUrl, window.location.origin),
    workspaceId,
  });

  const defaultModel = catalog.defaultSelection
    ? (catalog.models.find((model) => model.id === catalog.defaultSelection?.model) ?? null)
    : null;
  const modelKnown = !catalog.loading && !catalog.error;
  const modelReady = Boolean(defaultModel?.availability.selectable);
  const modelLabel = defaultModel
    ? defaultModelLabel(defaultModel, clientConfig.billingMode ?? "disabled")
    : null;
  // A first task is a chat someone started here, not one an app created.
  const humanSessions = sessions.sessions.filter((session) => !isAppCreatedSession(session)).length;
  const hasSession = sessions.loading && sessions.sessions.length === 0 ? null : humanSessions > 0;
  // Handing work to Opengeni from a coding agent needs the MCP sign-in.
  const codingAgentAvailable = codingAgent.oauth;
  // The workspace catalog says what this deployment offers here; the client
  // config's model list is empty for some callers.
  const codexEnabled =
    catalog.models.some((model) => model.source === "codex") ||
    clientConfig.models.some((model) => model.source === "codex");
  const creditsMargin = creditsMarginLabel(catalog.models);
  const creditsSold =
    organizationCredits.billingMode === "stripe" &&
    (catalog.models.some((model) => model.cost === "credits") ||
      clientConfig.models.some((model) => modelUsesCredits(model)));
  const creditsCanBuy = organizationCredits.canBuy;
  const creditsBalance = organizationCredits.balance;
  const creditsFacts = useMemo(
    () =>
      creditsSold
        ? { canBuy: creditsCanBuy, balance: creditsBalance, margin: creditsMargin }
        : null,
    [creditsBalance, creditsCanBuy, creditsMargin, creditsSold],
  );

  const items = useMemo(
    () =>
      getStartedItems({
        journey,
        model: modelKnown ? { ready: modelReady, label: modelLabel } : null,
        canManageModels,
        hasSession,
        canCreateApiKeys,
        githubConnected: github.connected,
        githubAvailable: github.available,
        codingAgentAvailable,
        codexEnabled,
        credits: creditsFacts,
      }),
    [
      journey,
      modelKnown,
      modelReady,
      modelLabel,
      canManageModels,
      hasSession,
      canCreateApiKeys,
      github.connected,
      github.available,
      codingAgentAvailable,
      codexEnabled,
      creditsFacts,
    ],
  );

  const dismiss = useCallback(() => {
    if (!journeyKey) return;
    updateOnboardingJourney(journeyKey, (current) => ({ ...current, checklistDismissed: true }));
    captureAnalyticsEvent(
      "get_started_dismissed",
      intentAnalyticsProperties(journey?.intents ?? []),
    );
  }, [journey?.intents, journeyKey]);
  const restore = useCallback(() => {
    if (!journeyKey) return;
    updateOnboardingJourney(journeyKey, (current) => ({ ...current, checklistDismissed: false }));
  }, [journeyKey]);
  const mark = useCallback(
    (value: OnboardingMark) => {
      if (journeyKey) markOnboarding(journeyKey, value);
    },
    [journeyKey],
  );

  const updateFirstAgent = useCallback(
    (update: Partial<FirstAgentAnswers>) => {
      if (!journeyKey) return;
      updateOnboardingJourney(journeyKey, (current) => ({
        ...current,
        firstAgent: { ...current.firstAgent, ...update },
      }));
    },
    [journeyKey],
  );

  const chooseUse = useCallback(
    (use: FirstAgentUse) => {
      if (!journeyKey) return;
      const intents = intentsForUse(use);
      const previous = journey?.intents ?? [];
      updateOnboardingJourney(journeyKey, (current) => ({
        ...current,
        intents,
        firstAgent: { ...current.firstAgent, use },
      }));
      captureAnalyticsEvent("onboarding_intent_selected", {
        ...intentAnalyticsProperties(intents),
        source: "first_agent",
        changed: previous.length > 0 && !sameIntents(previous, intents),
      });
    },
    [journey, journeyKey],
  );

  const ensureDevelopmentWorkspace = useCallback(async (): Promise<string | null> => {
    // Only a missing one is created, so answering again never duplicates it.
    if (developmentWorkspaceId || !organizationId || !canCreateWorkspaces)
      return developmentWorkspaceId;
    const created = await context.client.createOrganizationWorkspace(organizationId, {
      name: DEVELOPMENT_WORKSPACE_NAME,
      operationId: crypto.randomUUID(),
    });
    await context.refreshPrincipalAccess();
    if (journeyKey)
      updateOnboardingJourney(journeyKey, (current) => ({
        ...current,
        developmentWorkspaceId: created.id,
      }));
    return created.id;
  }, [canCreateWorkspaces, context, developmentWorkspaceId, journeyKey, organizationId]);

  return {
    organizationId,
    journeyKey,
    journey,
    items,
    progress: getStartedProgress(items),
    developmentWorkspaceId,
    personalWorkspaceId,
    canManageModels,
    canCreateApiKeys,
    canCreateWorkspaces,
    codexEnabled,
    credits: { ...organizationCredits, margin: creditsMargin, sold: creditsSold },
    firstChatModel: catalog.loading || catalog.error ? null : firstChatModel(catalog),
    modelReady: modelKnown ? modelReady : null,
    codingAgent,
    github,
    dismiss,
    restore,
    mark,
    updateFirstAgent,
    chooseUse,
    ensureDevelopmentWorkspace,
  };
}
