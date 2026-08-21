import { describe, expect, test } from "bun:test";

import {
  beginOrganizationAdminOperation,
  canInviteOrganizationRole,
  canRevokeOrganizationInvitation,
  maskedOrganizationSubject,
  organizationAdminOperationSlot,
  organizationMemberCapabilities,
  ownsOrganizationAdminOperation,
  retentionPolicySummary,
  validRetentionDays,
  type OrganizationAdminIdentity,
} from "./organization-admin";

const identityA: OrganizationAdminIdentity = {
  principalGeneration: 4,
  subjectId: "user:actor-a",
  organizationId: "org-a",
  workspaceId: "workspace-a",
};

describe("organization administration authority", () => {
  test("mirrors the owner/admin/member action matrix", () => {
    expect(organizationMemberCapabilities("owner", { role: "admin", status: "active" }, 1)).toEqual(
      {
        canChangeRole: true,
        allowedRoles: ["owner", "admin", "member"],
        canSuspend: true,
        canReactivate: false,
        canOffboard: true,
      },
    );
    expect(organizationMemberCapabilities("admin", { role: "admin", status: "active" }, 1)).toEqual(
      {
        canChangeRole: false,
        allowedRoles: [],
        canSuspend: false,
        canReactivate: false,
        canOffboard: false,
      },
    );
    expect(
      organizationMemberCapabilities("admin", { role: "member", status: "suspended" }, 1),
    ).toMatchObject({ canReactivate: true, canOffboard: true, canSuspend: false });
    expect(
      organizationMemberCapabilities("member", { role: "member", status: "active" }, 1),
    ).toMatchObject({
      canChangeRole: false,
      canSuspend: false,
      canReactivate: false,
      canOffboard: false,
    });
    expect(canInviteOrganizationRole("admin", "member")).toBe(true);
    expect(canInviteOrganizationRole("admin", "owner")).toBe(false);
    expect(canInviteOrganizationRole("owner", "admin")).toBe(true);
    expect(canRevokeOrganizationInvitation("admin", "member")).toBe(true);
    expect(canRevokeOrganizationInvitation("admin", "admin")).toBe(false);
    expect(canRevokeOrganizationInvitation("admin", "owner")).toBe(false);
    expect(canRevokeOrganizationInvitation("owner", "owner")).toBe(true);
  });

  test("protects the last active owner and enables owner actions once a second owner is active", () => {
    expect(organizationMemberCapabilities("owner", { role: "owner", status: "active" }, 1)).toEqual(
      {
        canChangeRole: false,
        allowedRoles: [],
        canSuspend: false,
        canReactivate: false,
        canOffboard: false,
      },
    );
    expect(organizationMemberCapabilities("owner", { role: "owner", status: "active" }, 2)).toEqual(
      {
        canChangeRole: true,
        allowedRoles: ["owner", "admin", "member"],
        canSuspend: true,
        canReactivate: false,
        canOffboard: true,
      },
    );
  });

  test("fences A to B transitions and overlapping operations independently", () => {
    const first = beginOrganizationAdminOperation({
      identity: identityA,
      resource: "members",
      lane: "read",
      previousSequence: 0,
    });
    const second = beginOrganizationAdminOperation({
      identity: identityA,
      resource: "members",
      lane: "read",
      previousSequence: first.sequence,
    });
    const identityB = { ...identityA, organizationId: "org-b", workspaceId: "workspace-b" };
    expect(
      ownsOrganizationAdminOperation({
        currentIdentity: identityA,
        currentOperation: second,
        accepted: first,
      }),
    ).toBe(false);
    expect(
      ownsOrganizationAdminOperation({
        currentIdentity: identityB,
        currentOperation: second,
        accepted: second,
      }),
    ).toBe(false);
    const invitations = beginOrganizationAdminOperation({
      identity: identityA,
      resource: "admin-invitations",
      lane: "read",
      previousSequence: 0,
    });
    expect(
      ownsOrganizationAdminOperation({
        currentIdentity: identityA,
        currentOperation: invitations,
        accepted: invitations,
      }),
    ).toBe(true);
  });

  test("keeps same-resource reads and mutations independently owned in both settle orders", async () => {
    for (const resource of ["members", "admin-invitations", "incoming-invitations"] as const) {
      for (const order of ["read-first", "mutation-first"] as const) {
        const read = beginOrganizationAdminOperation({
          identity: identityA,
          resource,
          lane: "read",
          previousSequence: 0,
        });
        const mutation = beginOrganizationAdminOperation({
          identity: identityA,
          resource,
          lane: "mutation",
          previousSequence: 0,
        });
        const active = new Map([
          [organizationAdminOperationSlot(resource, "read"), read],
          [organizationAdminOperationSlot(resource, "mutation"), mutation],
        ]);
        const readDeferred = deferred<void>();
        const mutationDeferred = deferred<void>();
        const settled: string[] = [];
        const settle = async (label: string, pending: Promise<void>, operation: typeof read) => {
          await pending;
          const currentOperation =
            active.get(organizationAdminOperationSlot(operation.resource, operation.lane)) ?? null;
          if (
            ownsOrganizationAdminOperation({
              currentIdentity: identityA,
              currentOperation,
              accepted: operation,
            })
          )
            settled.push(label);
        };
        const readResult = settle("read", readDeferred.promise, read);
        const mutationResult = settle("mutation", mutationDeferred.promise, mutation);
        if (order === "read-first") {
          readDeferred.resolve();
          await readResult;
          mutationDeferred.resolve();
        } else {
          mutationDeferred.resolve();
          await mutationResult;
          readDeferred.resolve();
        }
        await Promise.all([readResult, mutationResult]);
        expect(settled).toEqual(
          order === "read-first" ? ["read", "mutation"] : ["mutation", "read"],
        );
      }
    }
  });

  test("uses a stable masked identifier and validates retention bounds", () => {
    expect(maskedOrganizationSubject("user:one")).toBe(maskedOrganizationSubject("user:one"));
    expect(maskedOrganizationSubject("user:one")).not.toContain("user:one");
    expect(maskedOrganizationSubject("user:one")).not.toBe(maskedOrganizationSubject("user:two"));
    expect(validRetentionDays(30)).toBe(true);
    expect(validRetentionDays(90)).toBe(true);
    expect(validRetentionDays(29)).toBe(false);
    expect(validRetentionDays(91)).toBe(false);
    expect(retentionPolicySummary({ mode: "retain", retentionDays: null })).toContain(
      "indefinitely",
    );
    expect(retentionPolicySummary({ mode: "delete_after", retentionDays: 45 })).toContain(
      "operator cleanup after 45 days",
    );
  });
});

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
