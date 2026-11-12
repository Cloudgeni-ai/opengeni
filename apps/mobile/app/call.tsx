import { Redirect, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { useAccount } from "@/account";
import { appSessionPath } from "@/app-links";
import { useAgentCall } from "@/call";

/**
 * opengeni://call starts a call from outside the app (a Shortcut, the Action
 * button, a widget); opengeni://call?session=<id> calls that session, and
 * &workspace=<id> names its workspace when it may not be the current one.
 */
export default function CallLink() {
  const { session, workspace } = useLocalSearchParams<{ session?: string; workspace?: string }>();
  const { workspaceId, status } = useAccount();
  const { callFromOutside } = useAgentCall();
  const [started, setStarted] = useState(false);
  // Wait for the account on a cold launch (its sign-in read, not only its saved
  // workspace); leave only once the call is requested.
  useEffect(() => {
    if (started || !workspaceId || status !== "ready") return;
    setStarted(true);
    void callFromOutside(session ?? null, workspace ?? null);
  }, [callFromOutside, session, started, status, workspace, workspaceId]);
  if (!started) return null;
  return (
    <Redirect
      href={
        session
          ? workspace
            ? appSessionPath(session, workspace, null)
            : `/session/${session}`
          : "/"
      }
    />
  );
}
