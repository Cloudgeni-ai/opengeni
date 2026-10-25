import { describe, expect, test } from "bun:test";
import {
  ACCESSIBILITY_CHEAP_REBUILD_NODES,
  ACCESSIBILITY_REBUILD_INTERVAL_MS,
  accessibilityRebuildWanted,
  type AccessibilityRead,
} from "../src";

const wanted = (
  read: AccessibilityRead,
  lastNodeCount: number | null,
  firstReadOfCall = false,
  msSinceRebuild = 0,
) => accessibilityRebuildWanted({ read, lastNodeCount, firstReadOfCall, msSinceRebuild });

describe("accessibility rebuild policy", () => {
  const small = ACCESSIBILITY_CHEAP_REBUILD_NODES;
  const large = ACCESSIBILITY_CHEAP_REBUILD_NODES + 1;

  test("the look before a failure always rebuilds", () => {
    expect(wanted("final", small)).toBe(true);
    expect(wanted("final", 50_000)).toBe(true);
  });

  test("a tab not read yet rebuilds once to learn its size", () => {
    expect(wanted("read", null)).toBe(true);
    expect(wanted("outline", null)).toBe(true);
  });

  test("cheap pages rebuild for outlines, first reads and about once a second", () => {
    expect(wanted("outline", small)).toBe(true);
    expect(wanted("read", small, true)).toBe(true);
    expect(wanted("read", small, false, ACCESSIBILITY_REBUILD_INTERVAL_MS - 1)).toBe(false);
    expect(wanted("read", small, false, ACCESSIBILITY_REBUILD_INTERVAL_MS)).toBe(true);
    // A miss there is an ordinary poll: the call's first read already rebuilt.
    expect(wanted("miss", small, false, ACCESSIBILITY_REBUILD_INTERVAL_MS - 1)).toBe(false);
  });

  test("larger pages rebuild only after a first miss and before a failure", () => {
    expect(wanted("miss", large)).toBe(true);
    expect(wanted("outline", large)).toBe(false);
    expect(wanted("read", large, true)).toBe(false);
    expect(wanted("read", large, false, 60_000)).toBe(false);
  });
});
