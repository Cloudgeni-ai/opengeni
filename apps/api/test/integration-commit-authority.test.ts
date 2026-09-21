import { describe, expect, spyOn, test } from "bun:test";
import { signDelegatedAccessToken, type DelegatedAccessTokenPayload } from "@opengeni/contracts";
import type { AccessGrantAuthorization } from "@opengeni/core";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { integrationCommitGrant } from "../src/integrations/integration-commit-authority";

const secret = "integration-commit-authority-test-secret";
const accountId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const subjectId = "host-opaque-owner";

function payload(
  overrides: Partial<DelegatedAccessTokenPayload> = {},
): DelegatedAccessTokenPayload {
  return {
    accountId,
    workspaceId,
    subjectId,
    principalKind: "human_session",
    permissions: ["github:manage"],
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

function authorization(): AccessGrantAuthorization {
  return {
    grant: { accountId, workspaceId, subjectId, permissions: ["github:manage"] },
    authenticatedSubjectId: subjectId,
    accountGrant: { accountId, subjectId, permissions: [] },
    contextIntegrity: true,
    canonicalManagedHumanSession: false,
    canonicalLocalHumanSession: false,
  };
}

function forbiddenDatabase() {
  let accesses = 0;
  const db = new Proxy({} as Database, {
    get() {
      accesses++;
      throw new Error("native database authority requested");
    },
  });
  return { db, accesses: () => accesses };
}

async function request(value = payload(), signingSecret = secret) {
  return {
    settings: testSettings({ productAccessMode: "configured", delegationSecret: secret }),
    authorizationHeader: `Bearer ${await signDelegatedAccessToken(signingSecret, value)}`,
  };
}

describe("integration commit delegated authority", () => {
  test("valid signed delegation commits without membership or delegated metadata", async () => {
    const database = forbiddenDatabase();
    const grant = await integrationCommitGrant(authorization(), ["github:manage"], await request());
    await grant.authorizeCommit(database.db);
    expect(database.accesses()).toBe(0);
    expect(grant.subjectId).toBe(subjectId);
  });

  test("expiry after preparation rejects before persistence", async () => {
    const value = payload();
    const grant = await integrationCommitGrant(
      authorization(),
      ["github:manage"],
      await request(value),
    );
    const database = forbiddenDatabase();
    const clock = spyOn(Date, "now").mockReturnValue((value.exp + 1) * 1000);
    try {
      await expect(grant.authorizeCommit(database.db)).rejects.toMatchObject({ status: 403 });
      expect(database.accesses()).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  test("secret rotation after preparation rejects the original signature", async () => {
    const input = await request();
    const grant = await integrationCommitGrant(authorization(), ["github:manage"], input);
    input.settings.delegationSecret = "rotated-integration-test-secret";
    const database = forbiddenDatabase();
    await expect(grant.authorizeCommit(database.db)).rejects.toMatchObject({ status: 403 });
    expect(database.accesses()).toBe(0);
  });

  test("wrong signing key cannot create a membership-free authority bypass", async () => {
    const access = authorization();
    access.grant.metadata = { delegated: true };
    const grant = await integrationCommitGrant(
      access,
      ["github:manage"],
      await request(payload(), "wrong-integration-test-secret"),
    );
    const database = forbiddenDatabase();
    await expect(grant.authorizeCommit(database.db)).rejects.toThrow(
      "native database authority requested",
    );
    expect(database.accesses()).toBeGreaterThan(0);
  });

  for (const field of ["accountId", "workspaceId", "subjectId"] as const) {
    test(`signed ${field} mismatch rejects during preparation`, async () => {
      const value = payload({
        [field]: field === "subjectId" ? "another-owner" : "00000000-0000-4000-8000-000000000099",
      });
      await expect(
        integrationCommitGrant(authorization(), ["github:manage"], await request(value)),
      ).rejects.toMatchObject({ status: 403 });
    });
  }

  test("signed permissions cannot be replaced by broader grant permissions", async () => {
    await expect(
      integrationCommitGrant(
        authorization(),
        ["github:manage"],
        await request(payload({ permissions: ["github:use"] })),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
