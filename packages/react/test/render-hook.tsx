/* ----------------------------------------------------------------------------
   Minimal hook-render harness for bun:test.

   Registers happy-dom globals for the lifetime of the importing test file and
   restores the previous globals afterwards (so the rest of the monorepo's bun
   test run keeps Bun's native fetch/Response). Call `registerDom()` once at
   the top of a hook test file, then use `renderHook` + `act`.
   -------------------------------------------------------------------------- */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll } from "bun:test";
import { act, type ReactElement, type ReactNode } from "react";
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

  function Harness({ props }: { props: P }) {
    result.current = useHook(props);
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
