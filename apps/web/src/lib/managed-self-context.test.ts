import { describe, expect, test } from "bun:test";

import {
  isPersonalWorkspace,
  loadCurrentManagedSelfContext,
  managedSelfContextIdentity,
  personalWorkspaceMembership,
  type ManagedSelfContextIdentity,
} from "./managed-self-context";

const organizationId = "11111111-1111-4111-8111-111111111111";
const personalWorkspaceId = "22222222-2222-4222-8222-222222222222";
const membership = {
  id: "33333333-3333-4333-8333-333333333333",
  organizationId,
  status: "active" as const,
  personalWorkspaceId,
};

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("managed self context", () => {
  test("classifies Personal only from the exact server-issued organization/workspace tuple", () => {
    const identity = managedSelfContextIdentity({
      credentialGeneration: 4,
      managedUserId: "user-id",
    });
    const selfContext = { identity, memberships: [membership] };

    expect(
      personalWorkspaceMembership(
        { id: personalWorkspaceId, accountId: organizationId },
        selfContext,
      ),
    ).toEqual(membership);
    expect(
      isPersonalWorkspace(
        { id: personalWorkspaceId, accountId: "44444444-4444-4444-8444-444444444444" },
        selfContext,
      ),
    ).toBe(false);
    expect(
      isPersonalWorkspace(
        { id: "55555555-5555-4555-8555-555555555555", accountId: organizationId },
        selfContext,
      ),
    ).toBe(false);
    expect(isPersonalWorkspace({ id: personalWorkspaceId, accountId: organizationId }, null)).toBe(
      false,
    );
  });

  test("discards a delayed membership response after credential/principal replacement", async () => {
    const oldIdentity = managedSelfContextIdentity({
      credentialGeneration: 1,
      managedUserId: "old-user",
    });
    let currentIdentity: ManagedSelfContextIdentity | null = oldIdentity;
    const response = deferred<{ memberships: [typeof membership] }>();
    const result = loadCurrentManagedSelfContext({
      identity: oldIdentity,
      currentIdentity: () => currentIdentity,
      request: () => response.promise,
    });

    currentIdentity = managedSelfContextIdentity({
      credentialGeneration: 2,
      managedUserId: "new-user",
    });
    response.resolve({ memberships: [membership] });

    expect(await result).toBeNull();
  });

  test("suppresses a stale rejection but preserves a current principal's failure", async () => {
    const identity = managedSelfContextIdentity({
      credentialGeneration: 1,
      managedUserId: "user-id",
    });
    let currentIdentity: ManagedSelfContextIdentity | null = identity;
    const stale = deferred<{ memberships: [] }>();
    const staleResult = loadCurrentManagedSelfContext({
      identity,
      currentIdentity: () => currentIdentity,
      request: () => stale.promise,
    });
    currentIdentity = null;
    stale.reject(new Error("old cookie failed"));
    expect(await staleResult).toBeNull();

    currentIdentity = identity;
    await expect(
      loadCurrentManagedSelfContext({
        identity,
        currentIdentity: () => currentIdentity,
        request: async () => {
          throw new Error("current cookie failed");
        },
      }),
    ).rejects.toThrow("current cookie failed");
  });
});
