import { expect, test } from "bun:test";
import { act } from "react";
import { useWorkspaceBackgroundCommands } from "../src/hooks/use-workspace-background-commands";
import { fakeClient, WORKSPACE_ID, SESSION_ID } from "./fake-client";
import { flush, registerDom, renderHook } from "./render-hook";
import type { WorkspaceBackgroundCommand } from "@opengeni/sdk";

registerDom();
const command = (id: string, sessionId = SESSION_ID): WorkspaceBackgroundCommand => ({
  id,
  sessionId,
  workspaceId: WORKSPACE_ID,
  provider: "connected_machine",
  state: "running",
  commandPreview: "bun run dev",
  sessionTitle: "Build preview",
  machineName: "Development computer",
  startedAt: "2026-10-18T10:00:00Z",
  updatedAt: "2026-10-18T10:00:00Z",
  settledAt: null,
  cancelRequestedAt: null,
  exitCode: null,
  settlementReason: null,
});

test("workspace list paginates and Stop uses the selected command's owning chat", async () => {
  const stops: string[][] = [];
  const cursors: Array<string | undefined> = [];
  const secondSession = "00000000-0000-4000-8000-000000000002";
  const client = fakeClient({
    listWorkspaceBackgroundCommands: async (_workspace, options) => {
      cursors.push(options?.cursor);
      return options?.cursor
        ? { commands: [command("second", secondSession)], nextCursor: null }
        : { commands: [command("first")], nextCursor: "next" };
    },
    cancelSessionBackgroundCommand: async (...args) => {
      stops.push(args);
      return { accepted: true, command: command(args[2], args[1]) };
    },
  });
  const hook = await renderHook(
    () => useWorkspaceBackgroundCommands({ client, workspaceId: WORKSPACE_ID }),
    undefined,
  );
  await flush();
  expect(hook.result.current.commands).toHaveLength(1);
  expect(hook.result.current.hasMore).toBe(true);
  await act(async () => hook.result.current.loadMore());
  await flush();
  expect(hook.result.current.commands).toHaveLength(2);
  expect(hook.result.current.hasMore).toBe(false);
  await act(async () => hook.result.current.cancel("second"));
  expect(stops).toEqual([[WORKSPACE_ID, secondSession, "second"]]);
  expect(cursors).toContain("next");
  await hook.unmount();
});

test("disabled list makes no request and aborts on unmount", async () => {
  let signal: AbortSignal | undefined;
  let calls = 0;
  const client = fakeClient({
    listWorkspaceBackgroundCommands: async (_workspace, options) => {
      calls += 1;
      signal = options?.signal;
      return await new Promise((resolve) =>
        signal?.addEventListener("abort", () => resolve({ commands: [], nextCursor: null }), {
          once: true,
        }),
      );
    },
  });
  const hook = await renderHook(
    (enabled: boolean) =>
      useWorkspaceBackgroundCommands({ client, workspaceId: WORKSPACE_ID, enabled }),
    false as boolean,
  );
  expect(calls).toBe(0);
  await hook.rerender(true);
  await flush();
  expect(calls).toBe(1);
  await hook.unmount();
  expect(signal?.aborted).toBe(true);
});

test("a failed refresh does not keep showing cached commands as authorized live work", async () => {
  let denied = false;
  const client = fakeClient({
    listWorkspaceBackgroundCommands: async () => {
      if (denied) throw new Error("Access revoked");
      return { commands: [command("first")], nextCursor: null };
    },
  });
  const hook = await renderHook(
    () => useWorkspaceBackgroundCommands({ client, workspaceId: WORKSPACE_ID }),
    undefined,
  );
  await flush();
  expect(hook.result.current.commands).toHaveLength(1);
  denied = true;
  await act(async () => hook.result.current.refresh());
  expect(hook.result.current.error?.message).toBe("Access revoked");
  expect(hook.result.current.commands).toEqual([]);
  await hook.unmount();
});
