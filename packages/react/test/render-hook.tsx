/* ----------------------------------------------------------------------------
   Minimal hook-render harness for bun:test.

   Registers happy-dom globals for the lifetime of the importing test file and
   restores the previous globals afterwards (so the rest of the monorepo's bun
   test run keeps Bun's native fetch/Response). Call `registerDom()` once at
   the top of a hook test file, then use `renderHook` + `act`.
   -------------------------------------------------------------------------- */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll } from "bun:test";
import { act, type ReactElement, type ReactNode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let registered = false;

/** Register DOM globals for this test file; unregisters after the file. */
export function registerDom(): void {
  if (registered) {
    return;
  }
  registered = true;
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  afterAll(async () => {
    registered = false;
    await GlobalRegistrator.unregister();
  });
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
      // this one scheduled render; callers must return to `act` for settlement.
      const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
      try {
        root.render(<Harness props={lastProps} />);
      } finally {
        globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
      await committed;
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
