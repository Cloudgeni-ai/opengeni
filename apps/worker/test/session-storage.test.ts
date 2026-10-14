import { describe, expect, mock, test } from "bun:test";
import { createSessionStorageActivities } from "../src/activities/session-storage";
import type { ActivityServices } from "../src/activities/types";

function services(observability: { info: unknown; warn: unknown }) {
  return async () =>
    ({
      db: {} as never,
      objectStorage: null,
      observability: observability as never,
    }) as unknown as ActivityServices;
}

describe("session storage maintenance", () => {
  test("runs one bounded lossless compaction pass and reports row failures without content", async () => {
    const info = mock(() => undefined);
    const warn = mock(() => undefined);
    const compactLegacyContent = mock(
      async (
        _db: unknown,
        options: {
          maxRows?: number;
          onRowError?: (candidate: Record<string, string>, error: unknown) => void;
        },
      ) => {
        options.onRowError?.(
          {
            kind: "tool_catalog",
            attemptId: "33333333-3333-4333-8333-333333333333",
            accountId: "11111111-1111-4111-8111-111111111111",
            workspaceId: "22222222-2222-4222-8222-222222222222",
            sessionId: "44444444-4444-4444-8444-444444444444",
          },
          new Error("contains private content"),
        );
        return compactLegacyContent.mock.calls.length === 1
          ? { scanned: 3, compacted: 2, skipped: 0, failed: 1 }
          : { scanned: 1, compacted: 0, skipped: 1, failed: 0 };
      },
    );
    const activities = createSessionStorageActivities(services({ info, warn }), {
      compactionRowsPerPass: 7,
      compactLegacyContent: compactLegacyContent as never,
      listFoldCandidates: async () => [],
    });

    expect(await activities.maintainSessionStorage()).toEqual({
      contentCompaction: { scanned: 4, compacted: 2, skipped: 1, failed: 1 },
      deltaFolding: { turns: 0, runs: 0, removedRows: 0, refused: 0, failed: 0 },
    });
    // It keeps compacting while a batch gains rows, then stops.
    expect(compactLegacyContent).toHaveBeenCalledTimes(2);
    expect(compactLegacyContent.mock.calls[0]?.[1]).toMatchObject({ maxRows: 7 });
    const attributes = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(attributes).toMatchObject({ kind: "tool_catalog", errorName: "Error" });
    expect(JSON.stringify(attributes)).not.toContain("private content");
    expect(info).toHaveBeenCalledTimes(1);
  });

  test("folds settled turns batch after batch and never retries a turn within a pass", async () => {
    const info = mock(() => undefined);
    const warn = mock(() => undefined);
    const turn = (id: string) => ({
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sessionId: "44444444-4444-4444-8444-444444444444",
      turnId: id,
    });
    const queue = [turn("t1"), turn("t2"), turn("t3")];
    const folded = new Set<string>();
    const activities = createSessionStorageActivities(services({ info, warn }), {
      compactLegacyContent: (async () => ({
        scanned: 0,
        compacted: 0,
        skipped: 0,
        failed: 0,
      })) as never,
      foldTurnsPerBatch: 1,
      // t3 keeps failing and so stays a candidate.
      listFoldCandidates: (async () => queue.filter((c) => !folded.has(c.turnId))) as never,
      foldTurn: (async (_db: unknown, candidate: { turnId: string }) => {
        if (candidate.turnId === "t3") throw new Error("boom");
        folded.add(candidate.turnId);
        return { runs: 2, removedRows: 10, refused: 0 };
      }) as never,
    });
    expect((await activities.maintainSessionStorage()).deltaFolding).toEqual({
      turns: 2,
      runs: 4,
      removedRows: 20,
      refused: 0,
      failed: 1,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
