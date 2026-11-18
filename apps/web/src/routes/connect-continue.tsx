// Where a sign-in started in the desktop app goes when it comes back to a
// browser that is not signed in to Opengeni. It may only finish as the person
// who started it, so the auth gate asks them to sign in here first; then this
// page sends the browser back to the same server step, which now finishes.
import { oauthSignInToFinishTarget } from "@opengeni/contracts";
import { useEffect, useMemo } from "react";

import { ConnectReturnCard } from "@/components/connect-return-card";

export function ConnectContinueRoute() {
  const target = useMemo(
    () => oauthSignInToFinishTarget(window.location.search, window.location.origin),
    [],
  );
  useEffect(() => {
    if (target) window.location.replace(target);
  }, [target]);
  return target ? (
    <ConnectReturnCard tone="working" title="Finishing your connection…" />
  ) : (
    <ConnectReturnCard
      tone="failed"
      title="This link doesn't work"
      body="Start connecting again from Opengeni."
    />
  );
}
