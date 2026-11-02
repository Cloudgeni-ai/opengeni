import { describe, expect, test } from "bun:test";

import { chatRowStatus } from "./actions/chat-status";
import { buildRailForest, summarizeRailNodes, summarizeRailRow } from "./sessions-group";
import type { Session } from "../types";

const activeControl = {
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
} as Session["effectiveControl"];

function tree(overrides: Partial<NonNullable<Session["treeStats"]>> = {}): Session["treeStats"] {
  return {
    directChildren: 0,
    totalDescendants: 0,
    runningDescendants: 0,
    queuedDescendants: 0,
    waitingDescendants: 0,
    attentionDescendants: 0,
    pausedDescendants: 0,
    failedDescendants: 0,
    unreadDescendants: 0,
    unreadFailedDescendants: 0,
    truncated: false,
    ...overrides,
  } as Session["treeStats"];
}

function session(patch: Partial<Session> & Pick<Session, "id">): Session {
  return {
    accountId: "account-1",
    workspaceId: "workspace-1",
    status: "idle",
    initialMessage: "hi",
    title: null,
    parentSessionId: null,
    channelId: null,
    pinned: false,
    pinnedAt: null,
    pinVersion: 0,
    unread: false,
    createdBy: { kind: "subject", subjectId: "user:test" },
    effectiveControl: activeControl,
    treeStats: tree(),
    createdAt: "2026-11-02T12:00:00.000Z",
    updatedAt: "2026-11-02T13:00:00.000Z",
    ...patch,
  } as Session;
}

const inputWait = { deadlineAt: "2026-11-02T14:00:00.000Z", reason: "Waiting for workers" };
const row = (value: Session) => ({ session: value, children: [], hasActiveDescendant: false });

describe("a chat's own unread reply in its sidebar row", () => {
  test("outranks a sub-session that is still working, and says it is", () => {
    const parent = session({
      id: "manager",
      unread: true,
      treeStats: tree({ directChildren: 2, totalDescendants: 2, runningDescendants: 2 }),
    });

    expect(summarizeRailRow(row(parent))).toEqual({
      kind: "unread",
      count: 1,
      total: 3,
      label: "1 unread · 2 working",
    });
    expect(chatRowStatus(parent).summary).toMatchObject({
      kind: "unread",
      label: "1 unread · 2 working",
    });
  });

  test("outranks the chat's own wait for its workers", () => {
    const parent = session({
      id: "manager",
      unread: true,
      inputWait,
      treeStats: tree({ directChildren: 1, totalDescendants: 1, runningDescendants: 1 }),
    });

    expect(summarizeRailRow(row(parent))).toMatchObject({
      kind: "unread",
      label: "1 unread · 1 working",
    });
    expect(
      summarizeRailRow(row(session({ id: "waiting", unread: true, inputWait }))),
    ).toMatchObject({ kind: "unread", label: "1 unread · 1 waiting to resume" });
  });

  test("outranks a queued sub-session", () => {
    expect(
      summarizeRailRow(
        row(
          session({
            id: "queued",
            unread: true,
            treeStats: tree({ directChildren: 1, totalDescendants: 1, queuedDescendants: 1 }),
          }),
        ),
      ),
    ).toMatchObject({ kind: "unread", label: "1 unread · 1 waiting to run" });
  });

  test("gives way to the chat's own running or queued turn, which posts progress mid-turn", () => {
    expect(
      summarizeRailRow(row(session({ id: "running", unread: true, status: "running" }))),
    ).toMatchObject({ kind: "active", label: "1 working" });
    expect(
      summarizeRailRow(row(session({ id: "queued", unread: true, status: "queued" }))),
    ).toMatchObject({ kind: "queued" });
    expect(
      summarizeRailRow(
        row(
          session({
            id: "manager",
            unread: true,
            status: "running",
            treeStats: tree({ directChildren: 1, totalDescendants: 1, runningDescendants: 1 }),
          }),
        ),
      ),
    ).toMatchObject({ kind: "active", label: "2 working" });
  });

  test("keeps the plain unread label over background work alone", () => {
    expect(
      summarizeRailRow(row(session({ id: "commands", unread: true, activelyWorking: true }))),
    ).toMatchObject({ kind: "unread", label: "1 unread" });
  });

  test("counts unread sub-sessions with the chat's own reply", () => {
    const parent = session({
      id: "manager",
      unread: true,
      treeStats: tree({
        directChildren: 2,
        totalDescendants: 2,
        runningDescendants: 1,
        unreadDescendants: 1,
      }),
    });

    expect(summarizeRailRow(row(parent))).toMatchObject({
      kind: "unread",
      count: 2,
      label: "2 unread · 1 working",
    });
  });

  test("still yields to anything that needs you, a failure or an unsent message", () => {
    const needsYou = session({
      id: "needs-you",
      unread: true,
      treeStats: tree({
        directChildren: 2,
        totalDescendants: 2,
        runningDescendants: 1,
        attentionDescendants: 1,
      }),
    });
    const failed = session({
      id: "failed",
      unread: true,
      treeStats: tree({
        directChildren: 2,
        totalDescendants: 2,
        runningDescendants: 1,
        failedDescendants: 1,
        unreadFailedDescendants: 1,
      }),
    });
    const unsent = session({ id: "unsent", unread: true, status: "running" });

    expect(summarizeRailRow(row(needsYou)).kind).toBe("needs_attention");
    expect(summarizeRailRow(row(failed)).kind).toBe("failed");
    expect(summarizeRailRow(row(unsent), new Map([["unsent", 1]])).kind).toBe("send_failed");
  });

  test("leaves the working marker alone when only a sub-session's reply is unread", () => {
    const parent = session({
      id: "manager",
      treeStats: tree({
        directChildren: 2,
        totalDescendants: 2,
        runningDescendants: 1,
        unreadDescendants: 1,
      }),
    });
    const waiting = session({ id: "waiting", inputWait });

    expect(summarizeRailRow(row(parent))).toMatchObject({ kind: "active", label: "1 working" });
    expect(summarizeRailRow(row(waiting))).toMatchObject({ kind: "waiting" });
    expect(chatRowStatus(parent).summary.kind).toBe("active");
  });

  test("an expanded manager's loaded worker rows keep their own spinners", () => {
    const forest = buildRailForest([
      session({
        id: "manager",
        unread: true,
        treeStats: tree({ directChildren: 1, totalDescendants: 1, runningDescendants: 1 }),
      }),
      session({ id: "worker", parentSessionId: "manager", status: "running" }),
    ]);
    const manager = [...forest.running, ...forest.grouped.flatMap((group) => group.sessions)].find(
      (node) => node.session.id === "manager",
    )!;

    expect(summarizeRailRow(manager).kind).toBe("unread");
    expect(summarizeRailRow(manager.children[0]!).kind).toBe("active");
  });

  test("section headers summarizing many chats keep working ahead of unread", () => {
    const nodes = [
      row(session({ id: "replied", unread: true })),
      row(session({ id: "working", status: "running" })),
    ];

    expect(summarizeRailNodes(nodes).kind).toBe("active");
  });
});
