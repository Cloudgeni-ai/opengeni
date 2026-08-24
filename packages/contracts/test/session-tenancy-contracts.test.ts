import { describe, expect, test } from "bun:test";
import {
  ForkSessionRequest,
  ForkSessionResponse,
  UpdateSessionVisibilityRequest,
  UpdateSessionVisibilityResponse,
} from "../src";

const operationId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "44444444-4444-4444-8444-444444444444";

describe("session tenancy public contracts", () => {
  test("normalizes the required bounded idempotency key and epoch", () => {
    expect(
      UpdateSessionVisibilityRequest.parse({
        visibility: "private",
        expectedAuthorityEpoch: 2,
        idempotencyKey: "  visibility-1  ",
      }),
    ).toEqual({
      visibility: "private",
      expectedAuthorityEpoch: 2,
      idempotencyKey: "visibility-1",
    });
    expect(
      UpdateSessionVisibilityRequest.safeParse({
        visibility: "private",
        expectedAuthorityEpoch: 0,
        idempotencyKey: "",
      }).success,
    ).toBe(false);
    expect(
      ForkSessionRequest.safeParse({
        idempotencyKey: "copy-session-1",
        visibility: "workspace",
        workspaceSharedAcknowledged: true,
        workspaceId,
      }).success,
    ).toBe(false);
    expect(
      ForkSessionRequest.parse({
        idempotencyKey: "copy-session-1",
        visibility: "workspace",
        workspaceSharedAcknowledged: true,
      }),
    ).toEqual({
      idempotencyKey: "copy-session-1",
      visibility: "workspace",
      workspaceSharedAcknowledged: true,
    });
    expect(
      ForkSessionRequest.safeParse({
        idempotencyKey: "copy-session-1",
        visibility: "private",
        workspaceSharedAcknowledged: true,
      }).success,
    ).toBe(false);
  });

  test("requires a complete durable event receipt exactly when visibility changed", () => {
    const base = {
      operationId,
      visibility: "workspace" as const,
      authorityEpoch: 2,
      replay: false,
      revokedGrantCount: 0,
    };
    expect(
      UpdateSessionVisibilityResponse.safeParse({
        ...base,
        eventId,
        eventSequence: 4,
        changed: true,
      }).success,
    ).toBe(true);
    expect(
      UpdateSessionVisibilityResponse.safeParse({
        ...base,
        eventId: null,
        eventSequence: null,
        changed: false,
      }).success,
    ).toBe(true);
    expect(
      UpdateSessionVisibilityResponse.safeParse({
        ...base,
        eventId,
        eventSequence: null,
        changed: true,
      }).success,
    ).toBe(false);
  });

  test("returns the selected fork visibility", () => {
    expect(
      ForkSessionResponse.parse({
        operationId,
        eventId,
        eventSequence: 1,
        sessionId,
        workspaceId,
        visibility: "private",
        authorityEpoch: 1,
        copiedHistoryItemCount: 3,
        replay: false,
      }),
    ).toMatchObject({ visibility: "private", authorityEpoch: 1 });
    expect(
      ForkSessionResponse.parse({
        operationId,
        eventId,
        eventSequence: 1,
        sessionId,
        workspaceId,
        visibility: "workspace",
        authorityEpoch: 1,
        copiedHistoryItemCount: 3,
        replay: false,
      }),
    ).toMatchObject({ visibility: "workspace", authorityEpoch: 1 });
  });
});
