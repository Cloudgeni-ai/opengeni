import { describe, expect, test } from "bun:test";

import {
  applySessionChannelMove,
  beginSessionChannelMove,
  commitSessionChannelMove,
  reconcileSessionChannelMoves,
  rollbackSessionChannelMove,
  type SessionChannelMoveOverrides,
} from "./session-channel-move";
import { buildRailForest, channelRailSections } from "./sessions-group";
import type { Session } from "../types";

function session(patch: Partial<Session> & Pick<Session, "id">): Session {
  return {
    accountId: "account-1",
    workspaceId: "workspace-1",
    status: "idle",
    initialMessage: "hi",
    title: null,
    parentSessionId: null,
    channelId: "channel-old",
    pinned: false,
    pinnedAt: null,
    pinVersion: 0,
    createdBy: { kind: "subject", subjectId: "user:test" },
    effectiveControl: {
      state: "active",
      controlVersion: 0,
      controlEtag: "active-0",
      directState: "active",
      primaryBlocker: null,
      additionalBlockerCount: 0,
      blockers: [],
      resumeOptions: [],
      override: null,
      settlement: null,
    },
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...patch,
  } as Session;
}

const CHANNELS = [
  { id: "channel-old", name: "Old" },
  { id: "channel-new", name: "New" },
];

function sectionSessionIds(sessions: readonly Session[]): Record<string, string[]> {
  return Object.fromEntries(
    channelRailSections(buildRailForest([...sessions]), CHANNELS).map((section) => [
      section.key,
      section.sessions.map((node) => node.session.id),
    ]),
  );
}

describe("optimistic session channel moves", () => {
  test("moves the row to the destination immediately without leaving an old-folder duplicate", () => {
    const original = session({ id: "session-1" });
    const overrides = beginSessionChannelMove(new Map(), original.id, "channel-new", 1);
    const projected = applySessionChannelMove(original, overrides.get(original.id));

    expect(sectionSessionIds([projected])).toEqual({
      "channel-old": [],
      "channel-new": ["session-1"],
    });
  });

  test("keeps a committed destination over a stale refetch until the server confirms it", () => {
    const stale = session({ id: "session-1", channelId: "channel-old" });
    let overrides: SessionChannelMoveOverrides = beginSessionChannelMove(
      new Map(),
      stale.id,
      "channel-new",
      1,
    );
    overrides = commitSessionChannelMove(overrides, stale.id, "channel-new", 1);

    const afterStaleRefetch = reconcileSessionChannelMoves(overrides, [stale]);
    expect(afterStaleRefetch).toBe(overrides);
    expect(applySessionChannelMove(stale, afterStaleRefetch.get(stale.id)).channelId).toBe(
      "channel-new",
    );

    const authoritative = session({ id: stale.id, channelId: "channel-new" });
    const reconciled = reconcileSessionChannelMoves(afterStaleRefetch, [authoritative]);
    expect(reconciled.size).toBe(0);
    expect(applySessionChannelMove(authoritative, reconciled.get(stale.id))).toBe(authoritative);
  });

  test("rolls a failed move back to the authoritative old folder", () => {
    const original = session({ id: "session-1" });
    const pending = beginSessionChannelMove(new Map(), original.id, "channel-new", 1);
    const rolledBack = rollbackSessionChannelMove(pending, original.id, 1);

    expect(rolledBack.size).toBe(0);
    expect(
      sectionSessionIds([applySessionChannelMove(original, rolledBack.get(original.id))]),
    ).toEqual({
      "channel-old": ["session-1"],
      "channel-new": [],
    });
  });

  test("a stale settlement cannot roll back a newer operation", () => {
    const first = beginSessionChannelMove(new Map(), "session-1", "channel-new", 1);
    const second = beginSessionChannelMove(first, "session-1", null, 2);

    expect(rollbackSessionChannelMove(second, "session-1", 1)).toBe(second);
    expect(commitSessionChannelMove(second, "session-1", "channel-new", 1)).toBe(second);
    expect(second.get("session-1")).toEqual({
      channelId: null,
      operation: 2,
      committed: false,
    });
  });
});
