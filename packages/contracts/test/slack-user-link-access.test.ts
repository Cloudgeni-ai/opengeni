import { describe, expect, test } from "bun:test";

import {
  ApproveSlackUserLinkAccessRequest,
  ListSlackUserLinkAccessRequestsResponse,
  PrepareSlackUserLinkAccessRequest,
  SlackUserLinkAccessMutationRequest,
  SlackUserLinkAccessRequest,
} from "../src/index";

const request = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  workspaceDisplayName: "Platform",
  subjectLabel: "Ada",
  status: "pending",
  version: 2,
  expiresAt: "2026-08-10T14:00:00.000Z",
  requestedAt: "2026-08-10T13:45:00.000Z",
  decidedAt: null,
  completedAt: null,
  createdAt: "2026-08-10T13:44:00.000Z",
  updatedAt: "2026-08-10T13:45:00.000Z",
} as const;

describe("Slack user-link access contracts", () => {
  test("exposes only token-free durable continuation state", () => {
    expect(SlackUserLinkAccessRequest.parse(request)).toEqual(request);
    expect(ListSlackUserLinkAccessRequestsResponse.parse({ requests: [request] })).toEqual({
      requests: [request],
    });
    expect(Object.keys(request)).not.toContain("linkToken");
    expect(Object.keys(request)).not.toContain("tokenDigest");
  });

  test("bounds the signed bearer and requires CAS plus idempotency", () => {
    expect(PrepareSlackUserLinkAccessRequest.parse({ linkToken: "signed" })).toEqual({
      linkToken: "signed",
    });
    expect(
      SlackUserLinkAccessMutationRequest.parse({
        expectedVersion: 2,
        idempotencyKey: "request-access-1",
      }),
    ).toEqual({ expectedVersion: 2, idempotencyKey: "request-access-1" });
    expect(
      ApproveSlackUserLinkAccessRequest.safeParse({
        expectedVersion: 2,
        idempotencyKey: "approve-1",
        permissions: [],
      }).success,
    ).toBe(false);
  });
});
