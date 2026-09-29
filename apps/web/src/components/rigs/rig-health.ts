import type { StatusTone } from "@/components/ui/status-dot";
import { rigCheckHealthView, versionHasChecks } from "@/lib/rig-status";
import type { Rig } from "@/types";

/** One health line for an environment: its active version's last check run. */
export function rigHealth(rig: Rig): { tone: StatusTone; label: string; description: string } {
  const active = rig.activeVersion;
  if (!active) {
    return {
      tone: "queued",
      label: "No active version",
      description: "Promote a verified change to create the first version.",
    };
  }
  if (!versionHasChecks(active)) {
    return {
      tone: "cancelled",
      label: "No checks",
      description: "This version declares no checks.",
    };
  }
  const view = rigCheckHealthView(rig.activeVersionHealth?.checkHealth ?? "unknown");
  return { tone: view.tone, label: view.label, description: view.description };
}
