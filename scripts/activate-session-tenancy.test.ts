import { describe, expect, test } from "bun:test";
import { assertSessionTenancyActivationEvidence } from "./activate-session-tenancy";

const cleanInventory = {
  organizationMemberships: { activeWithoutPersonalWorkspace: 0 },
  workspaceMemberSubjectsWithoutMembershipAnchor: 0,
  sessions: { ownerless: 0 },
  documents: { legacyPersonalNullAuthority: 0 },
  codexCredentials: { unattributedConnector: 0 },
  workspaceWriters: {
    admissions: { legacyUnattributed: 0 },
    retainedProcesses: { legacyUnattributed: 0 },
  },
};
const cleanParity = {
  gates: { membership: { violations: 0 } },
  lanes: { legacy: 0 },
};

describe("session tenancy activation evidence", () => {
  test("accepts only a fully drained inventory and parity report", () => {
    expect(() => assertSessionTenancyActivationEvidence(cleanInventory, cleanParity)).not.toThrow();
  });

  test("fails closed on a non-zero or missing inventory counter", () => {
    expect(() =>
      assertSessionTenancyActivationEvidence(
        { ...cleanInventory, sessions: { ownerless: 1 } },
        cleanParity,
      ),
    ).toThrow(/sessions.ownerless/);
    expect(() =>
      assertSessionTenancyActivationEvidence({ ...cleanInventory, documents: {} }, cleanParity),
    ).toThrow(/documents.legacyPersonalNullAuthority/);
  });

  test("fails closed on parity violations and compatibility lanes", () => {
    expect(() =>
      assertSessionTenancyActivationEvidence(cleanInventory, {
        gates: { membership: { violations: 1 } },
        lanes: { legacy: 0 },
      }),
    ).toThrow(/gate:membership/);
    expect(() =>
      assertSessionTenancyActivationEvidence(cleanInventory, {
        gates: { membership: { violations: 0 } },
        lanes: { legacy: 1 },
      }),
    ).toThrow(/lane:legacy/);
  });
});
