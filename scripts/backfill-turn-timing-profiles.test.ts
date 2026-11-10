import { describe, expect, test } from "bun:test";
import type { recordMissingTurnTimingProfiles } from "@opengeni/db";
import {
  backfillTurnTimingProfiles,
  parseBackfillTurnTimingProfilesArguments,
} from "./backfill-turn-timing-profiles";

const WORKSPACES = Array.from(
  { length: 450 },
  (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
);
const listWorkspaces = async (_db: unknown, input: { afterId: string | null; limit: number }) =>
  WORKSPACES.filter((id) => input.afterId === null || id > input.afterId).slice(0, input.limit);

describe("turn timing profile backfill", () => {
  test("defaults to all history up to now and validates its arguments", () => {
    const now = new Date("2026-11-09T12:00:00.000Z");
    expect(parseBackfillTurnTimingProfilesArguments([], now)).toEqual({
      workspaceId: null,
      since: new Date(0),
      until: now,
    });
    expect(
      parseBackfillTurnTimingProfilesArguments(
        [
          "--workspace",
          WORKSPACES[1]!,
          "--since",
          "2026-10-01T00:00:00Z",
          "--until",
          "2026-11-01T00:00:00Z",
        ],
        now,
      ),
    ).toEqual({
      workspaceId: WORKSPACES[1]!,
      since: new Date("2026-10-01T00:00:00Z"),
      until: new Date("2026-11-01T00:00:00Z"),
    });
    expect(() => parseBackfillTurnTimingProfilesArguments(["--since"], now)).toThrow(
      "needs a value",
    );
    expect(() => parseBackfillTurnTimingProfilesArguments(["--since", "yesterday"], now)).toThrow(
      "ISO date",
    );
    expect(() => parseBackfillTurnTimingProfilesArguments(["--workspace", "x"], now)).toThrow(
      "workspace id",
    );
    expect(() => parseBackfillTurnTimingProfilesArguments(["--limit", "5"], now)).toThrow(
      "unknown argument",
    );
    expect(() =>
      parseBackfillTurnTimingProfilesArguments(["--since", "2026-11-10T00:00:00Z"], now),
    ).toThrow("after --since");
  });

  test("walks every workspace over the window and keeps going past failures", async () => {
    const seen: string[] = [];
    const lines: Record<string, unknown>[] = [];
    const window = { since: new Date(0), until: new Date("2026-11-09T12:00:00.000Z") };
    const record: typeof recordMissingTurnTimingProfiles = async (_db, input) => {
      seen.push(input.workspaceId);
      expect({ since: input.since, until: input.until }).toEqual(window);
      if (input.workspaceId === WORKSPACES[3]) throw new Error("connection reset");
      return { turns: 2, inserted: 2, updated: 0, failed: 0 };
    };
    const totals = await backfillTurnTimingProfiles(
      {} as never,
      { workspaceId: null, ...window },
      { record, listWorkspaces: listWorkspaces as never, log: (line) => lines.push(line) },
    );
    expect(seen).toEqual(WORKSPACES);
    expect(totals).toEqual({
      workspaces: WORKSPACES.length,
      turns: 2 * (WORKSPACES.length - 1),
      inserted: 2 * (WORKSPACES.length - 1),
      updated: 0,
      failed: 0,
      failedWorkspaces: 1,
    });
    expect(lines).toContainEqual({ workspaceId: WORKSPACES[3], error: "connection reset" });
  });

  test("one workspace when asked", async () => {
    const seen: string[] = [];
    const totals = await backfillTurnTimingProfiles(
      {} as never,
      { workspaceId: WORKSPACES[7]!, since: new Date(0), until: new Date() },
      {
        record: async (_db, input) => {
          seen.push(input.workspaceId);
          return { turns: 0, inserted: 0, updated: 0, failed: 0 };
        },
        listWorkspaces: async () => {
          throw new Error("not listed");
        },
        log: () => undefined,
      },
    );
    expect(seen).toEqual([WORKSPACES[7]!]);
    expect(totals.workspaces).toBe(1);
  });
});
