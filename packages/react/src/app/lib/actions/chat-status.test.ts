import { describe, expect, test } from "bun:test";
import type { Session } from "../../types";

import { readChatDirectory, rememberChats } from "./chat-directory";
import { CHAT_STATUS_FRESH_MS, chatRowStatus, currentChatStatus } from "./chat-status";

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    workspaceId: "w1",
    parentSessionId: null,
    status: "idle",
    title: id,
    titleSource: "user",
    effectiveControl: { state: "active" },
    createdBy: { kind: "user", subjectId: "user-1", label: "Ada Lovelace" },
    createdAt: "2026-10-22T10:00:00.000Z",
    updatedAt: "2026-10-22T10:00:00.000Z",
    ...extra,
  } as Session;
}

describe("chat status in the command menu and switcher", () => {
  test("shows exactly the sidebar row's marks", () => {
    expect(chatRowStatus(session("a", { status: "running" })).summary.kind).toBe("active");
    const waiting = chatRowStatus(
      session("b", {
        status: "requires_action",
        requiresActionSince: "2026-10-22T09:00:00.000Z",
      } as Partial<Session>),
      new Date("2026-10-22T10:00:00.000Z"),
    );
    expect(waiting.summary.kind).toBe("needs_attention");
    expect(waiting.summary.label).toContain("needs you");
    const done = chatRowStatus(session("c", { hasUpcomingSchedules: true } as Partial<Session>));
    expect(done.summary.kind).toBe("neutral");
    expect(done.scheduled).toBe(true);
    expect(done.creator?.subjectId).toBe("user-1");
    // A subagent's chat names no creator, as in the sidebar.
    expect(chatRowStatus(session("d", { parentSessionId: "a" })).creator).toBeNull();
  });

  test("a status shows only while it is known to be current", () => {
    rememberChats("subject-status", [session("fresh", { status: "running" })]);
    const record = readChatDirectory("subject-status", "w1").rows.get("fresh")!;
    const now = record.readAt;
    expect(currentChatStatus(record, new Set(), now)?.summary.kind).toBe("active");
    const later = now + CHAT_STATUS_FRESH_MS + 1;
    expect(currentChatStatus(record, new Set(), later)).toBeNull();
    // The sidebar on screen keeps its rows live.
    expect(currentChatStatus(record, new Set(["fresh"]), later)?.summary.kind).toBe("active");
  });

  test("a status change alone updates the lists", () => {
    const subject = "subject-status-change";
    rememberChats(subject, [session("x")]);
    const before = readChatDirectory(subject, "w1").version;
    // Same title and time, new status.
    rememberChats(subject, [session("x", { status: "running" })]);
    expect(readChatDirectory(subject, "w1").version).toBe(before + 1);
    // Read again unchanged: the row is renewed without re-rendering.
    rememberChats(subject, [session("x", { status: "running" })]);
    expect(readChatDirectory(subject, "w1").version).toBe(before + 1);
    expect(readChatDirectory(subject, "w1").rows.get("x")?.row?.status).toBe("running");
  });
});
