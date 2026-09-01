import { describe, expect, test } from "bun:test";

import {
  clearOrganizationInvitationContinuation,
  readOrganizationInvitationContinuation,
  storeOrganizationInvitationContinuation,
} from "./organization-invitation-continuation";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  };
}

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const VALID_CONTINUATION = {
  organizationId: "e0f6de8f-ad48-4b23-bf8f-55122575ad28",
  organizationName: "Northwind Research",
  targetEmail: "member@example.test",
  expiresAt: "2026-09-01T13:00:00.000Z",
};

describe("organization invitation continuation", () => {
  test("retains a valid same-tab handoff until the invitation list acknowledges it", () => {
    const { storage, values } = memoryStorage();
    storeOrganizationInvitationContinuation(
      { ...VALID_CONTINUATION, setupToken: "secret-bearer" } as typeof VALID_CONTINUATION,
      storage,
      NOW,
    );

    expect(Array.from(values.values()).join(" ")).not.toContain("secret-bearer");
    expect(readOrganizationInvitationContinuation(storage, NOW)).toEqual({
      ...VALID_CONTINUATION,
      createdAt: NOW,
    });
    expect(readOrganizationInvitationContinuation(storage, NOW)).not.toBeNull();

    clearOrganizationInvitationContinuation(storage);
    expect(readOrganizationInvitationContinuation(storage, NOW)).toBeNull();
  });

  test("discards expired, stale, future-dated, and malformed handoffs", () => {
    const invalidValues = [
      JSON.stringify({
        ...VALID_CONTINUATION,
        expiresAt: new Date(NOW).toISOString(),
        createdAt: NOW,
      }),
      JSON.stringify({ ...VALID_CONTINUATION, createdAt: NOW - 60 * 60_000 - 1 }),
      JSON.stringify({ ...VALID_CONTINUATION, createdAt: NOW + 60_001 }),
      JSON.stringify({ ...VALID_CONTINUATION, organizationId: "", createdAt: NOW }),
      "not-json",
    ];

    for (const raw of invalidValues) {
      const { storage, values } = memoryStorage();
      storage.setItem("opengeni:organization-invitation-continuation:v1", raw);
      expect(readOrganizationInvitationContinuation(storage, NOW)).toBeNull();
      expect(values.size).toBe(0);
    }
  });

  test("allows sign-in and invitation loading when browser storage is blocked", () => {
    const blockedStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };

    expect(() =>
      storeOrganizationInvitationContinuation(VALID_CONTINUATION, blockedStorage, NOW),
    ).not.toThrow();
    expect(readOrganizationInvitationContinuation(blockedStorage, NOW)).toBeNull();
    expect(() => clearOrganizationInvitationContinuation(blockedStorage)).not.toThrow();
  });
});
