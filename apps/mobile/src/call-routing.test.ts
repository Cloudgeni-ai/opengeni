import { expect, test } from "bun:test";
import type { NativeOutsideCallContext } from "@opengeni/react-native";
import { resolveOutsideCallTarget, type OutsideCallTarget } from "./call-routing";

function context(patch: Partial<NativeOutsideCallContext> & { existing?: string[] }) {
  const created: string[] = [];
  const checked: string[] = [];
  const value = {
    client: {
      createSession: async () => {
        created.push("new");
        return { id: "new" };
      },
    } as unknown as NativeOutsideCallContext["client"],
    workspaceId: "work",
    requested: null,
    sessionExists: async (id: string) => {
      checked.push(id);
      return (patch.existing ?? []).includes(id);
    },
    latestOrNew: async () => "latest",
    ...patch,
  } satisfies NativeOutsideCallContext;
  return { value, created, checked };
}

const preferences = (target: OutsideCallTarget = "new", missing?: (id: string) => Error) => ({
  target,
  pinned: { workspaceId: "work", sessionId: "pinned", title: "Pinned" },
  opened: null,
  unpin() {},
  forgetOpened() {},
  ...(missing ? { missing } : {}),
});

test("a voice command calls its own chat, ahead of the outside-call preference", async () => {
  const { value, created } = context({
    workspaceId: "other",
    requested: "research",
    requestedWorkspaceId: "other",
    existing: ["research", "pinned"],
  });
  expect(await resolveOutsideCallTarget(value, preferences("pinned"))).toBe("research");
  expect(created).toEqual([]);
});

test("a voice command whose chat is gone fails clearly instead of calling another chat", async () => {
  const { value, created } = context({
    requested: "gone",
    requestedWorkspaceId: "work",
    existing: ["pinned"],
  });
  const result = resolveOutsideCallTarget(
    value,
    preferences("pinned", (id) => new Error(`missing ${id}`)),
  );
  await expect(result).rejects.toThrow("missing gone");
  expect(created).toEqual([]);
});

test("a session-only request (an older recent call) still goes straight to that session", async () => {
  const { value, checked } = context({ requested: "recent" });
  expect(await resolveOutsideCallTarget(value, preferences("pinned"))).toBe("recent");
  expect(checked).toEqual([]);
});

test("a request without a chat follows the outside-call preference", async () => {
  const { value } = context({ existing: ["pinned"] });
  expect(await resolveOutsideCallTarget(value, preferences("pinned"))).toBe("pinned");
  expect(await resolveOutsideCallTarget(value, preferences("new"))).toBe("new");
});
