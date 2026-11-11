import { type ReactNode } from "react";
declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
/** Register DOM globals for this test file; unregisters after the file. */
export declare function registerDom(options?: { clock?: "real" | "virtual" }): void;
export type RenderedHook<T, P> = {
    /** Latest hook return value. */
    result: {
        current: T;
    };
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
export declare function renderHook<T, P = void>(useHook: (props: P) => T, initialProps: P): Promise<RenderedHook<T, P>>;
/** Run queued microtasks (and `act` flushes) so async hook effects settle. */
export declare function flush(ms?: number): Promise<void>;
/** Run a user interaction or hook mutation and all of its state updates in `act`. */
export declare function actRun<T>(run: () => T | Promise<T>): Promise<T>;
/**
 * Mount `node` with real browser scheduling instead of `act`, which holds every
 * update until its scope ends. Use it to measure when a render actually commits;
 * `unmount` returns to `act` for cleanup.
 */
export declare function mountWithRealScheduling(node: ReactNode): {
    unmount: () => Promise<void>;
};
export type RenderedComponent = {
    /** The mount container — query it with `.querySelector` etc. */
    container: HTMLElement;
    rerender: (node: ReactNode) => Promise<void>;
    unmount: () => Promise<void>;
};
/** Render an arbitrary React element into a throwaway tree (for component tests). */
export declare function renderComponent(node: ReactNode): Promise<RenderedComponent>;
