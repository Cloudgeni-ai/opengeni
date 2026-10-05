// What a new organization owner chose in the post-signup onboarding, and the
// text the "Add AI agents to my product" path hands to an agent. Onboarding
// only: keep it out of the session and startup graphs.

/** The first onboarding question: embed Opengeni in a product, or use it directly. */
export type OnboardingUseCase = "embed" | "cloud";

/** Name of the shared workspace "Let Opengeni implement it" creates. */
export const DEVELOPER_SETUP_WORKSPACE_NAME = "Opengeni setup";
/** Variable set that carries the setup key into that chat's sandbox. */
export const DEVELOPER_SETUP_VARIABLE_SET_NAME = "Opengeni developer setup";
/**
 * Sandbox variable holding the setup key. `OPENGENI_` names are reserved for
 * the platform, so the agent maps this to `OPENGENI_API_KEY` itself.
 */
export const DEVELOPER_SETUP_KEY_VARIABLE = "DEVELOPER_SETUP_API_KEY";
/**
 * How long the signup key lasts. Longer than the preset's 24-hour default so a
 * new owner has time to build and test the integration before replacing it.
 */
export const DEVELOPER_SETUP_KEY_LIFETIME_DAYS = 30;

/** The organization key onboarding creates: full access, valid for 30 days, so setup needs no UI. */
export function developerSetupKeyRequest(now: Date = new Date()) {
  return {
    name: "Setup (full access)",
    description: "Created at signup so an agent can set up Opengeni in your product end to end.",
    access: "full",
    expiresAt: new Date(
      now.getTime() + DEVELOPER_SETUP_KEY_LIFETIME_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString(),
  } as const;
}

/** The visible first message of the setup chat. */
export const DEVELOPER_SETUP_INITIAL_MESSAGE =
  "I want to add AI agents to my product. Help me set it up.";

export type DeveloperSetupFacts = {
  /** The deployment's API origin, e.g. https://app.opengeni.ai. */
  apiBaseUrl: string;
  organizationId: string;
  organizationName?: string | undefined;
};

function organizationLine(facts: DeveloperSetupFacts): string {
  return facts.organizationName
    ? `${facts.organizationName} (ID ${facts.organizationId})`
    : `ID ${facts.organizationId}`;
}

/** Where the person stores the key for their own coding agent's integration. */
export const CODING_AGENT_KEY_VARIABLE = "OPENGENI_API_KEY";
/** The SDK's default API origin; other deployments also need OPENGENI_API_BASE_URL. */
const DEFAULT_API_BASE_URL = "https://app.opengeni.ai";

/**
 * The prompt a person pastes into their own coding agent (Claude Code, Codex,
 * Cursor, ChatGPT). It never contains the key: the person copies the key in a
 * separate step into their server-only env, and the prompt names that variable.
 */
export function codingAgentSetupPrompt(facts: DeveloperSetupFacts): string {
  const baseUrl =
    facts.apiBaseUrl === DEFAULT_API_BASE_URL
      ? ""
      : `, with OPENGENI_API_BASE_URL=${facts.apiBaseUrl} beside it`;
  return `Add AI agents to my product with Opengeni (https://opengeni.ai).

First get the Opengeni skills, if you don't have them:
- Claude Code: claude plugin marketplace add Cloudgeni-ai/opengeni && claude plugin install opengeni@opengeni --scope user
- Codex: codex plugin marketplace add Cloudgeni-ai/opengeni && codex plugin add opengeni@opengeni
- Cursor: Customize > From GitHub Repository > https://github.com/Cloudgeni-ai/opengeni, then install Opengeni
- Anything else: read https://docs.opengeni.ai/llms.txt and https://github.com/Cloudgeni-ai/opengeni/tree/main/.agents/skills/opengeni-client
Then follow the build-with-opengeni skill and its opengeni-client guide: one server route plus the OpenGeniChat component.

My account is ready, so skip sign-in and key creation:
- Opengeni API: ${facts.apiBaseUrl}
- Organization: ${organizationLine(facts)}
- My full-access setup API key (expires in 30 days) goes in this project's server-only .env as ${CODING_AGENT_KEY_VARIABLE}${baseUrl}. If it isn't there yet, ask me for it.

The key is used only by the server (never in browser code). Before production, ask me to create a long-lived key in Opengeni under Organization settings > Developer.

Start by looking at this repository. Then ask me, in one short message, what I want AI agents to do for my users. If there's no product yet, suggest two or three simple ideas.`;
}

/**
 * The model-visible onboarding context attached to the setup chat's first
 * message. It names where the key is, never the key itself.
 */
export function developerSetupModelContext(
  facts: DeveloperSetupFacts & { keyInSandbox: boolean },
): string {
  const key = facts.keyInSandbox
    ? `- A full-access organization API key was created for me at signup. It is in this chat's sandbox as the ${DEVELOPER_SETUP_KEY_VARIABLE} environment variable (variable set "${DEVELOPER_SETUP_VARIABLE_SET_NAME}"); use it as OPENGENI_API_KEY when you set up or test. It expires in 30 days; you may use it to set up and test everything, including creating test users and a long-lived key for production.`
    : "- No API key is attached to this chat. When one is needed, ask me to create it in Organization settings > Developer.";
  return `Signup onboarding choices:
- Goal: add AI agents to my product (embed Opengeni). I chose to let Opengeni implement it.
- Organization: ${organizationLine(facts)}. Opengeni API: ${facts.apiBaseUrl}. This chat is in the "${DEVELOPER_SETUP_WORKSPACE_NAME}" workspace, made for this.
${key}

How to help me:
1. Reply right away: write this question as text before any tool call or reading anything else. In one short message ask: the link to my product (or its repository), what I want AI agents to do for my users, and whether each chat should be private to the person who started it or shared with their team (recommend private). If I don't have a product yet, offer two or three simple ideas.
2. Only after that text, in the same turn, show me the GitHub Connect card so I can pick a repository: find "GitHub App" (capability ID api:github-app) with capability_catalog_search, then call capability_authorization_request for it. Don't just tell me to look for it. If GitHub is already connected, the card still appears and lists my repositories. End the turn with one short final message that repeats the question from step 1 and tells me to pick a repository on the card: the chat folds text written before tool calls into a collapsed step list, so I won't see the question otherwise.
3. While I answer, read the bundled builtin:opengeni-client Skill with skill_read and follow it (it matches this deployment and is the authority for Opengeni; don't use web search for Opengeni docs, search results can be outdated): one /api/opengeni server route plus the OpenGeniChat component. Don't ask again what I already answered.
   If I attach my project's files (such as a zip) to a message, that is my code: work from them right away as in 5(a), even if GitHub isn't connected, and don't ask me to connect GitHub first. Otherwise, if I name a repository in a message instead of using the card, check right away with github_repositories_list that GitHub can reach it; if it can't, tell me in one line to grant the GitHub App access to it and, in the same reply, offer the ways forward in 5.
4. A repository gives this chat clone, push and pull request access only once it is attached to this chat. The GitHub card lists my repositories with a "Use" button: tell me to pick one there and end your turn, and don't ask me again in a separate question. Don't call wait_for_input for my answer: my next message resumes you, while an agent wait outlives my reply and keeps this chat marked as waiting for days. When my next message says to use a repository, it is attached: implement here. Only if no card appeared or I can't use it, call github_repositories_list, ask me which repository, then start a worker with session_create, passing that repository's returned resource object in resources and the full task (what to build, my answers so far, the API and organization above), plus the "${DEVELOPER_SETUP_VARIABLE_SET_NAME}" variable set (variableSetIds) when this chat has it. Whenever you start a worker, tell me in one short line what it is building and that you'll send the pull request link, then give me the worker's pull request link when it finishes.
5. If I can't connect GitHub (for example I'm not an admin of the GitHub organization, my code is on GitLab or only on my computer, or the card doesn't work for me), don't stop at "attach the repository": in the same reply, offer every way forward and let me pick: (a) I upload a zip of my project here (attach it to a message), you implement and test it in this chat's sandbox, and give me the result as a downloadable patch with the exact commands to apply it; (b) if I give you my own Git credentials for the repository (such as a deploy key or token) and say you may use them, use them for that repository only, push a branch and give me the pull request link, and suggest I revoke them afterwards; (c) use my own coding agent instead (Claude Code, Codex, Cursor or ChatGPT): give me a short prompt to paste there that installs the Opengeni plugin from https://github.com/Cloudgeni-ai/opengeni and follows its build-with-opengeni skill, and tell me to put an API key from Organization settings > Developer in my server-only .env as OPENGENI_API_KEY.
6. Work on a branch and open a pull request. Don't push to my default branch, merge or deploy without asking.`;
}

/** The deployment's public API origin, for prompts and agent context. */
export function deploymentApiOrigin(
  apiBaseUrl: string,
  location: Pick<Location, "origin" | "href">,
): string {
  try {
    return new URL(apiBaseUrl || location.origin, location.href).origin;
  } catch {
    return apiBaseUrl || location.origin;
  }
}

/** "$10" for whole amounts, "$7.25" otherwise. */
export function formatCreditAmount(amountMicros: number, currency: string): string {
  const amount = amountMicros / 1_000_000;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    ...(Number.isInteger(amount) ? { maximumFractionDigits: 0 } : {}),
  }).format(amount);
}
