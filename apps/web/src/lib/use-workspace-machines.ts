import { useOpenGeni } from "@opengeni/react";
import {
  useMachines,
  type MachineView,
  type MetricSample,
  type UseMachinesOptions,
} from "@opengeni/react/machines";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";

const EMPTY_MACHINES: MachineView[] = [];
const ignoreRefresh = async () => {};
const denyMutation = async () => null;
const denyAttach = async () => false;
const emptySeries = async (): Promise<MetricSample[]> => [];

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
  const canManage =
    canRead &&
    hasWorkspacePermission(accessContext, options.workspaceId ?? workspaceId, "enrollments:manage");
  const canControl =
    canRead &&
    hasWorkspacePermission(accessContext, options.workspaceId ?? workspaceId, "sessions:control");
  const fleet = useMachines({ ...options, enabled: canRead && options.enabled !== false });
  return {
    ...fleet,
    canRead,
    canManage,
    canControl,
    canRemove: canManage && fleet.canRemove,
    canUpdateAgent: canManage && fleet.canUpdateAgent,
    canUpdateOperationPolicy: canManage && fleet.canUpdateOperationPolicy,
    remove: canManage ? fleet.remove : denyMutation,
    updateAgent: canManage ? fleet.updateAgent : denyMutation,
    updateOperationPolicy: canManage ? fleet.updateOperationPolicy : denyMutation,
    attach: canControl ? fleet.attach : denyAttach,
    fetchSeries: canRead ? fleet.fetchSeries : emptySeries,
    mutationError: canRead ? fleet.mutationError : null,
    machines: canRead ? fleet.machines : EMPTY_MACHINES,
    activeSandboxId: canRead ? fleet.activeSandboxId : null,
    loading: canRead && fleet.loading,
    error: canRead ? fleet.error : null,
    refresh: canRead ? fleet.refresh : ignoreRefresh,
    canAttach: canControl && fleet.canAttach,
  };
}
