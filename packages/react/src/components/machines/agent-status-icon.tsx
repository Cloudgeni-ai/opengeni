import {
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  DownloadIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "../../lib/cn";
import type { StatusTone } from "./machine-status";

/** The leading glyph for an agent status line; color follows the shared tone. */
export function AgentStatusIcon({ tone, className }: { tone: StatusTone; className?: string }) {
  const size = cn("size-3.5 shrink-0", className);
  switch (tone) {
    case "ok":
      return <CircleCheckIcon className={cn(size, "text-og-status-idle")} aria-hidden />;
    case "progress":
      return (
        <LoaderCircleIcon className={cn(size, "animate-og-spin text-og-accent")} aria-hidden />
      );
    case "waiting":
      return <ClockIcon className={cn(size, "text-og-fg-subtle")} aria-hidden />;
    case "attention":
      return <TriangleAlertIcon className={cn(size, "text-og-status-waiting")} aria-hidden />;
    case "failed":
      return <CircleAlertIcon className={cn(size, "text-og-status-failed")} aria-hidden />;
    default:
      return <DownloadIcon className={cn(size, "text-og-fg-subtle")} aria-hidden />;
  }
}
