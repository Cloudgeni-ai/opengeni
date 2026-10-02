import { coerceReasoningEffortForModel } from "@opengeni/react";
import type { ReasoningEffort, ResourceRef, WorkspaceModelCatalogResponse } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import { DEVELOPER_PLUGIN } from "./coding-agent-install";
import { API_KEY_ENV_VAR, MANAGED_API_ORIGIN, type BuildTarget } from "./coding-agent-setup";
import type { OnboardingIntent } from "./onboarding-journey";

/**
 * First run after sign-in: what Opengeni is for (agents in your product, or
 * agents for your own work), then for a product whether there is one yet and
 * what it is, then a moment that says what the person got (the trial credits)
 * and drops them into a chat. Everything entered is kept as the person goes
 * (in the first-run journey) and becomes one prompt: the first chat's message,
 * the prompt to paste into a coding agent, or, after Skip, the new chat's
 * draft.
 */

export const FIRST_AGENT_USES = ["product", "work"] as const;
/** Agents in the person's product, or agents for their own work. */
export type FirstAgentUse = (typeof FIRST_AGENT_USES)[number];

export const FIRST_AGENT_PRODUCT_ANSWERS = ["have", "explore"] as const;
/** For a product: one exists to tell us about, or the person explores first. */
export type FirstAgentProductAnswer = (typeof FIRST_AGENT_PRODUCT_ANSWERS)[number];

export const FIRST_AGENT_BUILDERS = ["opengeni", "own"] as const;
export type FirstAgentBuilder = (typeof FIRST_AGENT_BUILDERS)[number];

/**
 * A repository picked on the page: what to show, and what to attach to the
 * chat. A repository from the person's own GitHub has no resource here: its
 * access is chosen when it is attached in the chat.
 */
export type FirstAgentRepository = Readonly<{
  fullName: string;
  url: string;
  resource: Extract<ResourceRef, { kind: "repository" }> | null;
}>;

export const FIRST_AGENT_OUTCOMES = ["session", "own_agent", "chat", "app", "skipped"] as const;
/**
 * How first run ended: the building chat it started, the person's own coding
 * agent, a suggested first chat, the app, or Skip.
 */
export type FirstAgentOutcome = (typeof FIRST_AGENT_OUTCOMES)[number];

export type FirstAgentAnswers = Readonly<{
  use: FirstAgentUse | null;
  product: FirstAgentProductAnswer | null;
  website: string;
  repository: FirstAgentRepository | null;
  task: string;
  builder: FirstAgentBuilder | null;
  outcome: FirstAgentOutcome | null;
}>;

export const EMPTY_FIRST_AGENT: FirstAgentAnswers = {
  use: null,
  product: null,
  website: "",
  repository: null,
  task: "",
  builder: null,
  outcome: null,
};

const MAX_TEXT = 2_000;
const MAX_URL = 500;

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function parseRepository(value: unknown): FirstAgentRepository | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const resource = record.resource as Record<string, unknown> | undefined;
  if (
    typeof record.fullName !== "string" ||
    record.fullName.length > 200 ||
    typeof record.url !== "string" ||
    record.url.length > MAX_URL
  )
    return null;
  const attachable =
    resource &&
    typeof resource === "object" &&
    resource.kind === "repository" &&
    typeof resource.uri === "string" &&
    typeof resource.ref === "string";
  return {
    fullName: record.fullName,
    url: record.url,
    resource: attachable ? (resource as NonNullable<FirstAgentRepository["resource"]>) : null,
  };
}

/** A stored answer set, dropping anything that is not exactly our shape. */
export function parseFirstAgentAnswers(value: unknown): FirstAgentAnswers {
  if (!value || typeof value !== "object") return EMPTY_FIRST_AGENT;
  const record = value as Record<string, unknown>;
  return {
    use: isOneOf(FIRST_AGENT_USES, record.use) ? record.use : null,
    product: isOneOf(FIRST_AGENT_PRODUCT_ANSWERS, record.product) ? record.product : null,
    website: text(record.website, MAX_URL),
    repository: parseRepository(record.repository),
    task: text(record.task, MAX_TEXT),
    builder: isOneOf(FIRST_AGENT_BUILDERS, record.builder) ? record.builder : null,
    outcome: isOneOf(FIRST_AGENT_OUTCOMES, record.outcome) ? record.outcome : null,
  };
}

/** The Get started path each answer stands for. */
export function intentsForUse(use: FirstAgentUse | null): OnboardingIntent[] {
  return use === "product" ? ["build"] : use === "work" ? ["cloud"] : [];
}

/** The answer an earlier path choice (or a Product Hunt visit) stands for. */
export function useForIntents(intents: readonly OnboardingIntent[]): FirstAgentUse | null {
  if (intents.includes("build")) return "product";
  if (intents.includes("cloud") || intents.includes("explore")) return "work";
  return null;
}

/** The product's answers are what the first chat builds from. */
export function buildsProduct(answers: FirstAgentAnswers): boolean {
  return answers.use === "product" && answers.product === "have" && hasAnyProductAnswer(answers);
}

/**
 * "acme.com" or "https://acme.com/pricing" as an absolute http(s) URL, or null
 * when it can't be one. Empty input is not an error: the field is optional.
 */
export function normalizeWebsite(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/\s/u.test(trimmed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

/** Whether the product answers say enough to start building. */
export function hasProductDetails(answers: FirstAgentAnswers): boolean {
  return Boolean(normalizeWebsite(answers.website) || answers.repository);
}

/** Whether anything was entered that a first chat could use. */
export function hasAnyProductAnswer(answers: FirstAgentAnswers): boolean {
  return Boolean(answers.website.trim() || answers.repository || answers.task.trim());
}

/** Example jobs for "What should the agent do in your product?". */
export const FIRST_AGENT_TASKS: ReadonlyArray<Readonly<{ label: string; task: string }>> = [
  {
    label: "Support agent",
    task: "Answer customer questions in the product, using our docs and the customer's account, and hand off to a person when it can't help.",
  },
  {
    label: "Analyst over customer data",
    task: "Let customers ask questions about their own data in plain language and get answers with charts.",
  },
  {
    label: "Operations agent",
    task: "Take on routine operations work for our team: triage incoming requests, update records and report what it did.",
  },
  {
    label: "Onboarding guide",
    task: "Guide new users through setting up the product and do the setup steps for them.",
  },
];

function productFacts(answers: FirstAgentAnswers, repositoryLine: string | null): string[] {
  const website = normalizeWebsite(answers.website);
  // A product isn't always a website: anything else entered is named as is.
  const product = answers.website.trim();
  const task = answers.task.trim();
  return [
    website ? `- Website: ${website}` : product ? `- Product: ${product}` : null,
    repositoryLine,
    task ? `- What the agent should do: ${task}` : "- What the agent should do: not decided yet",
  ].filter((line): line is string => line !== null);
}

/** The first line of every prompt this page writes into a chat. */
export const OPENGENI_PROMPT_OPENING = "I want to add an AI agent to my product with Opengeni.";

/**
 * The first message of an Opengeni chat that builds the agent into the
 * product (and the new chat's draft after Skip). The repository, when picked,
 * is attached to the chat.
 */
export function composeOpengeniPrompt(answers: FirstAgentAnswers): string {
  const repository = answers.repository;
  const attached = Boolean(repository?.resource);
  const task = answers.task.trim();
  const lines = [
    OPENGENI_PROMPT_OPENING,
    "",
    ...productFacts(
      answers,
      repository
        ? `- Code: ${repository.fullName} on GitHub${attached ? " (attached to this chat)" : ""}`
        : null,
    ),
    "",
    [
      `First, look at ${
        repository && normalizeWebsite(answers.website)
          ? "the website and the repository"
          : repository
            ? "the repository"
            : normalizeWebsite(answers.website)
              ? "the website"
              : "what I told you"
      } to understand what the product does and who uses it.`,
      task
        ? "Then propose two or three ways the agent could work in the product and recommend one."
        : "Then propose two or three places an agent would help most and recommend one.",
    ].join(" "),
    attached
      ? "Once I agree, implement the integration in the repository on a new branch: the product's server calls Opengeni with an API key kept on the server, and the product shows the agent where its users need it. Run the tests and open a pull request."
      : "Once I agree, tell me what to connect so you can implement it (the GitHub repository, if it isn't attached), and outline the integration: the product's server calls Opengeni with an API key kept on the server, and the product shows the agent where its users need it.",
  ];
  return lines.join("\n");
}

/**
 * What to paste into the person's own coding agent: the Opengeni developer
 * skills, the product answers and this organization's IDs. The key is made on
 * the page, so setup only has to use it.
 */
export function composeCodingAgentPrompt(answers: FirstAgentAnswers, target: BuildTarget): string {
  const { setup, client } = DEVELOPER_PLUGIN.skills;
  const baseUrl =
    target.apiOrigin === MANAGED_API_ORIGIN ? "" : ` (OPENGENI_API_BASE_URL=${target.apiOrigin})`;
  const repository = answers.repository;
  return [
    `Use the ${setup} and ${client} skills to add an Opengeni agent to my product.`,
    "",
    ...productFacts(
      answers,
      repository
        ? `- Code: ${repository.fullName} (${repository.url}); work in your local checkout of it`
        : "- Code: this project",
    ),
    "",
    "Look at the code and the website to understand the product, propose where the agent fits best and confirm it with me. Then implement it: the product's server calls Opengeni with the API key, and the product shows the agent where its users need it.",
    `Use the existing workspace ${target.workspaceId} in organization ${target.organizationId}${baseUrl}. I'll paste the API key into .env as ${API_KEY_ENV_VAR}; never put it in client code.`,
    "When it runs, send one test message through the product so I can see it arrive in Opengeni.",
  ].join("\n");
}

/**
 * The model first chats start on: GPT-6 Luna at extra high reasoning, billed
 * in Opengeni credits, when the workspace can run it (the organization holds
 * credits). Null otherwise: then the draft keeps the default it has.
 */
export function firstChatModel(
  catalog: Pick<WorkspaceModelCatalogResponse, "models">,
): { id: string; reasoningEffort: ReasoningEffort } | null {
  const luna = catalog.models.find(
    (model) =>
      /(?:^|\/)gpt-6-luna$/u.test(model.id) &&
      model.cost === "credits" &&
      model.availability.selectable,
  );
  return luna
    ? { id: luna.id, reasoningEffort: coerceReasoningEffortForModel(luna, "xhigh") }
    : null;
}

/**
 * Prepares a workspace's new-chat draft, so the new-chat page opens ready:
 * GPT-6 Luna at extra high reasoning when credits can pay for it, and the
 * message (and repository) when there is one. A message the person already
 * typed is left alone unless `replace` is set (it is, for a chat the person
 * just asked to start); an earlier prompt from this page is replaced. Returns
 * whether the message went in.
 */
export async function writeFirstChatDraft(
  client: Pick<
    OpenGeniBrowserClient,
    "getNewSessionDraft" | "saveNewSessionDraft" | "getWorkspaceModelCatalog"
  >,
  workspaceId: string,
  message: string | null,
  {
    repository = null,
    replace = false,
  }: {
    repository?: FirstAgentRepository["resource"] | null;
    replace?: boolean;
  } = {},
): Promise<boolean> {
  const [draft, model] = await Promise.all([
    client.getNewSessionDraft(workspaceId),
    client
      .getWorkspaceModelCatalog(workspaceId)
      .then(firstChatModel)
      // The model is a convenience: an unreadable catalog keeps the default.
      .catch(() => null),
  ]);
  const typed = draft.text.trim();
  const writeMessage =
    message !== null && (replace || !typed || typed.startsWith(OPENGENI_PROMPT_OPENING));
  const resources =
    writeMessage && repository
      ? [
          ...draft.resources.filter(
            (resource) => resource.kind !== "repository" || resource.uri !== repository.uri,
          ),
          repository,
        ]
      : draft.resources;
  if (!writeMessage && !model) return false;
  await client.saveNewSessionDraft(workspaceId, {
    text: writeMessage ? message : draft.text,
    resources,
    tools: draft.tools,
    toolsProvided: draft.toolsProvided,
    ...(model
      ? { model: model.id, reasoningEffort: model.reasoningEffort, modelProvided: true }
      : {
          model: draft.model,
          reasoningEffort: draft.reasoningEffort,
          ...(draft.modelProvided !== undefined ? { modelProvided: draft.modelProvided } : {}),
        }),
    latencyMode: draft.latencyMode,
    ...(draft.selectedProjectChannelId !== undefined
      ? { selectedProjectChannelId: draft.selectedProjectChannelId }
      : {}),
    options: draft.options,
    expectedRevision: draft.revision,
  });
  return writeMessage;
}
