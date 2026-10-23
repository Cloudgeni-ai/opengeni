/* ----------------------------------------------------------------------------
   Minimal hook-render harness for bun:test.

   Registers happy-dom globals for the lifetime of the importing test file and
   restores the previous globals afterwards (so the rest of the monorepo's bun
   test run keeps Bun's native fetch/Response). Call `registerDom()` once at
   the top of a hook test file, then use `renderHook` + `act`.
   -------------------------------------------------------------------------- */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, jest } from "bun:test";
import { act, type ReactElement, type ReactNode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MessageChannel } from "node:worker_threads";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let registered = false;

/** Register DOM globals for this test file; unregisters after the file. */
export function registerDom(options: { clock?: "real" | "virtual" } = {}): void {
  if (registered) {
    return;
  }
  registered = true;
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  if (options.clock === "virtual") {
    beforeEach(() => jest.useFakeTimers());
    afterEach(async () => {
      try {
        // Happy DOM coalesces zero-delay callbacks. Finish that batch before
        // replacing the clock, or the next test inherits an orphaned batch.
        if (jest.isFakeTimers()) await act(async () => jest.runOnlyPendingTimers());
      } finally {
        jest.useRealTimers();
      }
    });
  }
  afterAll(async () => {
    registered = false;
    await GlobalRegistrator.unregister();
  });
}

/**
 * Run one test body on the virtual clock in a file that otherwise uses real
 * time, for example to let a failure outlast a two-minute window. Pending
 * timers are settled before the real clock comes back.
 */
export async function withVirtualClock<T>(run: () => Promise<T>): Promise<T> {
  jest.useFakeTimers();
  try {
    return await run();
  } finally {
    try {
      if (jest.isFakeTimers()) await act(async () => jest.runOnlyPendingTimers());
    } finally {
      jest.useRealTimers();
    }
  }
}

export type RenderedHook<T, P> = {
  /** Latest hook return value. */
  result: { current: T };
  /** Re-render with new props (or the previous props). */
  rerender: (props?: P) => Promise<void>;
  /**
   * Commit a render through layout effects and resolve before its passive
   * effects. This intentionally does not use `act`, whose contract closes that
   * browser-observable scheduling window before returning.
   */
  rerenderThroughLayout: (props?: P) => Promise<void>;
  unmount: () => Promise<void>;
};

/**
 * Render `useHook(props)` inside a throwaway component tree and capture its
 * latest return value. All updates run inside `act`, so effects (including
 * async state settled via `flush`) are reflected in `result.current`.
 */
export async function renderHook<T, P = void>(
  useHook: (props: P) => T,
  initialProps: P,
): Promise<RenderedHook<T, P>> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const result = { current: undefined as T };
  let lastProps = initialProps;
  let resolveLayoutCommit: (() => void) | null = null;

  function Harness({ props }: { props: P }) {
    result.current = useHook(props);
    useLayoutEffect(() => {
      resolveLayoutCommit?.();
      resolveLayoutCommit = null;
    });
    return null;
  }

  let root: Root | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness props={initialProps} />);
  });

  return {
    result,
    rerender: async (props?: P) => {
      lastProps = props === undefined ? lastProps : props;
      await act(async () => {
        root?.render(<Harness props={lastProps} />);
      });
    },
    rerenderThroughLayout: async (props?: P) => {
      lastProps = props === undefined ? lastProps : props;
      if (!root) throw new Error("hook root is unavailable");
      const committed = new Promise<void>((resolve) => {
        resolveLayoutCommit = resolve;
      });
      // The point of this helper is to expose the layout-to-passive interval
      // that `act` deliberately hides. Disable only the warning classifier for
      // this one scheduled render, until it commits (the render itself runs
      // after scheduling); callers must return to `act` for settlement.
      const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
      try {
        root.render(<Harness props={lastProps} />);
        await committed;
      } finally {
        globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
    },
    unmount: async () => {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

/** Run queued microtasks (and `act` flushes) so async hook effects settle. */
export async function flush(ms = 0): Promise<void> {
  if (jest.isFakeTimers()) {
    // Settle reads after each deadline. A fixed-size jump can start a request
    // and fire its timeout before the request's resolved promise gets a turn.
    const progress = { reachedDeadline: false };
    const deadline = setTimeout(
      () => {
        progress.reachedDeadline = true;
      },
      Math.max(ms, 1),
    );
    try {
      do {
        await act(async () => {
          jest.advanceTimersToNextTimer();
          // Native asynchronous work (for example WebCrypto frame digests) is
          // not a timer or a microtask. Give it an event-loop turn as well.
          await new Promise<void>((resolve) => {
            const { port1, port2 } = new MessageChannel();
            port1.once("message", () => {
              port1.close();
              port2.close();
              resolve();
            });
            port2.postMessage(null);
          });
        });
      } while (!progress.reachedDeadline);
    } finally {
      clearTimeout(deadline);
    }
    return;
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Run a user interaction or hook mutation and all of its state updates in `act`. */
export async function actRun<T>(run: () => T | Promise<T>): Promise<T> {
  let result!: T;
  await act(async () => {
    result = await run();
  });
  return result;
}

/**
 * Mount `node` with real browser scheduling instead of `act`, which holds every
 * update until its scope ends. Use it to measure when a render actually commits;
 * `unmount` returns to `act` for cleanup.
 */
export function mountWithRealScheduling(node: ReactNode): { unmount: () => Promise<void> } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  const root = createRoot(container);
  root.render(node);
  return {
    unmount: async () => {
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

export type RenderedComponent = {
  /** The mount container — query it with `.querySelector` etc. */
  container: HTMLElement;
  rerender: (node: ReactNode) => Promise<void>;
  unmount: () => Promise<void>;
};

/** Render an arbitrary React element into a throwaway tree (for component tests). */
export async function renderComponent(node: ReactNode): Promise<RenderedComponent> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(node as ReactElement);
  });
  return {
    container,
    rerender: async (next: ReactNode) => {
      await act(async () => {
        root?.render(next as ReactElement);
      });
    },
    unmount: async () => {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
    },
  };
}
