import { Link, type ErrorComponentProps } from "@tanstack/react-router";

import { ProblemPanel } from "@/components/common";
import { Button } from "@/components/ui/button";
import { isChunkLoadError, reportClientError } from "@/lib/client-error-reporting";

type RouteErrorPanelProps = Pick<ErrorComponentProps, "error"> & {
  reload?: () => void;
};

/**
 * Styled replacement for TanStack Router's bare "Something went wrong!" page.
 * The raw error text never reaches the page in production: it can contain ids
 * or server detail and is not actionable for the person reading it. A stale
 * lazy chunk after a deploy is presented as an update, with Reload first.
 * Both actions are full document loads so a failed router state cannot trap
 * the tab.
 */
export function RouteErrorPanel({ error, reload = reloadDocument }: RouteErrorPanelProps) {
  const updated = isChunkLoadError(error);
  return (
    <ProblemPanel
      title={updated ? "OpenGeni has been updated" : "Something went wrong"}
      description={
        <>
          {updated
            ? "This tab is running an older version of OpenGeni. Reload to continue with the latest version."
            : "This page hit an unexpected error. Reloading usually fixes it. If it keeps happening, go back to your workspace and try again."}
          {import.meta.env.DEV && error instanceof Error ? (
            <span className="mt-3 block rounded-md bg-muted p-2 text-left font-mono text-xs break-words text-fg-muted">
              {error.message}
            </span>
          ) : null}
        </>
      }
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" onClick={reload}>
            {updated ? "Reload to update" : "Reload page"}
          </Button>
          <Button asChild variant="secondary">
            <a href="/">Go home</a>
          </Button>
        </div>
      }
    />
  );
}

/**
 * Root-level fallback. It replaces the root route component, so it supplies
 * the app canvas that component would otherwise have rendered.
 */
export function RootRouteErrorPanel(props: ErrorComponentProps) {
  return (
    <main className="flex h-dvh max-h-dvh flex-col overflow-hidden bg-bg text-fg">
      <RouteErrorPanel error={props.error} />
    </main>
  );
}

/** Unknown URL. The router is healthy here, so "Go home" is a client navigation. */
export function NotFoundPanel() {
  return (
    <ProblemPanel
      title="Page not found"
      description="This page doesn't exist or has moved. Go back to your workspace to continue."
      action={
        <Button asChild variant="secondary">
          <Link to="/">Go home</Link>
        </Button>
      }
    />
  );
}

/**
 * Router options that give every match a styled error boundary and report
 * each caught failure. A failing page therefore keeps the workspace rail
 * instead of replacing the whole app. Not-found signals are routed to the
 * not-found component by TanStack before `onCatch` runs.
 */
export function routerErrorOptions(
  routePattern: () => string,
  report: typeof reportClientError = reportClientError,
) {
  return {
    defaultErrorComponent: RouteErrorPanel,
    defaultOnCatch: (error: Error) =>
      report(isChunkLoadError(error) ? "chunk_load" : "route_error", routePattern()),
  } as const;
}

function reloadDocument() {
  window.location.reload();
}
