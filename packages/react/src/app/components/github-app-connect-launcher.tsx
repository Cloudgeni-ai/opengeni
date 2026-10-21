import { lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from "react";
import { toast } from "../lib/toast";

import type { NativeConnectRequest } from "./capabilities/native-connect-setup";
import { useAppContext } from "../app-context";
import { githubAppConnectRequest } from "../lib/github-app-connect";
import { usePage } from "../lib/navigation";

const NativeConnectSetup = lazy(() =>
  import("./capabilities/native-connect-setup").then((module) => ({
    default: module.NativeConnectSetup,
  })),
);

/**
 * Opens workspace GitHub App setup from a click in the new-session repository
 * picker (the session route hosts the same request in its own Connect dialog).
 *
 * The dialog must live outside the repository menu: the menu closes when the
 * authorization popup takes focus, and that would unmount the dialog with it.
 */
export function useGitHubAppConnectLauncher(workspaceId: string): {
  open: () => void;
  element: ReactNode;
} {
  const { client, refreshGitHub } = useAppContext();
  const page = usePage();
  const transport = useMemo(() => client.connectTransport(), [client]);
  const [request, setRequest] = useState<NativeConnectRequest | null>(null);
  const open = useCallback(
    () => setRequest(githubAppConnectRequest(workspaceId, transport, page.href())),
    [page, transport, workspaceId],
  );
  const close = useCallback(() => setRequest(null), []);
  const complete = useCallback(() => {
    setRequest(null);
    toast.success("GitHub connected");
    void refreshGitHub(workspaceId, undefined, { sync: true });
  }, [refreshGitHub, workspaceId]);
  return {
    open,
    element:
      request?.scope.workspaceId === workspaceId ? (
        <Suspense fallback={null}>
          <NativeConnectSetup
            transport={transport}
            workspaceId={workspaceId}
            request={request}
            onClose={close}
            onComplete={complete}
          />
        </Suspense>
      ) : null,
  };
}
