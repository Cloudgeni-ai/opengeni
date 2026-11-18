// Where a sign-in started in the desktop app lands in the person's browser once
// the provider is done. PUBLIC: the browser need not be signed in to Opengeni,
// so `RootRouteComponent` renders this ahead of the auth gate and without the
// app context. The app watches the connection itself and shows it without this
// page; the page says the browser's part is over, shows the outcome the return
// link carries, and offers to bring the app forward.
import { useEffect, useMemo } from "react";

import { Button } from "@opengeni/react/ui/button";
import { desktopBridge } from "@opengeni/react/app/lib/desktop";
import { ConnectReturnCard } from "@/components/connect-return-card";
import {
  desktopReturnAppLink,
  desktopReturnOutcome,
  desktopReturnTarget,
  type DesktopReturnOutcome,
} from "@/lib/desktop-return";

export function DesktopReturnRoute() {
  const target = useMemo(
    () => desktopReturnTarget(window.location.search, window.location.origin),
    [],
  );
  const appLink = target ? desktopReturnAppLink(target) : null;

  useEffect(() => {
    if (!target || !appLink) return;
    // Already inside the app: just continue there.
    if (desktopBridge) window.location.replace(target);
    // Bring the app forward. Nothing depends on it: the app already updated itself.
    else window.location.assign(appLink);
  }, [appLink, target]);

  return (
    <DesktopReturnView
      outcome={desktopReturnOutcome(target)}
      appLink={appLink}
      browserLink={target}
    />
  );
}

const COPY: Record<DesktopReturnOutcome["kind"], { title: string; body: string }> = {
  connected: { title: "Connected", body: "You can close this tab. Opengeni shows the connection." },
  failed: { title: "Couldn't connect", body: "" },
  done: { title: "Done", body: "You can close this tab and go back to Opengeni." },
};

/** The page's content; `DesktopReturnRoute` supplies it from the return link. */
export function DesktopReturnView({
  outcome,
  appLink,
  browserLink,
}: {
  outcome: DesktopReturnOutcome;
  appLink: string | null;
  browserLink: string | null;
}) {
  const copy = COPY[outcome.kind];
  return (
    <ConnectReturnCard
      tone={outcome.kind}
      title={copy.title}
      body={outcome.kind === "failed" ? outcome.message : copy.body}
    >
      {appLink && browserLink ? (
        <div className="mt-5 flex flex-col gap-2">
          <Button asChild variant={outcome.kind === "failed" ? "default" : "outline"}>
            <a href={appLink}>Open Opengeni</a>
          </Button>
          <Button asChild variant="ghost" size="sm" className="text-fg-subtle">
            <a href={browserLink}>Continue in this browser</a>
          </Button>
        </div>
      ) : null}
    </ConnectReturnCard>
  );
}
