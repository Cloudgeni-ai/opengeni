import { describe, expect, test } from "bun:test";
import { OpenGeniCoreClient } from "@opengeni/sdk/core";

import {
  applySessionChannelMove,
  beginSessionChannelMove,
  commitSessionChannelMove,
  readSessionChannelMovePoint,
  reconcileSessionChannelMovePointRead,
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
  test("queues the post-write point read behind an active pre-write fresh generation", async () => {
    let requests = 0;
    let releaseInitial!: () => void;
    let releasePreWriteFresh!: () => void;
    let markPreWriteFreshStarted!: () => void;
    let writeCommitted = false;
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const preWriteFreshGate = new Promise<void>((resolve) => {
      releasePreWriteFresh = resolve;
    });
    const preWriteFreshStarted = new Promise<void>((resolve) => {
      markPreWriteFreshStarted = resolve;
    });
    const client = new OpenGeniCoreClient({
      baseUrl: "https://api.example.test",
      fetch: async () => {
        requests += 1;
        const request = requests;
        const channelId = writeCommitted ? "channel-new" : "channel-old";
        if (request === 1) await initialGate;
        if (request === 2) {
          markPreWriteFreshStarted();
          await preWriteFreshGate;
        }
        return new Response(
          JSON.stringify(
            session({
              id: "session-1",
              channelId,
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const initial = client.getSession("workspace-1", "session-1");
    const preWriteFresh = client.getSession("workspace-1", "session-1", { fresh: true });
    releaseInitial();
    await preWriteFreshStarted;

    writeCommitted = true;
    const postWrite = readSessionChannelMovePoint(client, "workspace-1", "session-1");
    await Bun.sleep(1);
    expect(requests).toBe(2);

    releasePreWriteFresh();
    expect((await initial).channelId).toBe("channel-old");
    expect((await preWriteFresh).channelId).toBe("channel-old");
    expect((await postWrite).channelId).toBe("channel-new");
    expect(requests).toBe(3);
  });

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
    expect(
      reconcileSessionChannelMovePointRead(
        afterStaleRefetch,
        stale.id,
        1,
        session({ id: stale.id, channelId: "channel-new" }),
      ),
    ).toBe(afterStaleRefetch);
    expect(applySessionChannelMove(stale, afterStaleRefetch.get(stale.id)).channelId).toBe(
      "channel-new",
    );

    const authoritative = session({ id: stale.id, channelId: "channel-new" });
    const reconciled = reconcileSessionChannelMoves(afterStaleRefetch, [authoritative]);
    expect(reconciled.size).toBe(0);
    expect(applySessionChannelMove(authoritative, reconciled.get(stale.id))).toBe(authoritative);
  });

  test("lets an exact post-write read supersede a move that another client changed again", () => {
    const stale = session({ id: "session-1", channelId: "channel-old" });
    let overrides = beginSessionChannelMove(new Map(), stale.id, "channel-new", 1);
    overrides = commitSessionChannelMove(overrides, stale.id, "channel-new", 1);

    const movedAgain = session({ id: stale.id, channelId: "channel-latest" });
    const superseded = reconcileSessionChannelMovePointRead(overrides, stale.id, 1, movedAgain);
    expect(applySessionChannelMove(stale, superseded.get(stale.id)).channelId).toBe(
      "channel-latest",
    );

    const reconciled = reconcileSessionChannelMoves(superseded, [movedAgain]);
    expect(reconciled.size).toBe(0);
  });

  test("retires a committed override when a post-write point read confirms deletion", () => {
    const original = session({ id: "session-1" });
    let overrides = beginSessionChannelMove(new Map(), original.id, "channel-new", 1);
    overrides = commitSessionChannelMove(overrides, original.id, "channel-new", 1);

    expect(reconcileSessionChannelMovePointRead(overrides, original.id, 1, null).size).toBe(0);
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
