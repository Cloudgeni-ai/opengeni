/**
 * A GitHub source needs this workspace's GitHub connection (the GitHub App
 * installed on an account or organization): it receives the App's events.
 * Without one, adding the source points at the existing Connect flow instead
 * of failing with "Connect GitHub to this workspace first".
 */
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useAppContext } from "@opengeni/react/app/app-context";
import { Button } from "@opengeni/react/ui/button";
import { Notice } from "@opengeni/react/ui/notice";
import type { GitHubAppInfo } from "@opengeni/sdk";

/** Where Connected tools opens the GitHub connection. */
export function connectGitHubHref(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/plugins?open=integration:github`;
}

/**
 * Whether the workspace's GitHub status lets a GitHub source be added: null
 * when this server has no GitHub App ("disabled"), which the server explains.
 */
export function githubConnectedFromStatus(status: GitHubAppInfo["status"]): boolean | null {
  return status === "disabled" ? null : status === "bound";
}

/** True when GitHub is connected here, false when it isn't, null while unknown or unreadable. */
export function useGitHubConnected(workspaceId: string, enabled: boolean): boolean | null {
  const { client } = useAppContext();
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    client.getGitHubApp(workspaceId).then(
      (app) => live && setConnected(githubConnectedFromStatus(app.status)),
      // Unknown: let the server decide when the source is added.
      () => live && setConnected(null),
    );
    return () => {
      live = false;
    };
  }, [client, enabled, workspaceId]);
  return enabled ? connected : null;
}

export function ConnectGitHubFirst({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  return (
    <Notice
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void navigate({ href: connectGitHubHref(workspaceId) })}
        >
          Connect GitHub
        </Button>
      }
    >
      GitHub isn't connected to this workspace yet.
    </Notice>
  );
}
