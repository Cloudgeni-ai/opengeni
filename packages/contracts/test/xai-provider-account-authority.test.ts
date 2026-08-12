import { describe, expect, test } from "bun:test";
import {
  WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
  XaiProviderAccountAuthoritySnapshotV1,
} from "../src/xai-provider-account-authority";

describe("xAI provider-account authority snapshots", () => {
  test("accepts only the two strict version-one opaque shapes", () => {
    expect(
      XaiProviderAccountAuthoritySnapshotV1.parse(
        WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
      ),
    ).toEqual({ version: 1, scope: "workspace" });
    expect(
      XaiProviderAccountAuthoritySnapshotV1.parse({
        version: 1,
        scope: "user",
        authorityGeneration: 7,
      }),
    ).toEqual({ version: 1, scope: "user", authorityGeneration: 7 });

    for (const invalid of [
      {},
      { version: 2, scope: "workspace" },
      { version: 1, scope: "user" },
      { version: 1, scope: "user", authorityGeneration: 0 },
      { version: 1, scope: "user", authorityGeneration: 1.5 },
      {
        version: 1,
        scope: "user",
        authorityGeneration: Number.MAX_SAFE_INTEGER + 1,
      },
      { version: 1, scope: "workspace", authorityGeneration: 1 },
    ]) {
      expect(XaiProviderAccountAuthoritySnapshotV1.safeParse(invalid).success).toBe(false);
    }
  });

  test("rejects every identity, provider, credential, quota, token, and plan field", () => {
    const forbidden = [
      "subjectId",
      "organizationMembershipId",
      "credentialId",
      "providerAccountId",
      "provider",
      "label",
      "quota",
      "token",
      "plan",
      "connectedBySubjectId",
    ];
    for (const field of forbidden) {
      expect(
        XaiProviderAccountAuthoritySnapshotV1.safeParse({
          version: 1,
          scope: "user",
          authorityGeneration: 1,
          [field]: "must-not-survive",
        }).success,
      ).toBe(false);
    }
  });
});
