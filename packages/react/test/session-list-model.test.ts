import { describe, expect, test } from "bun:test";
import type { Session } from "@opengeni/sdk";

import {
  applySessionPinToLists,
  groupSessionsByProject,
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
  test("project sections: server order, running first, Default last, sub-agents left out", () => {
    const projects = [
      { id: "p1", name: "Launch" },
      { id: "p2", name: "Empty" },
    ];
    const sections = groupSessionsByProject(
      [
        session("a", { channelId: "p1", updatedAt: "2026-10-03T11:00:00Z" } as Partial<Session>),
        session("b", {
          channelId: "p1",
          status: "running",
          updatedAt: "2026-10-03T08:00:00Z",
        } as Partial<Session>),
        session("c", { channelId: null } as Partial<Session>),
        session("d", { channelId: "gone" } as Partial<Session>),
        session("e", { channelId: "p1", parentSessionId: "a" } as Partial<Session>),
      ],
      projects,
    );
    expect(
      sections.map((section) => [section.name, section.sessions.map((row) => row.id)]),
    ).toEqual([
      ["Launch", ["b", "a"]],
      ["Default", ["d", "c"]],
    ]);
    expect(groupSessionsByProject([], projects, { keepEmpty: true }).map((s) => s.name)).toEqual([
      "Launch",
      "Empty",
    ]);
  });

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

  test("home leaves sub-agents to their parent, so they never crowd out conversations", () => {
    const mine = session("mine", { updatedAt: "2026-10-03T10:00:00Z" });
    const agents = Array.from({ length: 8 }, (_, index) =>
      session(`agent-${index}`, {
        status: "running",
        parentSessionId: "mine",
        updatedAt: "2026-10-03T11:50:00Z",
      }),
    );
    const pinnedAgent = session("pinned-agent", { pinned: true, parentSessionId: "mine" });
    expect(
      recentSessionsForHome([...agents, mine, pinnedAgent], [pinnedAgent], 6, now).map(
        (row) => row.id,
      ),
    ).toEqual(["mine"]);
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

describe("applySessionPinToLists", () => {
  const older = session("older", { updatedAt: "2026-10-03T08:00:00Z", pinVersion: 1 });
  const newer = session("newer", { updatedAt: "2026-10-03T11:30:00Z", pinVersion: 0 });
  const pinnedA = session("pinned-a", {
    pinned: true,
    pinnedAt: "2026-10-02T09:00:00Z",
    pinVersion: 3,
  });
  const lists = { pinned: [pinnedA], sessions: [newer, older] };
  const ids = (value: { pinned: Session[]; sessions: Session[] }) => ({
    pinned: value.pinned.map((row) => row.id),
    sessions: value.sessions.map((row) => row.id),
  });

  test("pinning moves a row to the pinned section, newest pin first", () => {
    const next = applySessionPinToLists(lists, {
      id: "older",
      pinned: true,
      pinnedAt: "2026-10-03T12:00:00Z",
      pinVersion: 2,
    });
    expect(ids(next)).toEqual({ pinned: ["older", "pinned-a"], sessions: ["newer"] });
    expect(next.pinned[0]).toMatchObject({ pinned: true, pinVersion: 2 });
  });

  test("unpinning returns the row to the ordinary rows by activity", () => {
    const next = applySessionPinToLists(lists, { id: "pinned-a", pinned: false, pinVersion: 4 });
    expect(ids(next)).toEqual({ pinned: [], sessions: ["newer", "pinned-a", "older"] });
    expect(next.sessions[1]).toMatchObject({ pinned: false, pinnedAt: null, pinVersion: 4 });
  });

  test("a response older than the row shown changes nothing", () => {
    expect(applySessionPinToLists(lists, { id: "pinned-a", pinned: false, pinVersion: 2 })).toBe(
      lists,
    );
  });

  test("a session in neither list is left out", () => {
    expect(applySessionPinToLists(lists, { id: "elsewhere", pinned: true, pinVersion: 1 })).toBe(
      lists,
    );
  });

  test("an authoritative read replaces an optimistic revision", () => {
    const optimistic = applySessionPinToLists(lists, {
      id: "newer",
      pinned: true,
      pinnedAt: "2026-10-03T12:00:00Z",
      pinVersion: 1,
    });
    const restored = applySessionPinToLists(
      optimistic,
      { id: "newer", pinned: false, pinnedAt: null, pinVersion: 0 },
      { authoritative: true },
    );
    expect(ids(restored)).toEqual(ids(lists));
    expect(restored.sessions[0]).toMatchObject({ pinned: false, pinVersion: 0 });
  });
});
