import { registerPierreDiffs } from "./lib/pierre-diffs-loader";

export { registerPierreDiffs, type PierreDiffsLoader } from "./lib/pierre-diffs-loader";

/**
 * Enable Shiki-highlighted diffs and file views from the optional
 * `@pierre/diffs` peer. Call once at startup, only when the host installs it.
 * This is the only module in the package that names the peer, so hosts that
 * skip it build without `@pierre/diffs` and render plain-text diffs.
 */
export function enablePierreDiffs(): void {
  registerPierreDiffs(loadPierreDiffsModule);
}

// One stable loader identity, so repeated enable calls are no-ops.
const loadPierreDiffsModule = () => import("@pierre/diffs/react");
