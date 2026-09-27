/* URL state for organization settings pages other than Models. A person, a
   workspace and each form are addressed by the URL, so Back, reload and shared
   links land on the same page:
     ?section=people                          the People list
     ?section=people&person=<membership id>   a person's page
     ?section=people&invitation=<id>          an invitation's page
     ?section=people&view=invite              Invite people
     ?section=workspaces                      the Workspaces list
     ?section=workspaces&workspace=<id>       a workspace's page
     ?section=workspaces&view=new-workspace   New workspace */

export type OrganizationView = "invite" | "new-workspace";

export function parseOrganizationView(value: unknown): OrganizationView | undefined {
  return value === "invite" || value === "new-workspace" ? value : undefined;
}

const RECORD_ID = /^[\w:.-]{1,128}$/;

export function parseOrganizationRecordId(value: unknown): string | undefined {
  return typeof value === "string" && RECORD_ID.test(value) ? value : undefined;
}
