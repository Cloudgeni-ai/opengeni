import type { ActionCatalogEntry } from "./action-catalog-types";

/*
 * Plain-language descriptions for catalog actions, so an agent searching the
 * catalog can tell what an action does and explain it to the person in the
 * words the app uses. They cover the Models and subscription settings
 * (subscription accounts, sharing, models, usage and resets); a test keeps
 * every such action described. The Settings guide in the bundled
 * opengeni-help Skill explains what each setting means.
 */

type Rule = {
  method: string;
  /** Matched against the path with the provider and scope segments normalized. */
  pattern: RegExp;
  text: (context: { provider: string; scope: string }) => string;
};

const PROVIDERS: Record<string, string> = {
  codex: "Codex (ChatGPT)",
  claude: "Claude",
  claude_subscription: "Claude",
  supergrok: "SuperGrok (xAI)",
};

const RULES: Rule[] = [
  {
    method: "GET",
    pattern: /\/(codex|claude|supergrok)\/accounts$/,
    text: ({ provider, scope }) =>
      `List the ${provider} subscription accounts connected ${scope}, with health, plan, primary account, whether each is used for new work, and which workspaces it serves.`,
  },
  {
    method: "PATCH",
    pattern: /\/(codex|claude|supergrok)\/accounts\/:accountId$/,
    text: ({ provider }) => `Rename a connected ${provider} subscription account.`,
  },
  {
    method: "DELETE",
    pattern: /\/(codex|claude|supergrok)\/accounts\/:accountId$/,
    text: ({ provider }) =>
      `Disconnect a ${provider} subscription account. New work stops using it; work already running finishes first. Reconnecting needs a new sign-in.`,
  },
  {
    method: "POST",
    pattern: /\/(codex|claude|supergrok)\/accounts\/:accountId\/activate$/,
    text: ({ provider }) =>
      `Make this the primary ${provider} account: the one new work uses when account picking is set to Primary only.`,
  },
  {
    method: "PATCH",
    pattern: /\/(codex|claude|supergrok)\/accounts\/:accountId\/allocator$/,
    text: ({ provider }) =>
      `Turn "Use for new work" on or off for a ${provider} account (pause or resume it). Paused accounts aren't picked for new chats or schedules; running work continues. Send the current allocator version.`,
  },
  {
    method: "PATCH",
    pattern: /\/codex\/accounts\/:accountId\/extra-credits$/,
    text: () =>
      "Turn extra-credit spending on or off for a Codex account. Off by default: when the plan's included usage runs out, work moves to another account or waits instead of spending paid credits.",
  },
  {
    method: "GET",
    pattern: /\/(codex|claude)\/accounts\/:accountId\/usage$/,
    text: ({ provider }) =>
      `Read live usage for one ${provider} account: usage-limit windows (5-hour, weekly), when they reset, extra-credit balance and, for Codex, available usage-limit resets.`,
  },
  {
    method: "POST",
    pattern: /\/(claude)\/accounts\/:accountId\/usage\/refresh$/,
    text: ({ provider }) => `Fetch fresh usage for one ${provider} account from the provider.`,
  },
  {
    method: "PATCH",
    pattern: /\/(codex|claude|supergrok)\/settings$/,
    text: ({ provider, scope }) =>
      `Choose how ${provider} accounts are picked ${scope} when several are connected: Primary only, or Spread (each new chat goes to the account with the most usage left).`,
  },
  {
    method: "POST",
    pattern: /\/(codex|supergrok)\/connect\/start$/,
    text: ({ provider, scope }) =>
      `Start connecting a ${provider} subscription ${scope} with device sign-in. Returns a short code and a link: give both to the person, who signs in at the provider and enters the code. Then poll with the returned state.`,
  },
  {
    method: "POST",
    pattern: /\/(codex|supergrok)\/connect\/poll$/,
    text: ({ provider }) =>
      `Check a ${provider} device sign-in started with connect/start. Returns pending until the person enters the code, then connected with the new account, or expired.`,
  },
  {
    method: "POST",
    pattern: /\/model-providers\/claude_subscription\/oauth\/start$/,
    text: ({ scope }) =>
      `Start connecting a Claude subscription ${scope}. This sign-in is tied to the person's own browser, so an agent can't finish it: send the person to Settings > Models.`,
  },
  {
    method: "POST",
    pattern: /\/model-providers\/claude_subscription\/oauth\/complete$/,
    text: () =>
      "Finish a Claude subscription sign-in with the code Claude showed. Only the browser that started the sign-in can finish it.",
  },
  {
    method: "POST",
    pattern: /\/claude\/accounts\/setup-token$/,
    text: ({ scope }) =>
      `Connect a Claude subscription ${scope} from a long-lived setup token the person created with Claude Code (claude setup-token).`,
  },
  {
    method: "GET",
    pattern: /\/model-connections\/:kind\/:connectionId\/access$/,
    text: ({ scope }) =>
      `Read which workspaces (including Personal workspaces) and which models a model connection can serve ${scope}, and whether the viewer may change it.`,
  },
  {
    method: "PUT",
    pattern: /\/model-connections\/:kind\/:connectionId\/access$/,
    text: () =>
      "Change which workspaces and which models a model connection can serve. Workspaces: all (optionally including Personal workspaces), selected ones, or none. Models: all including new ones, or only chosen ones. Applies to new chats and schedules; running work keeps going.",
  },
  {
    method: "GET",
    pattern: /\/model-providers\/:providerKind$/,
    text: ({ scope }) =>
      `Read the API-key model provider connection ${scope} (for example OpenAI, Anthropic API, OpenRouter, AI gateway), without the key itself.`,
  },
  {
    method: "PUT",
    pattern: /\/model-providers\/:providerKind$/,
    text: ({ scope }) =>
      `Connect or replace an API-key model provider ${scope}. The key is stored encrypted and never shown again.`,
  },
  {
    method: "DELETE",
    pattern: /\/model-providers\/:providerKind$/,
    text: ({ scope }) => `Remove an API-key model provider connection ${scope}.`,
  },
  {
    method: "GET",
    pattern: /\/model-providers\/:providerKind\/usage$/,
    text: ({ scope }) => `Read Claude subscription usage ${scope}.`,
  },
  {
    method: "POST",
    pattern: /\/model-providers\/:providerKind\/usage\/refresh$/,
    text: ({ scope }) => `Fetch fresh Claude subscription usage ${scope} from the provider.`,
  },
  {
    method: "GET",
    pattern: /\/model-providers\/:providerKind\/custom-models$/,
    text: ({ scope }) => `List custom model ids added for a provider ${scope}.`,
  },
  {
    method: "POST",
    pattern: /\/model-providers\/:providerKind\/custom-models$/,
    text: ({ scope }) =>
      `Add a custom model id for a provider ${scope}, so it appears in the model picker.`,
  },
  {
    method: "DELETE",
    pattern: /\/model-providers\/:providerKind\/custom-models\/:customModelId$/,
    text: () => "Remove a custom model id.",
  },
  {
    method: "GET",
    pattern: /\/codex\/overview$/,
    text: () =>
      "Codex overview for a workspace: connected accounts, which source it uses (organization or its own) and their status.",
  },
  {
    method: "GET",
    pattern: /\/(codex|supergrok)\/status$/,
    text: ({ provider }) => `Whether ${provider} is connected and usable in this workspace.`,
  },
  {
    method: "GET",
    pattern: /\/codex\/usage$/,
    text: () => "Codex usage across the workspace's accounts.",
  },
  {
    method: "POST",
    pattern: /\/codex\/usage\/refresh$/,
    text: () => "Fetch fresh Codex usage for the workspace's accounts.",
  },
  {
    method: "GET",
    pattern: /\/codex\/source$/,
    text: () =>
      "Whether this workspace's Codex chats use the organization's shared accounts or only the workspace's own.",
  },
  {
    method: "PATCH",
    pattern: /\/codex\/source$/,
    text: () =>
      "Switch this workspace between the organization's shared Codex accounts and its own Codex accounts.",
  },
  {
    method: "DELETE",
    pattern: /\/workspaces\/:workspaceId\/codex$/,
    text: () => "Disconnect the workspace's own Codex sign-in (legacy single-account route).",
  },
  {
    method: "POST",
    pattern: /\/codex\/apps$/,
    text: () =>
      "Choose which Codex account provides Codex Apps (connected ChatGPT apps) in this workspace.",
  },
  {
    method: "DELETE",
    pattern: /\/codex\/apps$/,
    text: () => "Turn Codex Apps off for this workspace.",
  },
  {
    method: "POST",
    pattern: /\/codex\/accounts\/:accountId\/reset-credits\/prepare$/,
    text: () =>
      "Prepare redeeming one ChatGPT usage-limit reset for a Codex account. Redeeming is irreversible and only the person who connected the account can do it, in their browser.",
  },
  {
    method: "POST",
    pattern: /\/codex\/accounts\/:accountId\/reset-credits\/redeem$/,
    text: () =>
      "Redeem a prepared ChatGPT usage-limit reset. Irreversible; needs the person's browser confirmation.",
  },
  {
    method: "GET",
    pattern: /\/sessions\/:sessionId\/codex-accounts$/,
    text: () => "List the Codex accounts a session may be pinned to.",
  },
  {
    method: "POST",
    pattern: /\/sessions\/:sessionId\/codex-account$/,
    text: () =>
      "Pin a session to one Codex account, or clear the pin so the workspace's picking rule applies again.",
  },
  {
    method: "POST",
    pattern: /\/sessions\/:sessionId\/realtime\/supergrok$/,
    text: () => "Start a SuperGrok realtime voice connection for a session.",
  },
];

/** Actions that must carry a description (subscription and model settings). */
export const DESCRIBED_ACTION_PATH =
  /\/(codex|claude|supergrok)(\/|$)|\/model-providers\/|\/model-connections\//;

function scopeOf(path: string): string {
  return path.startsWith("/v1/organizations/") ? "for the organization" : "in a workspace";
}

function providerOf(path: string): string {
  const match = path.match(/\/(codex|claude_subscription|claude|supergrok)(\/|$)/);
  return match ? PROVIDERS[match[1]!]! : "subscription";
}

export function actionDescription(
  entry: Pick<ActionCatalogEntry, "method" | "path">,
): string | undefined {
  const rule = RULES.find(
    (candidate) => candidate.method === entry.method && candidate.pattern.test(entry.path),
  );
  return rule?.text({ provider: providerOf(entry.path), scope: scopeOf(entry.path) });
}
