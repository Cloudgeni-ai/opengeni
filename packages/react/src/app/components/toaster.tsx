import { useAppearance } from "../lib/appearance";
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

import {
  OPENGENI_TOASTER_ID,
  retainEmbeddedToaster,
  showsEmbeddedToasts,
  subscribeEmbeddedToasters,
} from "../lib/toast";

/**
 * The page's toaster. `embedded` keeps the session UI's toasts apart from
 * the host page's own sonner toasts (see lib/toast).
 */
const Toaster = ({ embedded = false, ...props }: ToasterProps & { embedded?: boolean }) => {
  const { resolvedTheme } = useAppearance();
  const [owner] = useState(() => Symbol("toaster"));
  useEffect(() => (embedded ? retainEmbeddedToaster(owner) : undefined), [embedded, owner]);
  const shows = useSyncExternalStore(
    subscribeEmbeddedToasters,
    () => !embedded || showsEmbeddedToasts(owner),
    () => !embedded,
  );
  if (!shows) return null;
  return (
    <Sonner
      {...(embedded ? { id: OPENGENI_TOASTER_ID } : {})}
      theme={resolvedTheme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--og-color-surface-3)",
          "--normal-text": "var(--og-color-fg)",
          "--normal-border": "var(--og-color-border)",
          "--border-radius": "var(--og-radius-md)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
