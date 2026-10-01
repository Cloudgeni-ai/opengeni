import { expect, test } from "bun:test";
import type { Session } from "@/types";
import { recentParentSessions } from "./sessions-group";

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    parentSessionId: null,
    status: "idle",
    pinned: false,
    createdAt: "2026-10-01T09:00:00Z",
    updatedAt: "2026-10-01T09:00:00Z",
    ...overrides,
  } as Session;
}

test("Recent excludes children and child pins before limiting, preserving root pin and working order", () => {
  const pinned = session("root-pin", { pinned: true });
  const childPin = session("child-pin", { pinned: true, parentSessionId: "root-pin" });
  const parents = Array.from({ length: 8 }, (_, index) => session(`root-${index}`));
  const children = Array.from({ length: 12 }, (_, index) =>
    session(`child-${index}`, { parentSessionId: "root-0", status: "running" }),
  );
  const running = session("working-root", { status: "running" });
  const input = [...children, childPin, pinned, ...parents, running];
  const before = [...input];
  expect(recentParentSessions(input, [childPin, pinned]).map((row) => row.id)).toEqual([
    "root-pin",
    "working-root",
    "root-7",
    "root-6",
    "root-5",
    "root-4",
  ]);
  expect(input).toEqual(before);
  expect(recentParentSessions(children, [childPin])).toEqual([]);
});

test("the Recent route requests only parents from the server before pagination", async () => {
  const source = await Bun.file(new URL("../routes/sessions-index.tsx", import.meta.url)).text();
  expect(source).toContain("useWorkspaceSessions({\n    parentSessionId: null,");
  expect(source).toContain("recentParentSessions(sessions, pinned)");
});
