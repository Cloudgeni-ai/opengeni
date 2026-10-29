import { expect, test } from "bun:test";
import type { Session } from "@opengeni/sdk";
import {
  cachedLists,
  rememberLists,
  rememberSessionRow,
  subscribeLists,
  withSessionRow,
} from "./session-list-cache";

const row = (id: string, patch: Partial<Session> = {}) =>
  ({
    id,
    workspaceId: "work",
    title: id,
    status: "idle",
    parentSessionId: null,
    createdAt: "2026-10-29T09:00:00Z",
    updatedAt: "2026-10-29T09:00:00Z",
    ...patch,
  }) as Session;

test("a chat's fresh row replaces its old one in place, or leads the list when new", () => {
  const lists = { pinned: [row("pinned")], sessions: [row("older"), row("used")] };
  const touched = withSessionRow(lists, row("used", { updatedAt: "2026-10-29T10:00:00Z" }));
  expect(touched.sessions.map((each) => each.id)).toEqual(["older", "used"]);
  expect(touched.sessions[1]!.updatedAt).toBe("2026-10-29T10:00:00Z");
  expect(withSessionRow(lists, row("pinned", { title: "Renamed" })).pinned[0]!.title).toBe(
    "Renamed",
  );
  expect(withSessionRow(lists, row("new")).sessions.map((each) => each.id)).toEqual([
    "new",
    "older",
    "used",
  ]);
  // Sub-agents are reached from their parent, never listed here.
  expect(withSessionRow(lists, row("child", { parentSessionId: "older" }))).toBe(lists);
});

test("lists below an open chat follow its row as soon as it changes", () => {
  rememberLists("work", { home: { pinned: [], sessions: [row("older")] } });
  const seen: string[][] = [];
  const stop = subscribeLists("work", (next) =>
    seen.push(next.home?.sessions.map((each) => each.id) ?? []),
  );
  rememberSessionRow(row("new"));
  expect(seen).toEqual([["new", "older"]]);
  expect(cachedLists("work").home?.sessions.map((each) => each.id)).toEqual(["new", "older"]);
  stop();
  rememberSessionRow(row("later"));
  expect(seen).toHaveLength(1);
  // A workspace with no list shown yet has nothing to keep current.
  rememberSessionRow(row("elsewhere", { workspaceId: "unseen" }));
  expect(cachedLists("unseen")).toEqual({});
});
