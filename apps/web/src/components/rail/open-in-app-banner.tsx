import { useRouterState } from "@tanstack/react-router";
import { SmartphoneIcon } from "lucide-react";
import { useState } from "react";

import { Notice } from "@/components/ui/notice";
import {
  currentPhoneAppPlatform,
  dismissOpenInAppBanner,
  isAppOpenablePath,
  openInAppBannerDismissed,
  openInAppUrl,
} from "@/lib/open-in-app";

/**
 * On a phone browser, sessions and workspaces offer to open in the phone app.
 * Hiding it is remembered on this device; the session menu keeps "Open in app".
 */
export function OpenInAppBanner() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [hidden, setHidden] = useState(() => openInAppBannerDismissed());
  if (hidden || !currentPhoneAppPlatform() || !isAppOpenablePath(pathname)) return null;
  return (
    <Notice
      layout="banner"
      tone="muted"
      icon={<SmartphoneIcon className="size-4" />}
      className="shrink-0 bg-surface"
      dismissLabel="Hide"
      onDismiss={() => {
        dismissOpenInAppBanner();
        setHidden(true);
      }}
      action={
        <a
          href={openInAppUrl(window.location.href)}
          className="inline-flex h-8 items-center rounded-md px-2 text-xs font-medium og-link pointer-coarse:h-11"
        >
          Open in app
        </a>
      }
    >
      <span className="text-fg-muted">Have the Opengeni app? Continue there.</span>
    </Notice>
  );
}
