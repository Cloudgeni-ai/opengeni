import { describe, expect, test } from "bun:test";
import type { Database } from "@opengeni/db";
import {
  agentOpenToOrganization,
  organizationAgentAskerPerson,
  organizationAgentPersonRefusal,
} from "../src/integrations/organization-agents";

// The integration-neutral half of "Who can use it: Anyone in <organization>"
// that Slack (and Teams) call before letting someone outside the agent's
// workspace use it.

/** A database that must not be read: the check fails closed before it. */
const unreadDb = new Proxy({} as Database, {
  get() {
    throw new Error("the database must not be read");
  },
});

describe("agents anyone in the organization can use", () => {
  test("only a shared agent with organization access is open", () => {
    expect(agentOpenToOrganization({ visibility: "workspace", organizationAccess: true })).toBe(
      true,
    );
    expect(agentOpenToOrganization({ visibility: "workspace", organizationAccess: false })).toBe(
      false,
    );
    // An Only me agent is never open, whatever an old flag says.
    expect(agentOpenToOrganization({ visibility: "private", organizationAccess: true })).toBe(
      false,
    );
  });

  test("a linked, active, full member is let through; anyone else is told why", () => {
    expect(
      organizationAgentPersonRefusal({ linkedSubjectId: "user:a", organizationMember: true }),
    ).toBeNull();
    expect(
      organizationAgentPersonRefusal({ linkedSubjectId: null, organizationMember: true }),
    ).toBe("not_linked");
    expect(
      organizationAgentPersonRefusal({ linkedSubjectId: "user:a", organizationMember: false }),
    ).toBe("not_organization_member");
  });

  test("an unlinked person or another organization's agent fails closed without a lookup", async () => {
    expect(
      await organizationAgentAskerPerson(unreadDb, {
        connectionAccountId: "org-a",
        agentAccountId: "org-a",
        linkedSubjectId: null,
      }),
    ).toEqual({ refusal: "not_linked" });
    expect(
      await organizationAgentAskerPerson(unreadDb, {
        connectionAccountId: "org-a",
        agentAccountId: "org-b",
        linkedSubjectId: "user:a",
      }),
    ).toEqual({ refusal: "not_organization_member" });
  });
});
