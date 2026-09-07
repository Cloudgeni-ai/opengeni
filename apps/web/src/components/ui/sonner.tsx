import { useAppearance } from "@/lib/appearance";
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useAppearance();
  return (
    <Sonner
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
