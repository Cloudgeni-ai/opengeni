import { describe, expect, test } from "bun:test";

const routeSource = await Bun.file(`${import.meta.dir}/routes/org-settings.tsx`).text();
const adminSource = await Bun.file(`${import.meta.dir}/components/organization-admin.tsx`).text();
const shellSource = await Bun.file(
  `${import.meta.dir}/components/settings/organization-settings-shell.tsx`,
).text();
const tenancyDocs = await Bun.file(
  `${import.meta.dir}/../../../docs/organization-tenancy.md`,
).text();

describe("organization administration surface", () => {
  test("routes accessible overview, people, retention, and billing sections", () => {
    expect(routeSource).toContain("<OrganizationSettingsShell");
    expect(shellSource).toContain('aria-label="Organization settings"');
    expect(shellSource).toContain('aria-current={selected ? "page" : undefined}');
    for (const section of ["overview", "people", "retention", "billing"]) {
      expect(shellSource).toContain(`id: "${section}"`);
    }
  });

  test("uses only lifecycle APIs and never links a member personal workspace", () => {
    for (const method of [
      "listOrganizationAdministrationMembers",
      "listOrganizationInvitationsForOrganization",
      "createOrganizationInvitation",
      "revokeOrganizationInvitation",
      "listOrganizationInvitations",
      "acceptOrganizationInvitation",
      "updateOrganizationMember",
      "updateOrganizationWorkspace",
      "putOrganizationWorkspaceMember",
      "revokeOrganizationWorkspaceMember",
      "getOrganizationRetentionPolicy",
      "updateOrganizationRetentionPolicy",
    ]) {
      expect(adminSource).toContain(`.${method}(`);
    }
    for (const helper of [
      "getOrganizationPrivateSessionSettings",
      "updateOrganizationPrivateSessionSettings",
    ]) {
      expect(adminSource).toContain(`${helper}(`);
    }
    expect(adminSource).not.toContain("personalWorkspaceId");
    expect(adminSource).toContain("member.name?.trim()");
    expect(adminSource).toContain("member.email");
    expect(adminSource).toContain("Add organization member");
    expect(adminSource).toContain("Custom permissions…");
    expect(adminSource).toContain("Personal content stays personal");
    expect(adminSource).not.toContain(".addWorkspaceMember(");
    expect(adminSource).not.toContain(".removeWorkspaceMember(");
    expect(adminSource).toContain("props.onAuthorityChanged()");
  });

  test("names destructive consequences and restores keyboard focus", () => {
    expect(adminSource).toContain("This immediately pauses organization access");
    expect(adminSource).toContain(
      "Shared-workspace access removed when access was paused is not restored",
    );
    expect(adminSource).toContain("Removing a member is permanent");
    expect(adminSource).toContain("restoreFocusRef={actionTriggerRef}");
    expect(adminSource).toContain("restoreFocusFallbackRef={peopleHeadingRef}");
    expect(adminSource).toContain('aria-live="polite"');
    expect(adminSource).toContain("disabled={visibleBusyResource !== null || incoming.loading}");
  });

  test("handles CAS conflicts by refreshing without replaying the mutation", () => {
    expect(adminSource.match(/isOrganizationConflict\(error\)/g)?.length).toBeGreaterThanOrEqual(6);
    expect(adminSource).toContain(
      "The authoritative policy was refreshed. Review it and submit a new action.",
    );
    expect(adminSource).toContain("async function retryInvitationDelivery");
    expect(adminSource).toContain("onClick={() => void retryInvitationDelivery(invite)}");
    expect(adminSource.match(/retryOrganizationUserSetupDelivery\(/g)?.length).toBe(1);
  });

  test("wires reads and mutations to independent lanes and invalidates on unmount", () => {
    for (const resource of ["members", "admin-invitations", "incoming-invitations"]) {
      expect(adminSource).toContain(`claim("${resource}", "read")`);
      expect(adminSource).toContain(`claim("${resource}", "mutation")`);
    }
    expect(adminSource.match(/identityRef\.current = null/g)?.length).toBeGreaterThanOrEqual(2);
    expect(
      adminSource.match(/identityRef\.current = props\.identity/g)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(adminSource.match(/activeOperations\.clear\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(adminSource).toContain("adminInvites.loading ||");
    expect(adminSource).toContain("visibleBusyResource || incoming.loading");
  });

  test("documents the bounded organization and workspace control plane", () => {
    expect(tenancyDocs).toContain("bounded organization\nadministration surface");
    expect(tenancyDocs).toContain("reads and mutations use independent operation lanes");
    expect(tenancyDocs).toContain("The lifecycle therefore **adopts** that exact\naccount");
    expect(tenancyDocs).toContain(
      "durable email\ndelivery outcome/retry reconciliation are active",
    );
    expect(tenancyDocs).not.toContain(
      "This phase has no durable delivery outcome, retry, or reconciliation\nstate",
    );
    expect(tenancyDocs).not.toContain(
      "Durable email delivery outcome/retry reconciliation and automatic scheduling",
    );
    expect(tenancyDocs).not.toContain("Provider email delivery remains a\nnon-goal");
    expect(tenancyDocs).not.toContain("- provider invitation email delivery;");
    expect(tenancyDocs).not.toContain(
      "no organization membership, fallback\naccount, or bound invitation",
    );
    expect(tenancyDocs).toContain("0332_organization_shared_workspace_control_plane.sql");
    expect(tenancyDocs).not.toContain("member-management\nUI remain deferred");
  });
});
