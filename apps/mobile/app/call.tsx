import { Redirect, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { useAccount } from "@/account";
import { useAgentCall } from "@/call";

/**
 * opengeni://call starts a call from outside the app (a Shortcut, the Action
 * button, a widget); opengeni://call?session=<id> calls that session.
 */
export default function CallLink() {
  const { session } = useLocalSearchParams<{ session?: string }>();
  const { workspaceId } = useAccount();
  const { callFromOutside } = useAgentCall();
  const [started, setStarted] = useState(false);
  // Wait for the account on a cold launch; leave only once the call is requested.
  useEffect(() => {
    if (started || !workspaceId) return;
    setStarted(true);
    void callFromOutside(session ?? null);
  }, [callFromOutside, session, started, workspaceId]);
  return started ? <Redirect href={session ? `/session/${session}` : "/"} /> : null;
}
