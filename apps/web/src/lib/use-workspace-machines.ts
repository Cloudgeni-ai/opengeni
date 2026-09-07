import { useOpenGeni } from "@opengeni/react";
import { useMachines, type UseMachinesOptions } from "@opengeni/react/machines";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";

// Stock-console reads follow the current workspace grant. The public React
// hook remains usable by embedding hosts with their own authorization model.
export function useWorkspaceMachines(options: UseMachinesOptions = {}) {
  const { workspaceId } = useOpenGeni();
  const { accessContext } = useAppContext();
  const canRead = hasWorkspacePermission(
    accessContext,
    options.workspaceId ?? workspaceId,
    "enrollments:read",
  );
  const fleet = useMachines({ ...options, enabled: canRead && options.enabled !== false });
  return {
    ...fleet,
    canRead,
    machines: canRead ? fleet.machines : [],
    activeSandboxId: canRead ? fleet.activeSandboxId : null,
    loading: canRead && fleet.loading,
    error: canRead ? fleet.error : null,
    refresh: canRead ? fleet.refresh : async () => {},
    canAttach: canRead && fleet.canAttach,
  };
}
