/* URL state for Settings > Models, shared by the router and the page. The
   list, an account's page and each form are addressed by the settings URL, so
   Back, reload and shared links land on the same page:
     ?section=models                               the list
     ?section=models&account=codex:<id>            an account's page
     ?section=models&view=connect                  Connect a model account
     ?section=models&view=allowed-models           Allowed models (form page)
     ?section=models&account=...&view=model-access  Models an account can serve */

export type ModelsView =
  | "connect"
  | "connect:codex"
  | "connect:supergrok"
  | "connect:vercel"
  | "connect:anthropic"
  | "connect:claude_subscription"
  | "connect:openrouter"
  | "allowed-models"
  | "model-access";

const VIEWS: readonly ModelsView[] = [
  "connect",
  "connect:codex",
  "connect:supergrok",
  "connect:vercel",
  "connect:openrouter",
  "connect:anthropic",
  "connect:claude_subscription",
  "allowed-models",
  "model-access",
];

export function parseModelsView(value: unknown): ModelsView | undefined {
  return VIEWS.includes(value as ModelsView) ? (value as ModelsView) : undefined;
}

const ACCOUNT_KEY =
  /^(codex|supergrok):[\w-]{1,128}$|^gateway:(vercel|openrouter|anthropic|claude_subscription)$/;

export function parseModelsAccount(value: unknown): string | undefined {
  return typeof value === "string" && ACCOUNT_KEY.test(value) ? value : undefined;
}

export type AccountKey =
  | { provider: "codex" | "supergrok"; id: string }
  | { provider: "gateway"; id: "vercel" | "openrouter" | "anthropic" | "claude_subscription" };

export function accountKeyOf(value: string | undefined): AccountKey | null {
  if (!value) return null;
  const [provider, id] = value.split(":", 2) as [string, string];
  if (provider === "codex" || provider === "supergrok") return { provider, id };
  if (
    provider === "gateway" &&
    (id === "vercel" || id === "openrouter" || id === "anthropic" || id === "claude_subscription")
  ) {
    return { provider, id };
  }
  return null;
}
