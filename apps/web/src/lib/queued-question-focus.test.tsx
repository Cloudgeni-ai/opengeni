import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useCallback, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionTurn } from "@opengeni/sdk";
import { useQueuedQuestionFocus } from "./queued-question-focus";

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

const turn = { id: "queued-question" } as SessionTurn;
const actor = {};
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function scenario(initialRows: SessionTurn[] = []) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const read = deferred();
  let rows = [turn];
  let error: Error | null = null;
  let api!: ReturnType<typeof useQueuedQuestionFocus>;
  function Harness({ sessionId, client }: { sessionId: string; client: object }) {
    const [queue, setQueue] = useState(initialRows);
    const [readError, setReadError] = useState<Error | null>(null);
    const refresh = useCallback(async () => {
      await read.promise;
      // Same contract as useTurnQueue: render error but fulfill the read.
      setQueue(rows);
      setReadError(error);
    }, []);
    const value = useQueuedQuestionFocus({
      client,
      subjectId: "reader",
      workspaceId: "workspace",
      sessionId,
      queue: { queue, error: readError, refresh },
    });
    useLayoutEffect(() => {
      api = value;
    });
    return <span>{value.queueFocusTarget?.turnId ?? "none"}</span>;
  }
  const render = async (sessionId = "A", client = actor) => {
    await act(async () => root.render(<Harness sessionId={sessionId} client={client} />));
  };
  await render();
  return {
    container,
    render,
    start: (navigation = { isCurrent: () => true }) => api.onQueuedQuestion(turn, navigation),
    callback: () => api.onQueuedQuestion,
    settle: async (nextRows: SessionTurn[], nextError: Error | null = null) => {
      rows = nextRows;
      error = nextError;
      await act(async () => {
        read.release();
        await Promise.resolve();
      });
    },
    close: async () => {
      await act(async () => root.unmount());
    },
  };
}

test("focus requires the refreshed committed queue, not the stale callback closure", async () => {
  const view = await scenario();
  try {
    let request!: Promise<void>;
    await act(async () => {
      request = view.start();
    });
    expect(view.container.textContent).toBe("none");
    await view.settle([turn]);
    await request;
    expect(view.container.textContent).toBe(turn.id);
  } finally {
    await view.close();
  }
});

test("a retained callback cannot start work after its session is replaced", async () => {
  const view = await scenario([turn]);
  try {
    const stale = view.callback();
    await view.render("B");
    await stale(turn, { isCurrent: () => true }); // Must settle without waiting for the old queue read.
    expect(view.container.textContent).toBe("none");
  } finally {
    await view.close();
  }
});

test("explicit same-session history navigation cancels focus while its queue read is pending", async () => {
  const view = await scenario([turn]);
  let navigationCurrent = true;
  try {
    let request!: Promise<void>;
    await act(async () => {
      request = view.start({ isCurrent: () => navigationCurrent });
    });
    navigationCurrent = false;
    await view.settle([turn]);
    await request;
    expect(view.container.textContent).toBe("none");
  } finally {
    await view.close();
  }
});

test.each(["failure", "withdrawn"])(
  "a %s after lookup cannot focus the old queued row",
  async (kind) => {
    const view = await scenario([turn]);
    try {
      let result!: Promise<string>;
      await act(async () => {
        result = view.start().then(
          () => "settled",
          (error: Error) => error.message,
        );
      });
      await view.settle(
        kind === "withdrawn" ? [] : [turn],
        kind === "failure" ? new Error("Queue unavailable") : null,
      );
      expect(await result).toBe(kind === "failure" ? "Queue unavailable" : "settled");
      expect(view.container.textContent).toBe("none");
    } finally {
      await view.close();
    }
  },
);

test.each(["session", "actor", "unmount"])(
  "a pending focus is fenced on %s replacement",
  async (kind) => {
    const view = await scenario([turn]);
    let closed = false;
    try {
      let request!: Promise<void>;
      await act(async () => {
        request = view.start();
      });
      if (kind === "unmount") {
        await view.close();
        closed = true;
      } else await view.render(kind === "session" ? "B" : "A", kind === "actor" ? {} : actor);
      await view.settle([turn]);
      await request;
      expect(view.container.textContent).toBe(closed ? "" : "none");
    } finally {
      if (!closed) await view.close();
    }
  },
);
