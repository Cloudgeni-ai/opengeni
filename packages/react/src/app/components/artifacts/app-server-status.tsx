import type { AppServerStatus } from "@opengeni/contracts";
import { useEffect, useState } from "react";
import { useAppContext } from "../../app-context";

/** The line's text: only when there is something to act on, else null. */
export function appServerStatusLabel(status: AppServerStatus | null): string | null {
  if (!status?.hasCode) return null;
  if (!status.available) return "Server code: not available here";
  if (status.errorsToday > 0)
    return `Server code: ${status.errorsToday} ${status.errorsToday === 1 ? "error" : "errors"} today`;
  return null;
}

export function AppServerStatusLineView({ status }: { status: AppServerStatus | null }) {
  const label = appServerStatusLabel(status);
  if (!label) return null;
  return (
    <span
      data-app-server-status=""
      className="mr-1 truncate text-2xs font-medium text-danger max-sm:sr-only"
      title={status?.lastError?.message ?? undefined}
    >
      {label}
    </span>
  );
}

/**
 * The app's one server code line (docs/app-server-code.md) in its header,
 * for managers: today's errors, or code this deployment can't run. Fixing
 * it happens in the app's chat.
 */
export function AppServerStatusLine({
  workspaceId,
  siteId,
  versionId,
}: {
  workspaceId: string;
  siteId: string;
  versionId: string | null;
}) {
  const { client } = useAppContext();
  const [status, setStatus] = useState<AppServerStatus | null>(null);
  useEffect(() => {
    if (!versionId) return;
    const abort = new AbortController();
    const load = () =>
      client.getAppServerStatus(workspaceId, siteId, { signal: abort.signal }).then(
        (next) => {
          if (!abort.signal.aborted) setStatus(next);
        },
        () => undefined,
      );
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, [client, siteId, versionId, workspaceId]);
  return <AppServerStatusLineView status={status} />;
}
