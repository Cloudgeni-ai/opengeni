import { describe, expect, test } from "bun:test";

const routeSource = await Bun.file(`${import.meta.dir}/routes/org-settings.tsx`).text();
const adminSource = await Bun.file(`${import.meta.dir}/components/organization-admin.tsx`).text();

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
    expect(adminSource).toContain("disabled={visibleBusyResource !== null}");
  });

  test("handles CAS conflicts by refreshing without replaying the mutation", () => {
    expect(adminSource.match(/isOrganizationConflict\(error\)/g)?.length).toBeGreaterThanOrEqual(6);
    expect(adminSource).toContain(
      "The authoritative policy was refreshed. Review it and submit a new action.",
    );
    expect(adminSource).not.toContain("retryOrganization");
  });
});
