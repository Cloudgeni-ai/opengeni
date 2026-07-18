import { describe, expect, test } from "bun:test";
import { capSessionDiscoveryPage } from "../src/mcp/server";

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

describe("sessions_list compact discovery projection", () => {
  test("caps every unbounded field and the complete serialized page", () => {
    const huge = "x".repeat(50_000);
    const sessions = Array.from({ length: 100 }, (_, index) => ({
      id: uuid(index + 1),
      title: huge,
      parentSessionId: index === 0 ? null : uuid(1),
      status: "idle",
      effectiveControl: { state: "running", primaryBlocker: null },
      goal: { status: "active", text: huge },
      queuedPromptCount: index,
      treeStats: {
        directChildren: 0,
        totalDescendants: 0,
        runningDescendants: 0,
        queuedDescendants: 0,
        attentionDescendants: 0,
        pausedDescendants: 0,
        failedDescendants: 0,
      },
      latestMessage: { type: "agent.message.completed", preview: huge },
      createdAt: new Date(Date.UTC(2026, 6, 18, 0, 0, index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 6, 18, 0, 0, index)).toISOString(),
    }));
    const result = capSessionDiscoveryPage(
      {
        sessions,
        total: sessions.length,
        hasMore: false,
        nextCursor: null,
      } as any,
      true,
    );
    const serialized = JSON.stringify(result);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(128_000);
    expect(result.responseTruncated).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBeTruthy();
    expect(result.sessions[0]!.title).toContain("chars truncated");
    expect(result.sessions[0]!.goal!.summary).toContain("chars truncated");
    expect(result.sessions[0]!.latestMessage!.preview).toContain("chars truncated");
    expect(serialized).not.toContain(huge);
  });

  test("omits latest-message data unless explicitly requested", () => {
    const result = capSessionDiscoveryPage(
      {
        sessions: [
          {
            id: uuid(1),
            title: "one",
            parentSessionId: null,
            status: "idle",
            effectiveControl: { state: "running", primaryBlocker: null },
            goal: null,
            queuedPromptCount: 0,
            treeStats: {
              directChildren: 0,
              totalDescendants: 0,
              runningDescendants: 0,
              queuedDescendants: 0,
              attentionDescendants: 0,
              pausedDescendants: 0,
              failedDescendants: 0,
            },
            latestMessage: { type: "user.message", preview: "secret tail" },
            createdAt: "2026-07-18T00:00:00.000Z",
            updatedAt: "2026-07-18T00:00:00.000Z",
          },
        ],
        total: 1,
        hasMore: false,
        nextCursor: null,
      } as any,
      false,
    );
    expect(result.sessions[0]).not.toHaveProperty("latestMessage");
  });
});
