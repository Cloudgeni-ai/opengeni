import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionBackgroundCommand } from "@opengeni/sdk";
import { SessionCommandsPanel } from "../src/components/session-commands-panel";
import { useSessionBackgroundCommands } from "../src/hooks/use-session-background-commands";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { flush, registerDom, renderHook } from "./render-hook";

registerDom();

test("command panel distinguishes tracking loss from running and stop requests", () => {
  for (const state of ["running", "stopping"] as const) {
    const command: SessionBackgroundCommand = {
      id: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      provider: "managed",
      state,
      observationStatus: "unavailable",
      commandPreview: "build",
      cancelRequestedAt: null,
      exitCode: null,
      settlementReason: null,
      startedAt: "2026-09-09T00:00:00Z",
      settledAt: null,
      updatedAt: "2026-09-09T00:00:00Z",
    };
    const html = renderToStaticMarkup(
      <SessionCommandsPanel
        commands={{
          commands: [command],
          loading: false,
          error: null,
          refresh: async () => {},
          cancel: async () => {},
        }}
      />,
    );
    expect(html).toContain(
      state === "stopping" ? "Stop requested · status unavailable" : "Command status unavailable",
    );
    expect(html).not.toContain(">Running<");
  }
});

describe("active command list loading", () => {
  test("does not load while disabled and aborts its request on close", async () => {
    let calls = 0;
    let signal: AbortSignal | undefined;
    const client = fakeClient({
      listSessionBackgroundCommands: async (_workspaceId, _sessionId, options) => {
        calls += 1;
        signal = options?.signal;
        return await new Promise((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve({ commands: [] }), {
            once: true,
          }),
        );
      },
    });
    const hook = await renderHook(
      (enabled: boolean) =>
        useSessionBackgroundCommands(SESSION_ID, { client, workspaceId: WORKSPACE_ID, enabled }),
      false as boolean,
    );
    expect(calls).toBe(0);
    await hook.rerender(true);
    expect(calls).toBe(1);
    await hook.unmount();
    expect(signal?.aborted).toBe(true);
    await flush();
    expect(calls).toBe(1);
  });

  test("a stop result arriving after close does not fetch commands again", async () => {
    let calls = 0;
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const client = fakeClient({
      listSessionBackgroundCommands: async () => {
        calls += 1;
        return { commands: [] };
      },
      cancelSessionBackgroundCommand: async () => {
        await waiting;
        return { accepted: true, command: {} } as never;
      },
    });
    const hook = await renderHook(
      () => useSessionBackgroundCommands(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    expect(calls).toBe(1);
    const stop = hook.result.current.cancel("00000000-0000-4000-8000-000000000001");
    await hook.unmount();
    finish();
    await stop;
    expect(calls).toBe(1);
  });
});
