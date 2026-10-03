import { describe, expect, test } from "bun:test";
import type { Session } from "@opengeni/sdk";

import {
  groupSessionsForRail,
  recentSessionModelPresentation,
  recentSessionStatus,
  recentSessionsForHome,
  relativeTimeLabel,
  sessionRepoLabel,
} from "../src/session-list-model";

const now = new Date("2026-10-03T12:00:00Z");

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    status: "idle",
    updatedAt: "2026-10-03T11:00:00Z",
    createdAt: "2026-10-03T10:00:00Z",
    pinned: false,
    pinnedAt: null,
    effectiveControl: { state: "active" },
    inputWait: null,
    resources: [],
    model: "codex/gpt-6-luna",
    ...overrides,
  } as unknown as Session;
}

describe("session-list-model", () => {
  test("relative time labels", () => {
    expect(relativeTimeLabel("2026-10-03T11:59:30Z", now)).toBe("now");
    expect(relativeTimeLabel("2026-10-03T11:55:00Z", now)).toBe("5m");
    expect(relativeTimeLabel("2026-10-03T09:00:00Z", now)).toBe("3h");
    expect(relativeTimeLabel("2026-10-01T12:00:00Z", now)).toBe("2d");
    expect(relativeTimeLabel("not a date", now)).toBe("");
  });

  test("home order: pins, then running, then recency", () => {
    const pinned = session("p", { pinned: true, pinnedAt: "2026-10-03T08:00:00Z" });
    const running = session("r", { status: "running", updatedAt: "2026-10-01T00:00:00Z" });
    const recent = session("a", { updatedAt: "2026-10-03T11:30:00Z" });
    const older = session("b", { updatedAt: "2026-09-01T00:00:00Z" });
    const rows = recentSessionsForHome([older, pinned, recent, running], [pinned], 6, now);
    expect(rows.map((row) => row.id)).toEqual(["p", "r", "a", "b"]);
    expect(
      recentSessionsForHome([older, recent, running], [], 2, now).map((row) => row.id),
    ).toEqual(["r", "a"]);
    expect(groupSessionsForRail([older, recent], now).grouped.map((group) => group.label)).toEqual([
      "Today",
      "Older",
    ]);
  });

  test("status dot: background commands read as running", () => {
    expect(recentSessionStatus(session("x"))).toEqual({ tone: "idle", pulse: false });
    expect(recentSessionStatus(session("x", { status: "requires_action" }))).toEqual({
      tone: "waiting",
      pulse: false,
    });
    expect(
      recentSessionStatus(
        session("x", { backgroundCommandActivity: {} as Session["backgroundCommandActivity"] }),
      ),
    ).toEqual({ tone: "running", pulse: true });
  });

  test("row metadata: catalog label, codex fallback and repo", () => {
    expect(recentSessionModelPresentation("codex/gpt-6-luna", [])).toEqual({
      label: expect.any(String),
      billingClass: "codex_subscription",
    });
    expect(
      sessionRepoLabel(
        session("x", {
          resources: [{ kind: "repository", uri: "https://github.com/acme/app.git", ref: "main" }],
        } as Partial<Session>),
      ),
    ).toBe("acme/app");
  });
});
