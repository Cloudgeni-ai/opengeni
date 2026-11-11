import { expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk/browser";

import { registerDom, renderHook } from "../../../test/render-hook";
import {
  lastSessionMemoryId,
  readLastSessionId,
  rememberLastSessionId,
  useSessionRouteMemory,
} from "./last-session-memory";

registerDom();

const workspaceId = "workspace-a";
const memoryId = lastSessionMemoryId("user:maja", workspaceId);
const sessionId = "00000000-0000-4000-9000-000000000001";
const earlier = "00000000-0000-4000-9000-000000000002";

type Props = { opened: boolean; loadError: unknown; enabled: boolean };

async function route(initial: Props) {
  const left: string[] = [];
  const hook = await renderHook(
    ({ opened, loadError, enabled }: Props) =>
      useSessionRouteMemory({
        subjectId: "user:maja",
        workspaceId,
        sessionId,
        openedSessionId: opened ? sessionId : null,
        loadError,
        restoredSessionId: sessionId,
        leave: () => void left.push(sessionId),
        enabled,
      }),
    initial,
  );
  return { hook, left };
}

test("the page's chat is remembered as the last one opened", async () => {
  rememberLastSessionId(memoryId, earlier);
  const { hook } = await route({ opened: true, loadError: null, enabled: true });
  try {
    expect(readLastSessionId(memoryId)).toBe(sessionId);
  } finally {
    await hook.unmount();
  }
});

test("a chat in a panel neither replaces nor forgets the page's last chat", async () => {
  rememberLastSessionId(memoryId, earlier);
  const { hook, left } = await route({ opened: true, loadError: null, enabled: false });
  try {
    expect(readLastSessionId(memoryId)).toBe(earlier);
    rememberLastSessionId(memoryId, sessionId);
    // Gone or forbidden: the panel doesn't forget it or leave the page.
    await hook.rerender({
      opened: false,
      loadError: new OpenGeniApiError(404, "{}"),
      enabled: false,
    });
    expect(hook.result.current).toBe(false);
    expect(readLastSessionId(memoryId)).toBe(sessionId);
    expect(left).toEqual([]);
  } finally {
    await hook.unmount();
  }
});
