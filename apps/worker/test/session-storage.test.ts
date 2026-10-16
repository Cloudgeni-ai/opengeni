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
    });

    expect(await activities.maintainSessionStorage()).toEqual({
      contentCompaction: { scanned: 4, compacted: 2, skipped: 1, failed: 1 },
    });
    // It keeps compacting while a batch gains rows, then stops.
    expect(compactLegacyContent).toHaveBeenCalledTimes(2);
    expect(compactLegacyContent.mock.calls[0]?.[1]).toMatchObject({ maxRows: 7 });
    const attributes = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(attributes).toMatchObject({ kind: "tool_catalog", errorName: "Error" });
    expect(JSON.stringify(attributes)).not.toContain("private content");
    expect(info).toHaveBeenCalledTimes(1);
  });
});
