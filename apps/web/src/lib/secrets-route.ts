/**
 * Search params of the Secrets list route:
 *
 *   ?view=new                                  New vault
 *   ?view=connect-1password[&owner=user]       Connect a 1Password service account
 *   ?connection=<id>                           A 1Password connection's page
 *   ?connection=<id>&view=choose-vaults        Link or unlink its vaults
 *   ?connection=<id>&view=replace-token        Paste a new token for it
 */
export type SecretsIndexView = "new" | "connect-1password" | "choose-vaults" | "replace-token";
export type SecretsConnectOwner = "user" | "workspace" | "organization";

export type SecretsIndexSearch = {
  view?: SecretsIndexView;
  connection?: string;
  owner?: SecretsConnectOwner;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_VIEWS = new Set<unknown>(["new", "connect-1password"]);
const CONNECTION_VIEWS = new Set<unknown>(["choose-vaults", "replace-token"]);
const OWNERS = new Set<unknown>(["user", "workspace", "organization"]);

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
  return view === "connect-1password" && OWNERS.has(search.owner)
    ? { view, owner: search.owner as SecretsConnectOwner }
    : { view };
}
