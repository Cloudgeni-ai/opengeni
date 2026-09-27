import { describe, expect, test } from "bun:test";

import { apiKeyStatus } from "./api-key-status";

const now = Date.parse("2026-09-27T12:00:00.000Z");

describe("apiKeyStatus", () => {
  test("reports expired keys as expired, not active", () => {
    expect(apiKeyStatus({ revokedAt: null, expiresAt: "2026-09-27T11:59:59.000Z" }, now)).toBe(
      "expired",
    );
  });

  test("keeps unexpired and non-expiring keys active", () => {
    expect(apiKeyStatus({ revokedAt: null, expiresAt: "2027-03-31T00:00:00.000Z" }, now)).toBe(
      "active",
    );
    expect(apiKeyStatus({ revokedAt: null, expiresAt: null }, now)).toBe("active");
  });

  test("revocation wins over expiry", () => {
    expect(
      apiKeyStatus(
        { revokedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-02T00:00:00.000Z" },
        now,
      ),
    ).toBe("revoked");
  });
});
