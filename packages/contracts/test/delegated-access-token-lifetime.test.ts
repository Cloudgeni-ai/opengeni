import { describe, expect, test } from "bun:test";

import {
  DELEGATED_ACCESS_TOKEN_MAX_LIFETIME_SECONDS,
  signDelegatedAccessToken,
  verifyDelegatedAccessToken,
  type DelegatedAccessTokenPayload,
} from "../src/index";

const SECRET = crypto.randomUUID();
const NOW = 1_900_000_000;

function payload(
  exp: number,
  extra: Partial<DelegatedAccessTokenPayload> = {},
): DelegatedAccessTokenPayload {
  return {
    accountId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    subjectId: "user:lifetime",
    permissions: ["sessions:read"],
    principalKind: "human_session",
    exp,
    ...extra,
  };
}

describe("delegated access token lifetime", () => {
  test("is capped at 24 hours", () => {
    expect(DELEGATED_ACCESS_TOKEN_MAX_LIFETIME_SECONDS).toBe(24 * 60 * 60);
  });

  test("accepts a token that expires within 24 hours", async () => {
    for (const lifetime of [60, 60 * 60, DELEGATED_ACCESS_TOKEN_MAX_LIFETIME_SECONDS]) {
      const token = await signDelegatedAccessToken(SECRET, payload(NOW + lifetime));
      expect(await verifyDelegatedAccessToken(SECRET, token, NOW)).toMatchObject({
        exp: NOW + lifetime,
      });
    }
  });

  test("refuses a token that would stay valid for longer than 24 hours", async () => {
    for (const extra of [
      {},
      { serviceInitiator: { kind: "service" as const, subjectId: "host:gateway" } },
      { credentialRestriction: "developer_setup" as const },
    ]) {
      const token = await signDelegatedAccessToken(
        SECRET,
        payload(NOW + DELEGATED_ACCESS_TOKEN_MAX_LIFETIME_SECONDS + 1, {
          ...(extra.serviceInitiator ? { principalKind: "service" as const } : {}),
          ...extra,
        }),
      );
      expect(token).toMatch(/^ogd[23]?_/);
      expect(await verifyDelegatedAccessToken(SECRET, token, NOW)).toBeNull();
      // The same token verifies once less than 24 hours of it remain.
      expect(await verifyDelegatedAccessToken(SECRET, token, NOW + 1)).not.toBeNull();
    }
  });

  test("still refuses an expired token", async () => {
    const token = await signDelegatedAccessToken(SECRET, payload(NOW - 1));
    expect(await verifyDelegatedAccessToken(SECRET, token, NOW)).toBeNull();
  });
});
