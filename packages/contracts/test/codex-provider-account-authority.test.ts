import { describe, expect, test } from "bun:test";
import {
  CodexProviderAccountAuthoritySnapshotV1,
  LEGACY_WORKSPACE_CODEX_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
} from "../src/codex-provider-account-authority";

describe("Codex provider-account authority snapshots", () => {
  test("accepts only the two strict version-one opaque shapes", () => {
    expect(
      CodexProviderAccountAuthoritySnapshotV1.parse(
        LEGACY_WORKSPACE_CODEX_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
      ),
    ).toEqual({ version: 1, scope: "workspace" });
    expect(
      CodexProviderAccountAuthoritySnapshotV1.parse({
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
        scope: "workspace",
        authorityGeneration: 1,
      },
    ]) {
      expect(CodexProviderAccountAuthoritySnapshotV1.safeParse(invalid).success).toBe(false);
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
    ];
    for (const field of forbidden) {
      expect(
        CodexProviderAccountAuthoritySnapshotV1.safeParse({
          version: 1,
          scope: "user",
          authorityGeneration: 1,
          [field]: "must-not-survive",
        }).success,
      ).toBe(false);
    }
  });
});
