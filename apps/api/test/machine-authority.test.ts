import { describe, expect, test } from "bun:test";
import type { Permission } from "@opengeni/contracts";
import type { AccessGrantAuthorization } from "@opengeni/core";
import { HTTPException } from "hono/http-exception";
import {
  machineScopeRefusal,
  requireMachineAudienceAuthority,
  requireMachineScopeAuthority,
} from "../src/sandbox/machine-authority";

// The one rule for connecting and changing Connected Machines: Only me for
// every signed-in teammate with enrollments:read, This workspace with
// enrollments:manage, organization also with account:admin. Credentials acting
// for a person, and keys, services and agents, keep the old refusal.

const SUBJECT = "user:teammate";

function authorization(input: {
  permissions: Permission[];
  accountPermissions?: Permission[];
  signedIn?: boolean;
  principalKind?: "human_session" | "api_key" | "service" | "agent_attempt";
  delegated?: boolean;
  subjectId?: string;
}): AccessGrantAuthorization {
  const subjectId = input.subjectId ?? SUBJECT;
  return {
    grant: {
      accountId: "00000000-0000-4000-8000-000000000001",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      subjectId,
      permissions: input.permissions,
      principalKind: input.principalKind ?? "human_session",
      ...(input.delegated ? { metadata: { delegated: true } } : {}),
    },
    accountGrant: {
      accountId: "00000000-0000-4000-8000-000000000001",
      subjectId,
      permissions: input.accountPermissions ?? [],
    },
    authenticatedSubjectId: subjectId,
    contextIntegrity: true,
    canonicalManagedHumanSession: input.signedIn ?? true,
    canonicalLocalHumanSession: false,
  };
}

const member = authorization({ permissions: ["workspace:read", "enrollments:read"] });

describe("Connected Machine scope rule", () => {
  test("a signed-in Member connects and changes their own Only me machine only", () => {
    expect(machineScopeRefusal(member, "user", "connect")).toBeNull();
    expect(machineScopeRefusal(member, "user", "change")).toBeNull();
    expect(machineScopeRefusal(member, "workspace", "connect")).toBe(
      "Only workspace admins can connect a machine for the whole workspace. Choose Only me to connect your own.",
    );
    expect(machineScopeRefusal(member, "workspace", "change")).toBe(
      "Only workspace admins can change a machine shared with the whole workspace.",
    );
    expect(machineScopeRefusal(member, "organization", "connect")).toBe(
      "Only organization admins can connect a machine for the whole organization.",
    );
  });

  test("machine managers keep workspace access; organization machines also need account:admin", () => {
    const manager = authorization({ permissions: ["enrollments:read", "enrollments:manage"] });
    expect(machineScopeRefusal(manager, "user", "connect")).toBeNull();
    expect(machineScopeRefusal(manager, "workspace", "connect")).toBeNull();
    expect(machineScopeRefusal(manager, "organization", "change")).toBe(
      "Only organization admins can change a machine shared with the whole organization.",
    );
    const organizationAdmin = authorization({
      permissions: ["enrollments:manage"],
      accountPermissions: ["account:admin"],
    });
    expect(machineScopeRefusal(organizationAdmin, "organization", "connect")).toBeNull();
    // workspace:admin is the super-wildcard for legacy grants.
    const admin = authorization({ permissions: ["workspace:admin"] });
    expect(machineScopeRefusal(admin, "workspace", "change")).toBeNull();
  });

  test("credentials acting for a person and machine principals keep the old refusal", () => {
    const refusal =
      "Only you can connect a machine for yourself, signed in to Opengeni; a key, agent or app acting for you needs permission to manage machines.";
    for (const caller of [
      // A delegated bearer acting for the person, without enrollments:manage.
      authorization({ permissions: ["enrollments:read"], signedIn: false, delegated: true }),
      // An organization MCP client or key acting as the person (no cookie).
      authorization({ permissions: ["enrollments:read"], signedIn: false }),
      authorization({
        permissions: ["enrollments:read"],
        signedIn: false,
        principalKind: "api_key",
        subjectId: "api_key:1",
      }),
      authorization({
        permissions: ["enrollments:read"],
        signedIn: false,
        principalKind: "service",
        subjectId: "service:learning",
      }),
      authorization({
        permissions: ["enrollments:read"],
        signedIn: false,
        principalKind: "agent_attempt",
        subjectId: "attempt:1",
      }),
    ]) {
      expect(machineScopeRefusal(caller, "user", "connect")).toBe(refusal);
      // Only a signed-in person is pointed at Only me.
      expect(machineScopeRefusal(caller, "workspace", "connect")).toBe(
        "Only workspace admins can connect a machine for the whole workspace.",
      );
    }
    // A cookie whose grant is not the person's own subject is not the owner.
    expect(
      machineScopeRefusal(
        { ...member, authenticatedSubjectId: "user:someone-else" },
        "user",
        "connect",
      ),
    ).toBe(refusal);
    // Without enrollments:read nobody connects even their own machine.
    expect(
      machineScopeRefusal(authorization({ permissions: ["workspace:read"] }), "user", "change"),
    ).toBe("You don't have access to this workspace's machines.");
  });

  test("refusals are 403 sentences, never a raw permission string", () => {
    let thrown: unknown;
    try {
      requireMachineScopeAuthority(member, "workspace", "connect");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HTTPException);
    expect((thrown as HTTPException).status).toBe(403);
    expect((thrown as HTTPException).message).not.toContain("missing permission");
    expect(() => requireMachineScopeAuthority(member, "user", "connect")).not.toThrow();
    expect(() => requireMachineAudienceAuthority(member)).toThrow(
      "Only workspace admins can change who can use a machine.",
    );
    expect(() =>
      requireMachineAudienceAuthority(authorization({ permissions: ["enrollments:manage"] })),
    ).not.toThrow();
  });
});
