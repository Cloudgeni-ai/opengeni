import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { ApiError } = await import("@/api");
const { lastSessionMemoryId, readLastSessionId, useForgetLastSession, useSessionRouteMemory } =
  await import("./last-session-memory");

const memoryId = lastSessionMemoryId("user:maja", "workspace-a");

afterAll(() => {
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  window.sessionStorage.clear();
  document.body.replaceChildren();
});

type RouteInput = Parameters<typeof useSessionRouteMemory>[0];

function SessionRouteProbe(props: RouteInput & { onLeaving: (leaving: boolean) => void }) {
  const { onLeaving, ...input } = props;
  onLeaving(useSessionRouteMemory(input));
  return null;
}

function NewSessionProbe() {
  useForgetLastSession("user:maja", "workspace-a");
  return null;
}

async function renderRoute(overrides: Partial<RouteInput>) {
  const leave = mock(() => undefined);
  const leaving: boolean[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props: RouteInput = {
    subjectId: "user:maja",
    workspaceId: "workspace-a",
    sessionId: "session-1",
    openedSessionId: null,
    loadError: null,
    restoredSessionId: undefined,
    leave,
    ...overrides,
  };
  const render = async (next: Partial<RouteInput> = {}) => {
    Object.assign(props, next);
    await act(async () => {
      root.render(<SessionRouteProbe {...props} onLeaving={(value) => leaving.push(value)} />);
    });
  };
  await render();
  return {
    leave,
    leaving,
    render,
    unmount: async () => act(async () => root.unmount()),
  };
}

function notFound(status = 404) {
  return new ApiError(status, "missing");
}

describe("session route memory", () => {
  test("remembers a session once it opens, not while it loads", async () => {
    const view = await renderRoute({});
    expect(readLastSessionId(memoryId)).toBeNull();
    await view.render({ openedSessionId: "session-1" });
    expect(readLastSessionId(memoryId)).toBe("session-1");
    // A stale detail read for the previous session never records the new id.
    await view.render({ sessionId: "session-2" });
    expect(readLastSessionId(memoryId)).toBe("session-1");
    await view.unmount();
  });

  test("the new-session page forgets it, so Back opens a new session", async () => {
    window.sessionStorage.setItem(memoryId, "session-1");
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(<NewSessionProbe />));
    expect(readLastSessionId(memoryId)).toBeNull();
    await act(async () => root.unmount());
  });

  test("an explicit link to a gone session forgets it and stays on the not-found page", async () => {
    window.sessionStorage.setItem(memoryId, "session-1");
    const view = await renderRoute({ loadError: notFound() });
    expect(readLastSessionId(memoryId)).toBeNull();
    expect(view.leave).not.toHaveBeenCalled();
    expect(view.leaving.at(-1)).toBe(false);
    await view.unmount();
  });

  test("Back to a gone or inaccessible session opens a new session instead, once", async () => {
    for (const status of [404, 403]) {
      window.sessionStorage.setItem(memoryId, "session-1");
      const view = await renderRoute({
        loadError: notFound(status),
        restoredSessionId: "session-1",
      });
      expect(readLastSessionId(memoryId)).toBeNull();
      expect(view.leaving.at(-1)).toBe(true);
      await view.render();
      expect(view.leave).toHaveBeenCalledTimes(1);
      await view.unmount();
    }
  });

  test("a transient failure keeps the remembered session", async () => {
    window.sessionStorage.setItem(memoryId, "session-1");
    const view = await renderRoute({
      loadError: new ApiError(503, "unavailable"),
      restoredSessionId: "session-1",
    });
    expect(readLastSessionId(memoryId)).toBe("session-1");
    expect(view.leave).not.toHaveBeenCalled();
    await view.unmount();
  });

  test("a gone session never forgets a different remembered one", async () => {
    window.sessionStorage.setItem(memoryId, "session-2");
    const view = await renderRoute({ loadError: notFound() });
    expect(readLastSessionId(memoryId)).toBe("session-2");
    await view.unmount();
  });
});
