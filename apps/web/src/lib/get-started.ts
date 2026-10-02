import { normalizeWebsite, type FirstAgentAnswers } from "./first-agent";
import type { OnboardingIntent, OnboardingJourney } from "./onboarding-journey";

/**
 * The Get started checklist, as data. One list serves the compact card on the
 * new-chat page and the full Get started page, so both always agree.
 *
 * Done states are truthful: each comes from live data when the app can read it
 * (a usable default model, a session, an API key, GitHub), from a mark only the
 * browser can know (the playground tour, a copied command), or stays unknown
 * (`null`) while loading or when the person can't read it. Unknown is never
 * shown as done.
 */

export type GetStartedItemId =
  | "path"
  | "model"
  | "github"
  | "first_task"
  | "playground"
  | "api_key"
  | "coding_agent";

export type GetStartedItem = Readonly<{
  id: GetStartedItemId;
  title: string;
  /** One quiet line: what it does, or the outcome once done. */
  description: string;
  /** true done, false to do, null not known yet. */
  done: boolean | null;
  optional: boolean;
}>;

export type GetStartedFacts = Readonly<{
  journey: OnboardingJourney | null;
  /** A usable default model for new chats here, and its label ("GPT-6 Luna · Codex"). */
  model: { ready: boolean; label: string | null } | null;
  /** Whether the person can add model accounts (organization owners and admins). */
  canManageModels: boolean;
  /** At least one chat in this workspace. */
  hasSession: boolean | null;
  /** Owners create organization API keys; the Build path needs one. */
  canCreateApiKeys: boolean;
  githubConnected: boolean | null;
  githubAvailable: boolean;
  /** Coding agents can sign in to the workspace here (MCP OAuth on). */
  codingAgentAvailable: boolean;
  /**
   * Opengeni credits, when this deployment sells them and the balance is
   * readable here: whether this person may buy (`billing:manage`), the balance
   * and the markup ("5%").
   */
  /** The deployment offers Codex (ChatGPT plans). Unknown counts as offered. */
  codexEnabled?: boolean;
  credits?: {
    canBuy: boolean;
    balance: { balanceMicros: number; currency: string } | null;
    margin: string | null;
  } | null;
}>;

const PATH_TITLES: Record<OnboardingIntent, string> = {
  build: "Adding agents to your product",
  cloud: "Agents for your own work",
  explore: "Exploring what agents can do",
};

export function onboardingIntentLabel(intent: OnboardingIntent): string {
  return PATH_TITLES[intent];
}

/** "Adding agents to your product", or both paths in one phrase. */
export function onboardingIntentsLabel(intents: readonly OnboardingIntent[]): string | null {
  if (intents.includes("build") && intents.includes("cloud"))
    return "Adding agents to your product and the cloud";
  const [first] = intents;
  return first ? PATH_TITLES[first] : null;
}

function item(
  id: GetStartedItemId,
  title: string,
  description: string,
  done: boolean | null,
  optional = false,
): GetStartedItem {
  return { id, title, description, done, optional };
}

/** The items for this person's path, in the order to do them. */
export function getStartedItems(facts: GetStartedFacts): GetStartedItem[] {
  const intents = facts.journey?.intents ?? [];
  const has = (intent: OnboardingIntent) => intents.includes(intent);
  const pathLabel = onboardingIntentsLabel(intents);
  const marks = facts.journey?.marks ?? {};
  const path = item(
    "path",
    "Build your first agent",
    firstAgentSummary(facts.journey?.firstAgent ?? null) ??
      pathLabel ??
      "Tell us about your product, or explore what agents can do.",
    intents.length > 0,
  );
  const github = item(
    "github",
    "Connect GitHub",
    marks.github_skipped && !facts.githubConnected
      ? "Skipped. Connect it any time."
      : "Let agents read your repositories and open pull requests.",
    facts.githubConnected === true ? true : marks.github_skipped ? true : facts.githubConnected,
    true,
  );
  const firstTask = item(
    "first_task",
    "Run your first task",
    "Fix an issue, schedule a morning brief, or research a decision.",
    marks.first_task ? true : facts.hasSession,
  );
  const playground = item(
    "playground",
    "Try the playground",
    "Watch a recorded demo of an agent inside a sample product, then restyle it.",
    Boolean(marks.playground),
    true,
  );
  const apiKey = item(
    "api_key",
    "Add an agent to your product",
    marks.first_api_session
      ? "Your app's first chat arrived."
      : marks.api_key
        ? "Your key is ready. Ask your coding agent to build the app."
        : facts.journey?.firstAgent.use === "product"
          ? "Your coding agent builds it into your product, with a key from here."
          : "Your coding agent builds a small app with an agent chat.",
    Boolean(marks.first_api_session),
  );
  const codingAgent = item(
    "coding_agent",
    "Use Opengeni from your coding agent",
    "Hand work to Opengeni from Claude Code, Codex, Cursor or VS Code.",
    Boolean(marks.coding_agent),
    true,
  );

  // Nothing about models while anything pays for them: credits (the trial
  // grant or bought) or any usable default. Only with neither is there one
  // item, so nobody is stuck. Unknown (still loading) shows nothing.
  const balance = facts.credits?.balance ?? null;
  const hasCredits = Boolean(balance && balance.balanceMicros > 0);
  const modelSteps =
    facts.model?.ready === false && !hasCredits
      ? [
          item(
            "model",
            "Add credits or connect a model",
            facts.canManageModels
              ? facts.credits != null
                ? "Buy Opengeni credits, or use a subscription or your own key."
                : "Use a subscription or your own key."
              : "Only organization owners and admins can add models. Ask one to connect a model.",
            false,
          ),
        ]
      : [];

  const canBuild = facts.canCreateApiKeys;
  // The product step first; the recorded playground is optional now.
  const buildSteps = [...(canBuild ? [apiKey] : []), playground];
  const cloudSteps = [...(facts.githubAvailable ? [github] : []), firstTask];
  // Someone who joined a team gets a lighter list: no path question first.
  const welcome = facts.journey?.invited === true && intents.length === 0;
  const ordered: GetStartedItem[] =
    has("build") || has("cloud")
      ? [
          path,
          ...modelSteps,
          ...(has("build") ? buildSteps : []),
          ...(has("cloud") ? cloudSteps : []),
          codingAgent,
        ]
      : [
          ...(welcome ? [] : [path]),
          ...modelSteps,
          firstTask,
          playground,
          ...(canBuild ? [apiKey] : []),
          codingAgent,
        ];
  // The product step adds Opengeni to the coding agent itself, so the
  // separate coding-agent step appears only without it.
  const hasProductStep = ordered.some((entry) => entry.id === "api_key");
  return ordered.filter(
    (entry) => entry.id !== "coding_agent" || (facts.codingAgentAvailable && !hasProductStep),
  );
}

/** One line for what was entered in first run. */
export function firstAgentSummary(answers: FirstAgentAnswers | null): string | null {
  if (!answers?.use) return null;
  if (answers.use === "work") return PATH_TITLES.cloud;
  if (answers.product === "explore") return "Exploring agents for your product";
  const website = normalizeWebsite(answers.website);
  const product = website
    ? new URL(website).hostname.replace(/^www\./u, "")
    : (answers.repository?.fullName ?? null);
  const how =
    answers.outcome === "session"
      ? "Opengeni is building it"
      : answers.builder === "own"
        ? "Your coding agent builds it"
        : null;
  return [product ? `Agent for ${product}` : PATH_TITLES.build, how].filter(Boolean).join(" · ");
}

export function getStartedProgress(items: readonly GetStartedItem[]): {
  done: number;
  total: number;
} {
  return { done: items.filter((entry) => entry.done === true).length, total: items.length };
}

/** The first item still to do: the checklist's "next" highlight. */
export function nextGetStartedItem(items: readonly GetStartedItem[]): GetStartedItem | null {
  return items.find((entry) => entry.done === false) ?? null;
}
