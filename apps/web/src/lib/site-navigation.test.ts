import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";

import { latestSiteMutationSequence } from "./site-navigation";

function event(sequence: number, type: SessionEvent["type"], payload: unknown): SessionEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: "workspace-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: "2026-09-03T00:00:00.000Z",
  };
}

describe("Site navigation refresh", () => {
  test("tracks only settled Site create and publish calls", () => {
    expect(
      latestSiteMutationSequence([
        event(1, "agent.toolCall.created", { id: "ordinary", name: "exec_command" }),
        event(2, "agent.toolCall.output", { id: "ordinary", output: "ok" }),
        event(3, "agent.toolCall.created", {
          id: "create",
          name: "opengeni__artifacts_create",
        }),
        event(4, "agent.toolCall.output", { id: "create", output: "created" }),
        event(5, "agent.toolCall.created", { id: "publish", name: "artifacts_publish" }),
        event(6, "agent.toolCall.output", { id: "publish", output: "published" }),
      ]),
    ).toBe(6);
  });

  test("does not refresh for an unsettled Site call or unmatched output", () => {
    expect(
      latestSiteMutationSequence([
        event(1, "agent.toolCall.created", { id: "create", name: "artifacts_create" }),
        event(2, "agent.toolCall.output", { id: "different", output: "created" }),
      ]),
    ).toBe(0);
  });
});
