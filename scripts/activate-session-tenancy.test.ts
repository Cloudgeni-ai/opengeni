import { describe, expect, test } from "bun:test";
import {
  assertSessionTenancyActivationEvidence,
  assertSessionTenancyBackfillEvidence,
} from "./activate-session-tenancy";

const cleanInventory = {
  schemaVersion: 2,
  organizationMemberships: { activeWithoutPersonalWorkspace: 0 },
  workspaceMemberSubjectsWithoutMembershipAnchor: 0,
  // Legitimate service/API-key sessions and immutable pre-0277 writer history
  // are deliberately not activation blockers. The parity report supplies the
  // truthful drainable/bounded refinements below.
  sessions: { ownerless: 7 },
  documents: { legacyPersonalNullAuthority: 0 },
  codexCredentials: { unattributedConnector: 0 },
  workspaceWriters: {
    admissions: { legacyUnattributed: 5 },
    retainedProcesses: { legacyUnattributed: 3 },
  },
};
const cleanParity = {
  schemaVersion: 1,
  gates: Object.fromEntries(
    [
      "membership_personal_workspace_pointer",
      "membership_personal_workspace_exclusive",
      "membership_personal_workspace_same_organization",
      "personal_workspace_has_no_membership_row",
      "authority_resource_single_owner",
      "grant_delegation_fence_complete",
      "grant_owner_membership_active",
      "grant_authority_live",
      "grant_session_fence_not_ahead",
      "session_owner_provenance_paired",
      "session_owner_subject_matches_membership",
      "session_owner_membership_same_organization",
      "login_binding_dispute_propagated",
      "identity_active_binding_owned",
      "user_scoped_resource_live_anchor",
    ].map((name) => [name, { violations: 0 }]),
  ),
  lanes: {
    connectionsLegacyUser: 0,
    workspaceWriterAdmissionsLegacyUnattributedInWindow: 0,
    workspaceWriterProcessesLegacyUnattributedInWindow: 0,
    documentsLegacyPersonalNullAuthority: 0,
    codexCredentialsUnattributedConnector: 0,
    workspaceMemberSubjectsWithoutMembershipAnchor: 0,
    sessionsAttributableButUnattributed: 0,
    connectionUseLegacyResolutionsInWindow: 0,
  },
};
const cleanBackfillEvidence = {
  schemaVersion: 1,
  ready: true,
  receiptIds: Array.from({ length: 5 }, () => crypto.randomUUID()),
  blockers: [],
  families: Object.fromEntries(
    ["organization_memberships", "sessions", "variable_sets", "rigs", "machines"].map((family) => [
      family,
      { status: "completed", blocker: null },
    ]),
  ),
};

describe("session tenancy activation evidence", () => {
  test("accepts legitimate ownerless sessions and immutable historical writer rows", () => {
    expect(() => assertSessionTenancyActivationEvidence(cleanInventory, cleanParity)).not.toThrow();
  });

  test("fails closed on malformed report versions", () => {
    expect(() =>
      assertSessionTenancyActivationEvidence({ ...cleanInventory, schemaVersion: 1 }, cleanParity),
    ).toThrow(/inventory report is structurally invalid/);
    expect(() =>
      assertSessionTenancyActivationEvidence(cleanInventory, {
        ...cleanParity,
        schemaVersion: 2,
      }),
    ).toThrow(/parity report is structurally invalid/);
  });

  test("fails closed on parity violations and exact drainable or bounded lanes", () => {
    expect(() =>
      assertSessionTenancyActivationEvidence(cleanInventory, {
        ...cleanParity,
        gates: {
          ...cleanParity.gates,
          membership_personal_workspace_pointer: { violations: 1 },
        },
      }),
    ).toThrow(/gate:membership_personal_workspace_pointer/);
    expect(() =>
      assertSessionTenancyActivationEvidence(cleanInventory, {
        ...cleanParity,
        lanes: { ...cleanParity.lanes, sessionsAttributableButUnattributed: 1 },
      }),
    ).toThrow(/lane:sessionsAttributableButUnattributed/);
    expect(() =>
      assertSessionTenancyActivationEvidence(cleanInventory, {
        ...cleanParity,
        lanes: {
          ...cleanParity.lanes,
          workspaceWriterAdmissionsLegacyUnattributedInWindow: 1,
        },
      }),
    ).toThrow(/lane:workspaceWriterAdmissionsLegacyUnattributedInWindow/);
    const { sessionsAttributableButUnattributed: _, ...missingLane } = cleanParity.lanes;
    expect(() =>
      assertSessionTenancyActivationEvidence(cleanInventory, {
        ...cleanParity,
        lanes: missingLane,
      }),
    ).toThrow(/missing-lane:sessionsAttributableButUnattributed/);
    const { membership_personal_workspace_pointer: _omittedGate, ...missingGate } =
      cleanParity.gates;
    expect(() =>
      assertSessionTenancyActivationEvidence(cleanInventory, {
        ...cleanParity,
        gates: missingGate,
      }),
    ).toThrow(/missing-gate:membership_personal_workspace_pointer/);
  });

  test("requires all five settled backfill receipt families", () => {
    expect(() => assertSessionTenancyBackfillEvidence(cleanBackfillEvidence)).not.toThrow();
    expect(() =>
      assertSessionTenancyBackfillEvidence({
        ...cleanBackfillEvidence,
        ready: false,
        blockers: [{ resourceFamily: "machines", code: "missing_receipt" }],
      }),
    ).toThrow(/backfill evidence is not settled/);
    expect(() =>
      assertSessionTenancyBackfillEvidence({
        ...cleanBackfillEvidence,
        receiptIds: cleanBackfillEvidence.receiptIds.slice(1),
      }),
    ).toThrow(/backfill evidence is not settled/);
    expect(() =>
      assertSessionTenancyBackfillEvidence({
        ...cleanBackfillEvidence,
        families: { ...cleanBackfillEvidence.families, rigs: { status: "open", blocker: null } },
      }),
    ).toThrow(/family:rigs/);
  });
});
