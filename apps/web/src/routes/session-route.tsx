// The web app's session route: turns on the optional workbench peers, then
// serves the shared session page. Highlighted diffs, the terminal, desktop
// viewer and code editor load their peers only here, in the lazy session
// route, so they stay out of the initial graph.
import { enableWorkbench } from "@opengeni/react/workbench";
// Vite's `?worker` transform synthesizes this default export.
// oxlint-disable-next-line import/default
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";

// Diffs highlight in a worker so switching files never blocks the page.
enableWorkbench({ diffsWorker: () => new DiffsWorker() });

export { SessionRoute } from "@opengeni/react/app/routes/session";
