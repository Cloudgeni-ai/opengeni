import { type PierreDiffsWorkerFactory, registerPierreDiffs } from "./lib/pierre-diffs-loader";

export {
  registerPierreDiffs,
  type PierreDiffsLoader,
  type PierreDiffsWorkerFactory,
} from "./lib/pierre-diffs-loader";

export type EnablePierreDiffsOptions = {
  /**
   * Highlight in a Web Worker instead of on the main thread. Return a worker
   * for `@pierre/diffs/worker/worker.js` built by your bundler, for example
   * with Vite: `import DiffsWorker from "@pierre/diffs/worker/worker.js?worker"`
   * and `worker: () => new DiffsWorker()`. Large diffs then stay responsive.
   */
  worker?: PierreDiffsWorkerFactory | undefined;
};

/**
 * Enable Shiki-highlighted diffs and file views from the optional
 * `@pierre/diffs` peer. Call once at startup, only when the host installs it.
 * This is the only module in the package that names the peer, so hosts that
 * skip it build without `@pierre/diffs` and render plain-text diffs.
 */
export function enablePierreDiffs(options?: EnablePierreDiffsOptions): void {
  registerPierreDiffs(loadPierreDiffsModule, options?.worker ? { worker: options.worker } : undefined);
}

// One stable loader identity, so repeated enable calls are no-ops.
const loadPierreDiffsModule = () => import("@pierre/diffs/react");
