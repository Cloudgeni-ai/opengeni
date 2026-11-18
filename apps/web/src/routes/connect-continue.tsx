// Where a sign-in started in the desktop app goes when it comes back to a
// browser that is not signed in to Opengeni. It may only finish as the person
// who started it, so the auth gate asks them to sign in here first; then this
// page sends the browser back to the same server step, which now finishes.
// Each step is replayed once: if the server still can't see the sign-in, the
// page says so instead of bouncing between the two.
import { oauthSignInToFinishTarget } from "@opengeni/contracts";
import { useEffect, useMemo } from "react";

import { ConnectReturnCard } from "@/components/connect-return-card";

const REPLAYED_KEY = "opengeni.connectContinue.replayed";

/** True the first time a step is replayed in this tab; false after that. */
export function claimConnectContinueReplay(target: string, storage?: Storage): boolean {
  try {
    const store = storage ?? window.sessionStorage;
    const parsed: unknown = JSON.parse(store.getItem(REPLAYED_KEY) ?? "[]");
    const replayed = Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (replayed.includes(target)) return false;
    store.setItem(REPLAYED_KEY, JSON.stringify([...replayed.slice(-9), target]));
    return true;
  } catch {
    // Without storage the server's own checks still end in a refusal page.
    return true;
  }
}

export function ConnectContinueRoute() {
  const [target, replay] = useMemo(() => {
    const step = oauthSignInToFinishTarget(window.location.search, window.location.origin);
    return [step, step ? claimConnectContinueReplay(step) : false] as const;
  }, []);
  useEffect(() => {
    if (target && replay) window.location.replace(target);
  }, [replay, target]);
  return target && replay ? (
    <ConnectReturnCard tone="working" title="Finishing your connection…" />
  ) : target ? (
    <ConnectReturnCard
      tone="failed"
      title="Couldn't finish connecting"
      body="Start connecting again from Opengeni."
    />
  ) : (
    <ConnectReturnCard
      tone="failed"
      title="This link doesn't work"
      body="Start connecting again from Opengeni."
    />
  );
}
