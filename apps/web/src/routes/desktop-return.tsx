// Where a sign-in started in the desktop app lands in the person's browser once
// the provider is done. PUBLIC: the browser need not be signed in to Opengeni,
// so `RootRouteComponent` renders this ahead of the auth gate and without the
// app context. It opens the app, which shows how the sign-in went (connected,
// cancelled or failed); this page cannot know, so it claims neither.
import { AppWindowIcon } from "lucide-react";
import { useEffect, useMemo } from "react";

import { Button } from "@opengeni/react/ui/button";
import { desktopBridge } from "@opengeni/react/app/lib/desktop";
import { desktopReturnAppLink, desktopReturnTarget } from "@/lib/desktop-return";

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
    else window.location.assign(appLink);
  }, [appLink, target]);

  return (
    <section className="og-page-glow flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <AppWindowIcon className="size-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold">Back to Opengeni</h1>
            <p className="text-sm text-fg-subtle">Continue in the app where you started.</p>
          </div>
        </div>
        {appLink && target ? (
          <>
            <p className="text-sm text-fg-muted">
              Opengeni opens by itself and shows the result there. If your browser asks, allow it to
              open Opengeni. You can close this tab afterwards.
            </p>
            <Button asChild className="mt-4 w-full">
              <a href={appLink}>Open Opengeni</a>
            </Button>
            <Button asChild variant="ghost" className="mt-2 w-full">
              <a href={target}>Continue in this browser</a>
            </Button>
          </>
        ) : (
          <p className="text-sm text-fg-muted">
            Go back to the Opengeni app to continue. You can close this tab.
          </p>
        )}
      </div>
    </section>
  );
}
