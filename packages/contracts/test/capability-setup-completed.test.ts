import { describe, expect, test } from "bun:test";
import {
  ContinueAfterCapabilitySetupRequest,
  ContinueAfterCapabilitySetupResponse,
  isTransientSessionSystemUpdateBatch,
  SESSION_SYSTEM_UPDATE_WAKE_CLASS,
  SessionSystemUpdateKind,
  SessionSystemUpdatePayload,
  capabilitySetupCompletedSummary,
  sessionSystemUpdateBatchHistoryItem,
} from "../src/index";

const updateId = "0b6f1c1e-3d0f-4c55-8f0a-2b4a3c8d9e10";
const cardEventId = "6a1d2c3b-4e5f-4a7b-8c9d-0e1f2a3b4c5d";
const causalTurnId = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f";

describe("capability_setup_completed", () => {
  test("is a turn-starting kind with a strict payload", () => {
    expect(SessionSystemUpdateKind.parse("capability_setup_completed")).toBe(
      "capability_setup_completed",
    );
    expect(SESSION_SYSTEM_UPDATE_WAKE_CLASS.capability_setup_completed).toBe("immediate");
    const payload = {
      type: "capability_setup_completed" as const,
      capabilityId: "mcp:mail",
      name: "Mail",
      cardEventId,
    };
    expect(SessionSystemUpdatePayload.parse(payload)).toEqual(payload);
    expect(
      SessionSystemUpdatePayload.safeParse({ ...payload, cardEventId: "not-a-uuid" }).success,
    ).toBe(false);
  });

  test("renders one plain fact inside the existing internal-update envelope", () => {
    const summary = capabilitySetupCompletedSummary("Mail", true);
    expect(summary).toBe(
      "The person finished setting up Mail from your request. Its tools are now available, so continue the request that needed it.",
    );
    expect(capabilitySetupCompletedSummary("Mail", false)).toBe(
      "The person finished setting up Mail from your request, so continue the request that needed it.",
    );
    const item = sessionSystemUpdateBatchHistoryItem([
      {
        id: updateId,
        kind: "capability_setup_completed",
        classification: "success",
        sourceId: cardEventId,
        summary,
        payload: {
          type: "capability_setup_completed",
          capabilityId: "mcp:mail",
          name: "Mail",
          cardEventId,
        },
        lineage: { causalTurnId },
      },
    ]);
    expect(item).toEqual({
      type: "message",
      role: "system",
      content: [
        "[Opengeni internal updates]",
        "These platform updates were delivered together for this inference.",
        JSON.stringify({
          updates: [
            {
              id: updateId,
              kind: "capability_setup_completed",
              classification: "success",
              sourceId: cardEventId,
              summary,
              payload: {
                type: "capability_setup_completed",
                capabilityId: "mcp:mail",
                name: "Mail",
                cardEventId,
              },
              lineage: { causalTurnId },
            },
          ],
        }),
      ].join("\n"),
    });
    // A nudge to continue: compaction need not keep it verbatim once newer
    // input exists, like a goal continuation.
    expect(isTransientSessionSystemUpdateBatch(item)).toBe(true);
  });

  test("the endpoint takes a capability id and answers with an outcome", () => {
    expect(ContinueAfterCapabilitySetupRequest.parse({ capabilityId: " mcp:mail " })).toEqual({
      capabilityId: "mcp:mail",
    });
    expect(ContinueAfterCapabilitySetupRequest.safeParse({ capabilityId: "" }).success).toBe(false);
    expect(ContinueAfterCapabilitySetupResponse.parse({ outcome: "queued", updateId })).toEqual({
      outcome: "queued",
      updateId,
    });
    expect(
      ContinueAfterCapabilitySetupResponse.parse({
        outcome: "not_needed",
        reason: "later_message",
      }),
    ).toEqual({ outcome: "not_needed", reason: "later_message" });
  });
});
