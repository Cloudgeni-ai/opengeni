/**
 * Dedicated browser module-Worker entry for editable artifacts.
 *
 * Bundle this subpath as a Worker URL; importing it in the Worker installs the
 * bounded RPC runtime. The ordinary SDK and editable-artifacts client entries
 * do not load this code on the main thread.
 */
export { installBrowserArtifactWorkerEntry } from "./editable-artifacts/worker/browser-entry";
