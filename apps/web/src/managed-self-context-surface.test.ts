import { describe, expect, test } from "bun:test";

const contextSource = await Bun.file(`${import.meta.dir}/context.tsx`).text();
const switcherSource = await Bun.file(
  `${import.meta.dir}/components/rail/switcher-block.tsx`,
).text();
const settingsSource = await Bun.file(`${import.meta.dir}/routes/workspace-settings.tsx`).text();
const organizationSource = await Bun.file(`${import.meta.dir}/routes/org-settings.tsx`).text();

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
  });

  test("replaces personal member management with owner-only guidance", () => {
    expect(settingsSource).toContain(
      "isPersonalWorkspace(activeWorkspace, context.managedSelfContext)",
    );
    expect(settingsSource).toContain("personal ? (");
    expect(settingsSource).toContain("administrators and other members do not gain access");
    expect(settingsSource).toContain("<MembersSection workspaceId={workspaceId}");
  });

  test("separates organization administration from Personal content", () => {
    expect(organizationSource).toContain(
      "Organization roles govern administration and billing. They do not grant access to",
    );
    expect(organizationSource).toContain(
      "Organization roles control tenant administration, not personal content.",
    );
    expect(organizationSource).toContain("personalWorkspace={personal}");
  });
});
