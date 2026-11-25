import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  routeRecoveryNoticeText,
  takeRouteRecoveryNotice,
} from "@opengeni/react/app/lib/route-recovery-notice";

/**
 * Says once, after the signed-in app has loaded, why this page opened instead
 * of the one the person was on (another account signed in, or a workspace
 * they can't open).
 */
export function RouteRecoveryNotice({ ready }: { ready: boolean }) {
  // Only a notice the previous page left: one this page keeps on its way out
  // (it is about to load the destination) belongs to the next page.
  const [notice] = useState(takeRouteRecoveryNotice);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!ready || shown || !notice) return;
    setShown(true);
    // Long enough to read once the destination has drawn: it explains why the page changed.
    toast.info(routeRecoveryNoticeText(notice), { duration: 8_000 });
  }, [notice, ready, shown]);
  return null;
}
