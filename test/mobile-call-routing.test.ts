import { expect, test } from "bun:test";
import {
  DEFAULT_OUTSIDE_CALL_TARGET,
  resolveOutsideCallTarget,
} from "../apps/mobile/src/call-routing";
import type { NativeOutsideCallContext } from "../packages/react-native/src/realtime/agent-call";

function fixture() {
  const calls: string[] = [];
  const context = {
    workspaceId: "workspace",
    requested: null,
    sessionExists: async (id: string) => {
      calls.push(`exists:${id}`);
      return true;
    },
    latestOrNew: async () => {
      calls.push("latest");
      return "latest";
    },
    client: {
      createSession: async (_workspace: string, input: unknown) => {
        expect(input).toEqual({ startMode: "realtime" });
        calls.push("create");
        return { id: "fresh" };
      },
    },
  } as unknown as NativeOutsideCallContext;
  const preferences = {
    target: DEFAULT_OUTSIDE_CALL_TARGET as "new" | "latest" | "pinned",
    pinned: { workspaceId: "workspace", sessionId: "pinned", title: "Pinned" },
    opened: "opened",
    unpin: () => {
      calls.push("unpin");
    },
    forgetOpened: () => {
      calls.push("forget");
    },
  };
  return { context, preferences, calls };
}

test("generic outside calls default fresh without consulting old sessions", async () => {
  const { context, preferences, calls } = fixture();
  expect(await resolveOutsideCallTarget(context, preferences)).toBe("fresh");
  expect(calls).toEqual(["create"]);
});
test.each(["new", "latest", "pinned"] as const)(
  "explicit entry overrides %s preference",
  async (target) => {
    const { context, preferences, calls } = fixture();
    expect(
      await resolveOutsideCallTarget(
        { ...context, requested: "explicit" },
        { ...preferences, target },
      ),
    ).toBe("explicit");
    expect(calls).toEqual([]);
  },
);
test("saved latest and pinned choices remain effective", async () => {
  const { context, preferences } = fixture();
  expect(await resolveOutsideCallTarget(context, { ...preferences, target: "latest" })).toBe(
    "opened",
  );
  expect(await resolveOutsideCallTarget(context, { ...preferences, target: "pinned" })).toBe(
    "pinned",
  );
});
test("missing pin starts fresh; wrong-workspace pin is never probed", async () => {
  const { context, preferences, calls } = fixture();
  context.sessionExists = async () => false;
  expect(await resolveOutsideCallTarget(context, { ...preferences, target: "pinned" })).toBe(
    "fresh",
  );
  expect(calls).toEqual(["unpin", "create"]);
  calls.length = 0;
  expect(
    await resolveOutsideCallTarget(context, {
      ...preferences,
      target: "pinned",
      pinned: { ...preferences.pinned, workspaceId: "other" },
    }),
  ).toBe("fresh");
  expect(calls).toEqual(["create"]);
});
test("unavailable saved latest falls back; transient errors do not silently clear it", async () => {
  const { context, preferences, calls } = fixture();
  context.sessionExists = async () => false;
  expect(await resolveOutsideCallTarget(context, { ...preferences, target: "latest" })).toBe(
    "latest",
  );
  expect(calls).toEqual(["forget", "latest"]);
  context.sessionExists = async () => {
    throw new Error("offline");
  };
  await expect(
    resolveOutsideCallTarget(context, { ...preferences, target: "pinned" }),
  ).rejects.toThrow("offline");
});
