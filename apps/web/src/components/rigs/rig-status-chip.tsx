// The one status chip for rig changes and check health. Wraps MetaChip with a
// tone dot + human label from lib/rig-status, so no rig surface hand-rolls a
// status pill or shows a raw enum slug.
import { MetaChip } from "@/components/ui/meta-chip";
import { cn } from "@/lib/utils";
import type { RigStatusView } from "@/lib/rig-status";

export function RigStatusChip({ view, className }: { view: RigStatusView; className?: string }) {
  return (
    <MetaChip
      dot={view.tone}
      title={view.description}
      className={cn(
        view.pulse ? "[&>span:first-child]:motion-safe:animate-pulse" : undefined,
        className,
      )}
    >
      {view.label}
    </MetaChip>
  );
}
