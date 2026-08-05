import { describe, expect, test } from "bun:test";
import { selectCanonicalPersonalSlackConnection, type ConnectionMetadata } from "../src/index";

function connection(overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    subjectId: "subject-a",
    providerDomain: "slack.com",
    kind: "oauth2",
    status: "active",
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: {},
    createdBySubjectId: "subject-a",
    updatedBySubjectId: "subject-a",
    createdAt: "2026-07-31T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("Personal Slack canonical connection selection", () => {
  test("uses status, update, creation, and UUID descending in that order", () => {
    const canonical = connection({ id: "33333333-3333-4333-8333-333333333333" });
    const lowerUuid = connection({ id: "22222222-2222-4222-8222-222222222222" });
    const olderCreation = connection({
      id: "ffffffff-ffff-4fff-bfff-ffffffffffff",
      createdAt: "2026-07-30T10:00:00.000Z",
    });
    const olderUpdate = connection({
      id: "ffffffff-ffff-4fff-bfff-ffffffffffff",
      updatedAt: "2026-08-01T09:59:59.000Z",
    });
    const revoked = connection({
      id: "ffffffff-ffff-4fff-bfff-ffffffffffff",
      status: "revoked",
      createdAt: "2026-08-01T11:00:00.000Z",
      updatedAt: "2026-08-01T11:00:00.000Z",
    });

    const candidates = [revoked, olderUpdate, lowerUuid, olderCreation, canonical];
    expect(selectCanonicalPersonalSlackConnection(candidates)).toBe(canonical);
    expect(selectCanonicalPersonalSlackConnection([...candidates].reverse())).toBe(canonical);
  });

  test("keeps reconnect-required status precedence deterministic when no row is active", () => {
    const needsReauth = connection({ status: "needs_reauth" });
    const error = connection({
      id: "eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee",
      status: "error",
      updatedAt: "2026-08-01T11:00:00.000Z",
    });
    const revoked = connection({
      id: "ffffffff-ffff-4fff-bfff-ffffffffffff",
      status: "revoked",
      updatedAt: "2026-08-01T12:00:00.000Z",
    });

    expect(selectCanonicalPersonalSlackConnection([revoked, error, needsReauth])).toBe(needsReauth);
  });
});
