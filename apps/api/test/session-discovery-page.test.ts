import { describe, expect, test } from "bun:test";
import {
  capSessionDiscoveryPage,
  decodeSessionDiscoveryCursor,
  encodeSessionDiscoveryCursor,
} from "../src/mcp/server";

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

describe("sessions_list compact discovery projection", () => {
  test("stays deterministic and within the exact envelope at 1, 20, and 100 rows", () => {
    let previousBytes = 0;
    for (const count of [1, 20, 100]) {
      const sessions = Array.from({ length: count }, (_, index) => ({
        id: uuid(index + 1),
        title: `session-${index + 1}`,
        parentSessionId: null,
        status: "idle",
        effectiveControl: {
          state: "active",
          primaryBlocker: null,
          additionalBlockerCount: 0,
        },
        goal: { status: "active", text: `goal-${index + 1}` },
        queuedPromptCount: 0,
        treeStats: {
          directChildren: 0,
          totalDescendants: 0,
          runningDescendants: 0,
          queuedDescendants: 0,
          attentionDescendants: 0,
          pausedDescendants: 0,
          failedDescendants: 0,
          truncated: false,
        },
        latestMessage: {
          type: "agent.message",
          preview: `message-${index + 1}`,
        },
        createdAt: new Date(Date.UTC(2026, 6, 18, 0, 0, index)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 6, 18, 1, 0, index)).toISOString(),
        sortRevision: "0",
        sortAt: new Date(Date.UTC(2026, 6, 18, 0, 0, index))
          .toISOString()
          .replace(".000Z", ".123456Z"),
      }));
      const page = {
        sessions,
        total: count,
        hasMore: false,
        nextCursor: null,
        orderBy: "createdAt",
        snapshotAt: "2026-07-18T02:00:00.654321Z",
        snapshotRevision: "0",
        updatedThrough: null,
        updatedAfter: null,
      } as const;

      const first = capSessionDiscoveryPage(page as any, true);
      const second = capSessionDiscoveryPage(page as any, true);
      expect(second).toEqual(first);
      expect(first.bytes).toBe(Buffer.byteLength(JSON.stringify(first, null, 2), "utf8"));
      expect(first.bytes).toBeLessThanOrEqual(first.maxBytes);
      expect(first.bytes).toBeGreaterThan(previousBytes);
      expect(first.sessions).toHaveLength(count);
      expect(first.responseTruncated).toBeFalse();
      expect(first.hasMore).toBeFalse();
      expect(first.nextCursor).toBeNull();
      expect(
        first.sessions.every(
          (session) =>
            !session.titleTruncated &&
            !session.goal?.summaryTruncated &&
            !session.latestMessage?.previewTruncated,
        ),
      ).toBeTrue();
      previousBytes = first.bytes;
    }
  });

  test("caps every unbounded field and the complete serialized page", () => {
    const huge = "x".repeat(50_000);
    const sessions = Array.from({ length: 100 }, (_, index) => ({
      id: uuid(index + 1),
      title: huge,
      parentSessionId: index === 0 ? null : uuid(1),
      status: "idle",
      effectiveControl: {
        state: index === 0 ? "paused" : "active",
        primaryBlocker:
          index === 0
            ? {
                kind: "workspace",
                displayName: huge,
                displayNameOriginalChars: huge.length,
              }
            : null,
        additionalBlockerCount: index === 0 ? 7 : 0,
      },
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
        truncated: false,
      },
      latestMessage: { type: "agent.message.completed", preview: huge },
      createdAt: new Date(Date.UTC(2026, 6, 18, 0, 0, index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 6, 18, 0, 0, index)).toISOString(),
      sortRevision: "0",
      sortAt: new Date(Date.UTC(2026, 6, 18, 0, 0, index))
        .toISOString()
        .replace(".000Z", ".123456Z"),
    }));
    const result = capSessionDiscoveryPage(
      {
        sessions,
        total: sessions.length,
        hasMore: false,
        nextCursor: null,
        orderBy: "createdAt",
        snapshotAt: "2026-07-18T01:00:00.654321Z",
        snapshotRevision: "0",
        updatedThrough: null,
        updatedAfter: null,
      } as any,
      true,
    );
    const serialized = JSON.stringify(result, null, 2);
    expect(Buffer.byteLength(serialized, "utf8")).toBe(result.bytes);
    expect(result.bytes).toBeLessThanOrEqual(result.maxBytes);
    expect(result.responseTruncated).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBeTruthy();
    expect(result.sessions[0]!.title).toContain("chars truncated");
    expect(result.sessions[0]!.goal!.summary).toContain("chars truncated");
    expect(result.sessions[0]!.latestMessage!.preview).toContain("chars truncated");
    expect(result.latestMessagePreviewBudget!.omittedCount).toBe(
      result.sessions.filter((session) => session.latestMessage?.previewOmitted === true).length,
    );
    expect(result.sessions[0]!.pause).toMatchObject({
      state: "paused",
      additionalBlockerCount: 7,
      source: {
        kind: "workspace",
        displayNameTruncated: true,
      },
    });
    expect(serialized).not.toContain(huge);
  });

  test("budgets opt-in previews by deterministic UTF-8 bytes and exposes drill-down metadata", () => {
    const preview = "é".repeat(600);
    const sessions = Array.from({ length: 100 }, (_, index) => ({
      id: uuid(index + 1),
      title: `session-${index + 1}`,
      parentSessionId: null,
      status: "idle",
      effectiveControl: {
        state: "active",
        primaryBlocker: null,
        additionalBlockerCount: 0,
      },
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
        truncated: false,
      },
      latestMessage: { type: "agent.message.completed", preview },
      createdAt: new Date(Date.UTC(2026, 6, 18, 0, 0, index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 6, 18, 1, 0, index)).toISOString(),
      sortRevision: "0",
      sortAt: new Date(Date.UTC(2026, 6, 18, 0, 0, index))
        .toISOString()
        .replace(".000Z", ".123456Z"),
    }));
    const page = {
      sessions,
      total: sessions.length,
      hasMore: false,
      nextCursor: null,
      orderBy: "createdAt",
      snapshotAt: "2026-07-18T01:00:00.654321Z",
      snapshotRevision: "0",
      updatedThrough: null,
      updatedAfter: null,
    } as any;

    const result = capSessionDiscoveryPage(page, true);
    const serialized = JSON.stringify(result, null, 2);
    const previewBudget = result.latestMessagePreviewBudget!;
    expect(previewBudget).toEqual({
      bytes: 13 * Buffer.byteLength(preview, "utf8"),
      maxBytes: 16_384,
      omittedCount: 87,
      truncated: true,
      omissionReason: "aggregatePreviewBudget",
      drillDownTool: "session_get",
    });
    expect(previewBudget.bytes).toBe(15_600);
    expect(Math.ceil(previewBudget.bytes / 4)).toBe(3_900);
    expect(Math.ceil(previewBudget.maxBytes / 4)).toBe(4_096);
    expect(result.sessions).toHaveLength(100);
    expect(result.sessions[12]!.latestMessage).toMatchObject({
      preview,
      previewTruncated: false,
    });
    expect(result.sessions[13]!.latestMessage).toMatchObject({
      type: "agent.message.completed",
      preview: null,
      previewTruncated: false,
      previewOmitted: true,
      previewOmissionReason: "aggregatePreviewBudget",
      previewDrillDownTool: "session_get",
    });
    expect(result.sessions[13]!.latestMessage).not.toHaveProperty("text");
    expect(result.responseTruncated).toBeFalse();
    expect(result.hasMore).toBeFalse();
    expect(result.bytes).toBe(Buffer.byteLength(serialized, "utf8"));
    expect(result.bytes).toBeLessThanOrEqual(result.maxBytes);

    const withoutPreview = capSessionDiscoveryPage(page, false);
    expect(withoutPreview).not.toHaveProperty("latestMessagePreviewBudget");
    expect(withoutPreview.sessions.every((session) => !session.latestMessage)).toBeTrue();
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
            effectiveControl: {
              state: "active",
              primaryBlocker: null,
              additionalBlockerCount: 0,
            },
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
              truncated: false,
            },
            latestMessage: { type: "user.message", preview: "secret tail" },
            createdAt: "2026-07-18T00:00:00.000Z",
            updatedAt: "2026-07-18T00:00:00.000Z",
            sortRevision: "0",
            sortAt: "2026-07-18T00:00:00.000001Z",
          },
        ],
        total: 1,
        hasMore: false,
        nextCursor: null,
        orderBy: "createdAt",
        snapshotAt: "2026-07-18T01:00:00.000001Z",
        snapshotRevision: "0",
        updatedThrough: null,
        updatedAfter: null,
      } as any,
      false,
    );
    expect(result.sessions[0]).not.toHaveProperty("latestMessage");
  });

  test("round-trips versioned cursors, upgrades legacy cursors, and rejects tampering", () => {
    const cursor = {
      orderBy: "updatedAt" as const,
      sortRevision: "42",
      sortAt: "2026-07-19T14:58:57.123456Z",
      id: uuid(9),
      snapshotAt: "2026-07-19T15:00:00.654321Z",
      snapshotRevision: "50",
      updatedAfter: "12",
    };
    const encoded = encodeSessionDiscoveryCursor(cursor);
    expect(encoded).not.toContain("2026");
    expect(decodeSessionDiscoveryCursor(encoded)).toEqual(cursor);

    const legacy = Buffer.from(
      JSON.stringify({ createdAt: cursor.sortAt, id: cursor.id }),
      "utf8",
    ).toString("base64url");
    expect(decodeSessionDiscoveryCursor(legacy)).toEqual({
      orderBy: "createdAt",
      sortRevision: "0",
      sortAt: cursor.sortAt,
      id: cursor.id,
      snapshotAt: cursor.sortAt,
      snapshotRevision: "0",
      updatedAfter: null,
    });
    const incompatible = Buffer.from(
      JSON.stringify({ v: 2, ...cursor, orderBy: "createdAt" }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeSessionDiscoveryCursor(incompatible)).toThrow(
      "sessions_list cursor is invalid",
    );
  });
});
