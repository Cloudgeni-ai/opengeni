import { useEffect, useState, type ReactNode } from "react";

import { desktopCapability, restoreDesktopWebSession } from "@/lib/desktop";

/**
 * Inside the desktop app the person is still signed in to the app when the
 * page's own web sign-in lapses: renew it and reload instead of showing the
 * web sign-in form. The form shows only when the app can't renew it.
 */
export function DesktopSignedOutRecovery({ children }: { children: ReactNode }) {
  const desktop = Boolean(desktopCapability("accounts"));
  const [checking, setChecking] = useState(desktop);
  useEffect(() => {
    if (!desktop) return;
    let live = true;
    void restoreDesktopWebSession().then((restored) => {
      if (live && !restored) setChecking(false);
    });
    return () => {
      live = false;
    };
  }, [desktop]);
  return checking ? null : <>{children}</>;
}
