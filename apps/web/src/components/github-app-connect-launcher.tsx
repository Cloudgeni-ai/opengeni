import { lazy, Suspense, useCallback, useState, type ReactNode } from "react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

const GitHubAppConnectDialog = lazy(() =>
  import("@/components/github-app-connect-dialog").then((module) => ({
    default: module.GitHubAppConnectDialog,
  })),
);

/**
 * Opens workspace GitHub App setup from a click. The authorization link is
 * minted when setup starts, not when the page loaded: a page-load link expires
 * after ten minutes and then shows a raw error. Setup runs in the shared Connect
 * dialog, which reports Cancel, owner approval, and failures in the UI.
 *
 * The dialog must live outside the repository menu: the menu closes when the
 * authorization popup takes focus, and that would unmount the dialog with it.
 */
export function useGitHubAppConnectLauncher(workspaceId: string): {
  open: () => void;
  element: ReactNode;
} {
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = useCallback(() => setOpenFor(workspaceId), [workspaceId]);
  const close = useCallback(() => setOpenFor(null), []);
  return {
    open,
    element:
      openFor === workspaceId ? (
        <Suspense fallback={null}>
          <GitHubAppConnectDialog workspaceId={workspaceId} onClose={close} />
        </Suspense>
      ) : null,
  };
}

/**
 * Opens GitHub's repository settings for one installation through a link
 * minted now. Installation settings links carry the same ten-minute state as
 * the connect link, so a copy captured at page load cannot be used.
 */
export async function openGitHubInstallationSettings(
  client: Pick<OpenGeniBrowserClient, "getGitHubApp">,
  workspaceId: string,
  installationId: number,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): Promise<void> {
  const status = await client.getGitHubApp(workspaceId);
  const url = status.installations.find(
    (installation) => installation.installationId === installationId,
  )?.configureUrl;
  if (!url) {
    throw new Error(
      "You can't change this installation's repositories. Ask a workspace admin to update it on GitHub.",
    );
  }
  navigate(url);
}
