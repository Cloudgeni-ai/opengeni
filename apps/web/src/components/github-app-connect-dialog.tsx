import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  NativeConnectSetup,
  type NativeConnectRequest,
} from "@/components/capabilities/native-connect-setup";
import { useAppContext } from "@/context";

/**
 * Workspace GitHub App setup from the repository picker: the same durable
 * Connect flow as the Plugins page GitHub card. The authorization link is
 * minted when this dialog starts setup, and every outcome (Cancel on GitHub,
 * owner approval pending, a failed proof) is shown here as a message.
 */
export function GitHubAppConnectDialog({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const context = useAppContext();
  const transport = useMemo(() => context.client.connectTransport(), [context.client]);
  // One attempt identity per opening; a replaced client re-binds the same attempt.
  const [attempt] = useState(() => ({
    returnUrl: window.location.href,
    idempotencyKey: crypto.randomUUID(),
  }));
  const request = useMemo<NativeConnectRequest>(
    () => ({
      scope: { workspaceId, transport },
      providerId: "github-app",
      displayName: "GitHub App",
      description:
        "Choose the GitHub account or organization whose repositories this workspace uses.",
      ownership: "workspace",
      ...attempt,
    }),
    [attempt, transport, workspaceId],
  );
  const { refreshGitHub } = context;
  const complete = useCallback(() => {
    onClose();
    toast.success("GitHub connected");
    void refreshGitHub(workspaceId, undefined, { sync: true });
  }, [onClose, refreshGitHub, workspaceId]);
  return (
    <NativeConnectSetup
      transport={transport}
      workspaceId={workspaceId}
      request={request}
      onClose={onClose}
      onComplete={complete}
    />
  );
}
