/* URL state for organization settings pages other than Models. A person, a
   workspace and each form are addressed by the URL, so Back, reload and shared
   links land on the same page:
     ?section=people                          the People list
     ?section=people&person=<membership id>   a person's page
     ?section=people&invitation=<id>          an invitation's page
     ?section=people&view=invite              Invite people
     ?section=workspaces                      the Workspaces list
     ?section=workspaces&workspace=<id>       a workspace's page
     ?section=workspaces&view=new-workspace   New workspace
     ?section=developer&view=new-key          Create API key
     ?section=integrations&view=new-connector Add connector
     ?section=integrations&connector=<id>     an organization connector's page
     ?section=integrations&connector=<id>&view=available-in   its Available in
     ?section=integrations&connector=<id>&view=replace-key    Replace key */

export type OrganizationView = "invite" | "new-workspace" | "new-key";

export function parseOrganizationView(value: unknown): OrganizationView | undefined {
  return value === "invite" || value === "new-workspace" || value === "new-key" ? value : undefined;
}

/** Integrations: Add connector, or a form on a connector's page. */
export type ConnectorView = "new-connector" | "available-in" | "replace-key";

export function parseConnectorView(value: unknown): ConnectorView | undefined {
  return value === "new-connector" || value === "available-in" || value === "replace-key"
    ? value
    : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** An organization connector's id. */
export function parseConnectorParam(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;
}

/**
 * Where Integrations is: the list, Add connector, a connector's page, or one
 * of its forms. A form for a connector needs that connector; Add connector
 * needs none.
 */
export type ConnectorLocation =
  | { kind: "list" }
  | { kind: "new" }
  | { kind: "connector"; connectorId: string; view: "page" | "available-in" | "replace-key" };

export function connectorLocation(input: {
  connector?: string | undefined;
  view?: ConnectorView | undefined;
}): ConnectorLocation {
  if (input.connector)
    return {
      kind: "connector",
      connectorId: input.connector,
      view: input.view === "available-in" || input.view === "replace-key" ? input.view : "page",
    };
  return input.view === "new-connector" ? { kind: "new" } : { kind: "list" };
}

const RECORD_ID = /^[\w:.-]{1,128}$/;

export function parseOrganizationRecordId(value: unknown): string | undefined {
  return typeof value === "string" && RECORD_ID.test(value) ? value : undefined;
}
