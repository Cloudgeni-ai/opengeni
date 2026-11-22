import type { AppServerStatus } from "@opengeni/contracts";
import { useEffect, useState } from "react";
import { useAppContext } from "../../app-context";

/**
 * The line's text: only when there is something to act on, else null. Errors
 * show while the newest run failed, so the line goes away once a fix works.
 */
export function appServerStatusLabel(status: AppServerStatus | null): string | null {
  if (!status?.hasCode) return null;
  if (!status.available) return "Server code: not available here";
  if (status.paused) return "Server code: paused";
  if (status.lastRunFailed && status.errorsToday > 0)
    return `Server code: ${status.errorsToday} ${status.errorsToday === 1 ? "error" : "errors"} today`;
  return null;
}

export function AppServerStatusLineView({
  status,
  onOpenChat,
}: {
  status: AppServerStatus | null;
  /** Fixing happens in the app's chat; the line opens it. */
  onOpenChat?: (() => void) | undefined;
}) {
  const label = appServerStatusLabel(status);
  if (!label) return null;
  const detail = status?.paused ?? status?.lastError?.message ?? undefined;
  return (
    <button
      type="button"
      data-app-server-status=""
      className="mr-1 min-w-0 truncate rounded-sm text-2xs font-medium text-danger hover:underline focus-visible:outline-2"
      title={
        detail ? `${detail} Ask in the app's chat to fix it.` : "Ask in the app's chat to fix it."
      }
      onClick={onOpenChat}
    >
      {label}
    </button>
  );
}

/**
 * The app's one server code line (docs/app-server-code.md) in its header,
 * for managers: errors while the newest run fails, paused code, or code this
 * deployment can't run. It opens the app's chat, where fixing happens.
 */
export function AppServerStatusLine({
  workspaceId,
  siteId,
  versionId,
  onOpenChat,
}: {
  workspaceId: string;
  siteId: string;
  versionId: string | null;
  onOpenChat?: (() => void) | undefined;
}) {
  const { client } = useAppContext();
  const [status, setStatus] = useState<AppServerStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!versionId) return;
    const abort = new AbortController();
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const load = () =>
      client.getAppServerStatus(workspaceId, siteId, { signal: abort.signal }).then(
        (next) => {
          if (abort.signal.aborted) return;
          setStatus(next);
          // Only apps with server code are watched; a new version starts over.
          if (!next.hasCode) stop();
          else if (timer === undefined) timer = window.setInterval(() => void load(), 60_000);
        },
        // Not a manager of this app (or it's gone): nothing to show or watch.
        () => stop(),
      );
    void load();
    return () => {
      abort.abort();
      stop();
    };
  }, [client, siteId, versionId, workspaceId]);
  return <AppServerStatusLineView status={status} onOpenChat={onOpenChat} />;
}
