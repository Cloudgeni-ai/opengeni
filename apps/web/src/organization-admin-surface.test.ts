import { describe, expect, test } from "bun:test";

const routeSource = await Bun.file(`${import.meta.dir}/routes/org-settings.tsx`).text();
const adminSource = await Bun.file(`${import.meta.dir}/components/organization-admin.tsx`).text();
const tenancyDocs = await Bun.file(
  `${import.meta.dir}/../../../docs/organization-tenancy.md`,
).text();

describe("organization administration surface", () => {
  test("routes accessible overview, people, retention, and billing sections", () => {
    expect(routeSource).toContain('aria-label="Organization settings sections"');
    expect(routeSource).toContain('aria-current={section === target ? "page" : undefined}');
    for (const section of ["overview", "people", "retention", "billing"]) {
      expect(routeSource).toContain(`["${section}",`);
    }
  });

  test("uses only lifecycle APIs and never links a member personal workspace", () => {
    for (const method of [
      "listOrganizationMembers",
      "listOrganizationInvitationsForOrganization",
      "createOrganizationInvitation",
      "revokeOrganizationInvitation",
      "listOrganizationInvitations",
      "acceptOrganizationInvitation",
      "updateOrganizationMember",
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
    expect(adminSource).toContain("Stable masked identifier");
    expect(adminSource).toContain("Profile name and email are unavailable from this API.");
    expect(adminSource).toContain("props.onAuthorityChanged()");
  });

  test("names destructive consequences and restores keyboard focus", () => {
    expect(adminSource).toContain("Access is revoked immediately");
    expect(adminSource).toContain(
      "Shared-workspace grants removed during suspension are not restored",
    );
    expect(adminSource).toContain("Offboarding is terminal");
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
    expect(adminSource).not.toContain("retryOrganization");
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

  test("documents the bounded UI while keeping provider delivery outside this backend phase", () => {
    expect(tenancyDocs).toContain("bounded organization\nadministration surface");
    expect(tenancyDocs).toContain("reads and mutations use independent operation lanes");
    expect(tenancyDocs).toContain("Provider email delivery\nremains a non-goal");
    expect(tenancyDocs).toContain("pre-registration name and initial-workspace access");
    expect(tenancyDocs).not.toContain("member-management\nUI remain deferred");
  });
});
