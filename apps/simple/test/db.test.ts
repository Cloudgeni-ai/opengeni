import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The store opens at import time, so point it at a throwaway directory first.
const directory = mkdtempSync(join(tmpdir(), "simple-db-"));
process.env.OPENGENI_SIMPLE_DATA_DIR = directory;
const store = await import("../server/db");
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("applied blocks", () => {
  test("a block is claimed exactly once", () => {
    expect(store.claimBlock("agent:abc", "ws", "agent")).toBe(true);
    expect(store.claimBlock("agent:abc", "ws", "agent")).toBe(false);
    store.settleBlock("agent:abc", "applied", { sessionId: "s1", name: "Runner" });
    expect(store.getAppliedBlock("agent:abc")).toEqual({
      key: "agent:abc",
      kind: "agent",
      state: "applied",
      result: { sessionId: "s1", name: "Runner" },
    });
  });

  test("a released claim can be retried", () => {
    expect(store.claimBlock("agent:retry", "ws", "agent")).toBe(true);
    store.releaseBlock("agent:retry");
    expect(store.claimBlock("agent:retry", "ws", "agent")).toBe(true);
  });
});

describe("usage", () => {
  test("recent opens and sends add up per agent, ignoring unknown kinds", () => {
    store.recordUsage("ws-usage", "a", "open");
    store.recordUsage("ws-usage", "a", "send");
    store.recordUsage("ws-usage", "b", "open");
    store.recordUsage("ws-usage", "b", "bogus");
    const summary = new Map(
      store.usageSummary("ws-usage").map((entry) => [entry.sessionId, entry]),
    );
    expect(summary.get("a")!.score).toBeGreaterThan(summary.get("b")!.score);
    expect(summary.get("a")!.lastUsedAt).not.toBeNull();
  });
});

describe("profiles and prefs", () => {
  test("profile patches merge", () => {
    store.upsertProfile("ws", "s1", { name: "Runner", emoji: "🏃" });
    store.upsertProfile("ws", "s1", { description: "Tracks runs" });
    const profile = store.getProfile("s1");
    expect(profile?.name).toBe("Runner");
    expect(profile?.emoji).toBe("🏃");
    expect(profile?.description).toBe("Tracks runs");
  });

  test("a null pref value clears it", () => {
    store.setPrefs("ws", { replyLength: "detailed" });
    expect(store.getPrefs("ws").replyLength).toBe("detailed");
    store.setPrefs("ws", { replyLength: null });
    expect(store.getPrefs("ws").replyLength).toBeUndefined();
  });
});
