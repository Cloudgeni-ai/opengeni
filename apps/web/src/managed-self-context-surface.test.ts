import { describe, expect, test } from "bun:test";

const contextSource = await Bun.file(`${import.meta.dir}/context.tsx`).text();
const switcherSource = await Bun.file(
  `${import.meta.dir}/components/rail/workspace-switcher.tsx`,
).text();
const settingsSource = await Bun.file(`${import.meta.dir}/routes/workspace-settings.tsx`).text();
const organizationSource = await Bun.file(`${import.meta.dir}/routes/org-settings.tsx`).text();
const organizationShellSource = await Bun.file(
  `${import.meta.dir}/components/settings/organization-settings-pages.ts`,
).text();
const peoplePageSource = await Bun.file(
  `${import.meta.dir}/components/organization/people-page.tsx`,
).text();

describe("managed self-context surfaces", () => {
  test("loads the managed-only projection behind the credential/principal identity fence", () => {
    expect(contextSource).toContain("client.listOrganizationMemberships()");
    expect(contextSource).toContain("loadCurrentManagedSelfContext({");
    expect(contextSource).toContain("credentialGeneration: accessKeyVersion");
    expect(contextSource).toContain(
      "context.subjectId !== nextManagedSelfContext.identity.subjectId",
    );
    expect(contextSource).toContain("managedSelfContextIdentityRef.current = null");
  });

  test("labels switcher entries and their accessible names from the exact helper", () => {
    expect(switcherSource).toContain(
      "isPersonalWorkspace(activeWorkspace, context.managedSelfContext)",
    );
    expect(switcherSource).toContain("export function WorkspaceMenuItemContent");
    expect(switcherSource).toContain(
      "isPersonalWorkspace(props.workspace, props.managedSelfContext)",
    );
    expect(switcherSource).not.toContain(
      "aria-label={personal ? `${workspace.name}, Personal workspace`",
    );
    expect(switcherSource).toContain('<span className="sr-only"> Paused</span>');
    expect(switcherSource.match(/<PersonalWorkspaceBadge/g)?.length).toBeGreaterThanOrEqual(2);
    expect(switcherSource).toContain("workspaces={context.workspaces}");
    expect(switcherSource).toContain("export const WorkspaceSwitcherTrigger = forwardRef");
    expect(switcherSource).toContain("{props.collapsed ? (");
    expect(switcherSource).toContain('<span className="inline-flex">{trigger}</span>');
    expect(switcherSource).not.toContain("<TooltipTrigger asChild>{trigger}</TooltipTrigger>");
    expect(switcherSource).not.toContain(
      "<TooltipTrigger asChild>\n          <DropdownMenuTrigger asChild>{props.children}</DropdownMenuTrigger>",
    );
  });

  test("replaces personal member management with owner-only guidance", () => {
    expect(settingsSource).toContain(
      "isPersonalWorkspace(activeWorkspace, context.managedSelfContext)",
    );
    expect(settingsSource).toContain("personal ? (");
    expect(settingsSource).toContain("administrators and other members do not gain access");
    expect(settingsSource).toContain('import("./workspace-members-section")');
    expect(settingsSource).toContain(
      "<LazyMembersSection\n              workspaceId={workspaceId}",
    );
  });

  test("separates organization administration from Personal content", () => {
    expect(organizationShellSource).toContain(
      "`Everyone in ${organizationName}, with one role each and a private Personal workspace.`",
    );
    expect(organizationShellSource).toContain(
      "`Shared workspaces in ${organizationName}. Everyone also has a private Personal workspace.`",
    );
    expect(peoplePageSource).toContain(
      "Nobody else can open it, including owners and\n        admins.",
    );
    expect(organizationSource).toContain("<OrganizationPeoplePage");
    // Retention lives on the Security & data page.
    expect(organizationSource).toContain("<OrganizationSecurityPage");
  });
});
