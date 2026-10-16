/**
 * Search params of the Secrets list route:
 *
 *   ?view=new                                  New vault
 *   ?view=connect                              Choose a password manager to connect
 *   ?view=connect-1password[&owner=user]       Connect a 1Password service account
 *   ?view=connect-<provider>[&owner=user]      Connect Proton Pass, Keeper, Bitwarden or your own service
 *   ?connection=<id>                           A password manager connection's page
 *   ?connection=<id>&view=choose-vaults        Link or unlink its vaults
 *   ?connection=<id>&view=replace-token        Renew its access (token, device or bridge)
 */
export type SecretsConnectProvider = "protonpass" | "keeper" | "bitwarden" | "external";
export type SecretsIndexView =
  | "new"
  | "connect"
  | "connect-1password"
  | `connect-${SecretsConnectProvider}`
  | "choose-vaults"
  | "replace-token";
export type SecretsConnectOwner = "user" | "workspace" | "organization";

export type SecretsIndexSearch = {
  view?: SecretsIndexView;
  connection?: string;
  owner?: SecretsConnectOwner;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONNECT_PROVIDERS: readonly SecretsConnectProvider[] = [
  "protonpass",
  "keeper",
  "bitwarden",
  "external",
];
const CONNECT_VIEWS = new Set<unknown>([
  "connect-1password",
  ...CONNECT_PROVIDERS.map((provider) => `connect-${provider}`),
]);
const LIST_VIEWS = new Set<unknown>(["new", "connect", ...CONNECT_VIEWS]);
const CONNECTION_VIEWS = new Set<unknown>(["choose-vaults", "replace-token"]);
const OWNERS = new Set<unknown>(["user", "workspace", "organization"]);

/** The provider a connect-<provider> view sets up, other than 1Password; else undefined. */
export function connectViewProvider(view: unknown): SecretsConnectProvider | undefined {
  if (typeof view !== "string" || !view.startsWith("connect-")) return undefined;
  const provider = view.slice("connect-".length);
  return (CONNECT_PROVIDERS as readonly string[]).includes(provider)
    ? (provider as SecretsConnectProvider)
    : undefined;
}

export function parseSecretsIndexSearch(search: Record<string, unknown>): SecretsIndexSearch {
  const connection =
    typeof search.connection === "string" && UUID.test(search.connection)
      ? search.connection.toLowerCase()
      : undefined;
  if (connection) {
    return CONNECTION_VIEWS.has(search.view)
      ? { connection, view: search.view as SecretsIndexView }
      : { connection };
  }
  if (!LIST_VIEWS.has(search.view)) return {};
  const view = search.view as SecretsIndexView;
  return CONNECT_VIEWS.has(view) && OWNERS.has(search.owner)
    ? { view, owner: search.owner as SecretsConnectOwner }
    : { view };
}
