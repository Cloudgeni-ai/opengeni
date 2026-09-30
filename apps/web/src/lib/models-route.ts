/* URL state for Settings > Models, shared by the router and the page. The
   list, an account's page and each form are addressed by the settings URL, so
   Back, reload and shared links land on the same page:
     ?section=models                                  the list
     ?section=models&account=codex:<id>               a workspace account's page
     ?section=models&account=org:codex:<id>           an organization account's page
     ?section=models&view=connect                     Connect account (for everyone, or
                                                      this workspace when that's all you can do)
     ?section=models&view=connect-workspace           Connect for this workspace only
     ?section=models&view=connect:codex               one provider's step, for this workspace
     ?section=models&view=connect-org:codex           one provider's step, for everyone
     ?section=models&view=allowed-models              Allowed models (form page)
     ?section=models&account=...&view=model-access    Models an account can serve

   The organization's own Models URL (Organization settings > Models) redirects
   here, mapping its account and view to the organization forms above. */

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
  | "model-access";

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
 * Organization settings > Models used to be its own page. It redirects to the
 * one Models page: the list stays the list, an account keeps its page (now an
 * organization account key) and a connect step keeps its step (for everyone).
 */
export function organizationModelsRedirect(input: {
  account: string | undefined;
  view: ModelsView | undefined;
}): { account?: string; view?: ModelsView } {
  const key = input.account ? accountKeyOf(input.account) : null;
  const account = key ? accountKey(key.provider, key.id, true) : undefined;
  const step = connectStepOf(input.view);
  const view: ModelsView | undefined = step
    ? `connect-org:${step.provider}`
    : input.view === "model-access" && account
      ? "model-access"
      : input.view === "connect"
        ? "connect"
        : undefined;
  return { ...(account ? { account } : {}), ...(view ? { view } : {}) };
}
