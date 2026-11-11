import { expect, spyOn, test } from "bun:test";
import * as database from "@opengeni/db";
import {
  requireSandboxRecoveryPreviewHuman,
  getManagedHumanSandboxRecovery,
  consentManagedHumanSandboxRecovery,
} from "../src/application/sandbox-recovery";
import type { AccessGrantAuthorization } from "../src/access";

const workspaceId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
function authorization(
  overrides: Partial<AccessGrantAuthorization> = {},
): AccessGrantAuthorization {
  return {
    grant: {
      accountId: crypto.randomUUID(),
      workspaceId,
      subjectId: "user:owner",
      permissions: ["sessions:read", "sessions:control"],
    },
    accountGrant: null,
    authenticatedSubjectId: "user:owner",
    contextIntegrity: true,
    canonicalManagedHumanSession: true,
    canonicalLocalHumanSession: false,
    ...overrides,
  };
}
for (const [name, overrides] of [
  ["agent/API/delegated principal", { canonicalManagedHumanSession: false }],
  ["substituted actor", { authenticatedSubjectId: "user:other" }],
  ["invalid context", { contextIntegrity: false }],
] as const) {
  test(`${name} cannot even preview or consent before persistence`, async () => {
    await expect(
      getManagedHumanSandboxRecovery({} as never, authorization(overrides), workspaceId, sessionId),
    ).rejects.toThrow("managed-human");
    await expect(
      consentManagedHumanSandboxRecovery(
        {} as never,
        authorization(overrides),
        workspaceId,
        sessionId,
        { action: "continue_fresh" } as never,
      ),
    ).rejects.toThrow("managed-human");
    await expect(
      consentManagedHumanSandboxRecovery(
        {} as never,
        authorization(overrides),
        workspaceId,
        sessionId,
        {} as never,
      ),
    ).rejects.toThrow("managed-human");
  });
}
test("read-only grant and wrong tenant cannot authorize consent", async () => {
  const auth = authorization();
  auth.grant.permissions = ["sessions:read"];
  await expect(
    getManagedHumanSandboxRecovery({} as never, auth, workspaceId, sessionId),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    consentManagedHumanSandboxRecovery(
      {} as never,
      authorization(),
      crypto.randomUUID(),
      sessionId,
      {} as never,
    ),
  ).rejects.toThrow("managed-human");
});

test("the exact local human may select recovery but an actor-hidden group member never grants reset authority", async () => {
  const local = authorization({
    authenticatedSubjectId: "dev",
    canonicalManagedHumanSession: false,
    canonicalLocalHumanSession: true,
  });
  local.grant.subjectId = "dev";
  local.grant.principalKind = "human_session";
  const hiddenId = crypto.randomUUID();
  // No host authorization port: core's historical standalone missing-target
  // result is null, which must not be mistaken for group-control permission.
  const facts = spyOn(database, "getSessionAuthorizationFacts").mockResolvedValue({
    target: null,
    caller: null,
  } as never);
  const persist = spyOn(database, "consentPublicSandboxRecovery").mockImplementation(
    async (db, input) => {
      expect(input.canControlMember).toBeDefined();
      expect(await input.canControlMember!(db, hiddenId)).toBe(false);
      return { outcome: "accepted" } as never;
    },
  );
  try {
    await consentManagedHumanSandboxRecovery({ db: {} } as never, local, workspaceId, sessionId, {
      action: "continue_fresh",
    } as never);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(facts).toHaveBeenCalledTimes(2);
  } finally {
    persist.mockRestore();
    facts.mockRestore();
  }
});

test("the exact built-in local human may preview but cannot submit managed-human consent", async () => {
  const local = authorization({
    authenticatedSubjectId: "dev",
    canonicalManagedHumanSession: false,
    canonicalLocalHumanSession: true,
  });
  local.grant.subjectId = "dev";
  local.grant.principalKind = "human_session";
  expect(() => requireSandboxRecoveryPreviewHuman(local, workspaceId)).not.toThrow();
  await expect(
    consentManagedHumanSandboxRecovery({} as never, local, workspaceId, sessionId, {} as never),
  ).rejects.toThrow("managed-human");
  expect(() =>
    requireSandboxRecoveryPreviewHuman(
      authorization({ canonicalManagedHumanSession: false, canonicalLocalHumanSession: true }),
      workspaceId,
    ),
  ).toThrow("managed-human");
  expect(() =>
    requireSandboxRecoveryPreviewHuman(
      authorization({
        canonicalManagedHumanSession: false,
        canonicalLocalHumanSession: true,
        contextIntegrity: false,
      }),
      workspaceId,
    ),
  ).toThrow("managed-human");
});
