/* URL state for Organization settings > Models, shared by the router and the
   page. Every model setting lives on that one page; the list, an account's
   page, a workspace's model page and each form are addressed by its URL, so
   Back, reload and shared links land on the same page:
     ?section=models                                     accounts, workspaces, settings
     ?section=models&account=org:codex:<id>              an organization account's page
     ?section=models&view=connect                        Connect account
     ?section=models&view=connect-org:codex              one provider's step
     ?section=models&view=credits                        Opengeni credits: balance and buying
     ?section=models&workspace=<id>                      one workspace's model page
     ?section=models&workspace=<id>&account=codex:<id>   an account owned by that workspace
     ?section=models&workspace=<id>&view=connect:codex   connect one for that workspace only
     ?section=models&workspace=<id>&view=allowed-models  its Allowed models (form page)
     ?section=models&account=...&view=model-access       Models an account can serve

   `workspace` also names the workspace a page was opened from, so an
   organization account or Connect account opened there returns to it.
   A workspace's old Settings > Models URL redirects here (workspaceModelsRedirect). */

export type ModelsProvider =
  | "codex"
  | "supergrok"
  | "vercel"
  | "openrouter"
  | "anthropic"
  | "claude_subscription";

export type ModelsView =
  | "connect"
  | "connect-workspace"
  | `connect:${ModelsProvider}`
  | `connect-org:${ModelsProvider}`
  | "allowed-models"
  | "model-access"
  | "credits";

const PROVIDERS: readonly ModelsProvider[] = [
  "codex",
  "supergrok",
  "vercel",
  "openrouter",
  "anthropic",
  "claude_subscription",
];

const VIEWS: ReadonlySet<string> = new Set<ModelsView>([
  "connect",
  "connect-workspace",
  ...PROVIDERS.map((provider) => `connect:${provider}` as const),
  ...PROVIDERS.map((provider) => `connect-org:${provider}` as const),
  "allowed-models",
  "model-access",
  "credits",
]);

export function parseModelsView(value: unknown): ModelsView | undefined {
  return typeof value === "string" && VIEWS.has(value) ? (value as ModelsView) : undefined;
}

const ACCOUNT_KEY =
  /^(org:)?((codex|supergrok):[\w-]{1,128}|gateway:(vercel|openrouter|anthropic|claude_subscription))$/;

export function parseModelsAccount(value: unknown): string | undefined {
  return typeof value === "string" && ACCOUNT_KEY.test(value) ? value : undefined;
}

export type GatewayId = "vercel" | "openrouter" | "anthropic" | "claude_subscription";

export type AccountKey = (
  | { provider: "codex" | "supergrok"; id: string }
  | { provider: "gateway"; id: GatewayId }
) & {
  /** An organization account ("Everyone in <organization>"), not this workspace's own. */
  organization: boolean;
};

export function accountKeyOf(value: string | undefined): AccountKey | null {
  if (!value) return null;
  const organization = value.startsWith("org:");
  const rest = organization ? value.slice("org:".length) : value;
  const [provider, id] = rest.split(":", 2) as [string, string];
  if ((provider === "codex" || provider === "supergrok") && id) {
    return { provider, id, organization };
  }
  if (
    provider === "gateway" &&
    (id === "vercel" || id === "openrouter" || id === "anthropic" || id === "claude_subscription")
  ) {
    return { provider, id, organization };
  }
  return null;
}

/** The account key for a row: `codex:<id>`, or `org:codex:<id>` for an organization account. */
export function accountKey(
  provider: "codex" | "supergrok" | "gateway",
  id: string,
  organization = false,
): string {
  return `${organization ? "org:" : ""}${provider}:${id}`;
}

/** The provider a connect step is for, and whether it connects for the organization. */
export function connectStepOf(
  view: ModelsView | undefined,
): { provider: ModelsProvider; organization: boolean } | null {
  if (!view) return null;
  if (view.startsWith("connect-org:")) {
    return { provider: view.slice("connect-org:".length) as ModelsProvider, organization: true };
  }
  if (view.startsWith("connect:")) {
    return { provider: view.slice("connect:".length) as ModelsProvider, organization: false };
  }
  return null;
}

/**
 * A workspace's Settings > Models URL now opens that workspace's page in
 * Organization settings > Models, keeping the account or form it pointed at.
 */
export function workspaceModelsRedirect(input: {
  workspaceId: string;
  account: string | undefined;
  view: ModelsView | undefined;
}): { section: "models"; workspace: string; account?: string; view?: ModelsView } {
  return {
    section: "models",
    workspace: input.workspaceId,
    ...(input.account ? { account: input.account } : {}),
    // The workspace-only picker is Connect account now.
    ...(input.view ? { view: input.view === "connect-workspace" ? "connect" : input.view } : {}),
  };
}

/**
 * Organization > Models without `?workspace=` is the organization's own page.
 * Links saved from the old organization Models page named its accounts and
 * connect steps without the "org:" mark; read them as the organization's.
 * Every link into a workspace's page carries `workspace`, so nothing is lost.
 */
export function organizationModelsSearch(input: {
  workspace: string | undefined;
  account: string | undefined;
  view: ModelsView | undefined;
}): { account: string | undefined; view: ModelsView | undefined } {
  if (input.workspace) return { account: input.account, view: input.view };
  const key = accountKeyOf(input.account);
  const step = connectStepOf(input.view);
  return {
    account: key && !key.organization ? accountKey(key.provider, key.id, true) : input.account,
    view: step && !step.organization ? `connect-org:${step.provider}` : input.view,
  };
}
