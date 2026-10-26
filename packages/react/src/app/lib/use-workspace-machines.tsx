import { useOpenGeni } from "../../session-context";
import {
  useMachines,
  type MachineView,
  type MetricSample,
  type UseMachinesOptions,
} from "../../machines";
import { useAppContext } from "../app-context";
import type { AccessContext } from "../types";
import { hasWorkspacePermission } from "./permissions";

const EMPTY_MACHINES: MachineView[] = [];
const ignoreRefresh = async () => {};
const denyMutation = async () => null;
const denyAttach = async () => false;
const emptySeries = async (): Promise<MetricSample[]> => [];

/**
 * The signed-in person themself, not a key, a delegated credential or an
 * agent: an Opengeni account (`user:`) or the local install's person (`dev`).
 * Mirrors the API's rule for Only me machines; the API still decides.
 */
export function isSignedInPerson(context: AccessContext | null, workspaceId: string): boolean {
  if (!context || context.credential) return false;
  const person =
    context.mode === "local" ? context.subjectId === "dev" : context.subjectId.startsWith("user:");
  const grant = context.workspaceGrants.find((candidate) => candidate.workspaceId === workspaceId);
  return Boolean(
    person &&
    grant &&
    grant.subjectId === context.subjectId &&
    grant.principalKind === "human_session" &&
    grant.metadata?.delegated !== true &&
    !grant.serviceInitiator,
  );
}

// Stock-console reads follow the current workspace grant. The public React
// hook remains usable by embedding hosts with their own authorization model.
// Anyone who can see machines connects and changes their own Only me
// machines; workspace machines need enrollments:manage (`canManage`).
export function useWorkspaceMachines(options: UseMachinesOptions = {}) {
  const { workspaceId } = useOpenGeni();
  const { accessContext } = useAppContext();
  const targetWorkspaceId = options.workspaceId ?? workspaceId;
  const canRead =
    (!options.sessionId ||
      hasWorkspacePermission(accessContext, targetWorkspaceId, "sessions:read")) &&
    hasWorkspacePermission(accessContext, targetWorkspaceId, "enrollments:read");
  const canManage =
    canRead && hasWorkspacePermission(accessContext, targetWorkspaceId, "enrollments:manage");
  /** Connect a machine: Only me for every teammate, This workspace with canManage. */
  const canConnect = canManage || (canRead && isSignedInPerson(accessContext, targetWorkspaceId));
  const canControl =
    canRead && hasWorkspacePermission(accessContext, targetWorkspaceId, "sessions:control");
  const fleet = useMachines({ ...options, enabled: canRead && options.enabled !== false });
  const machines = canRead ? fleet.machines : EMPTY_MACHINES;
  /** Change this machine: your own Only me machine, or any with canManage. */
  const canManageMachine = (machine: Pick<MachineView, "scope">) =>
    machine.scope === "user" ? canConnect : canManage;
  const mayChange = (enrollmentId: string) => {
    const machine = machines.find((candidate) => candidate.enrollmentId === enrollmentId);
    return machine ? canManageMachine(machine) : canManage;
  };
  return {
    ...fleet,
    canRead,
    canManage,
    canConnect,
    canManageMachine,
    canControl,
    canRemove: canConnect && fleet.canRemove,
    canUpdateAgent: canConnect && fleet.canUpdateAgent,
    canUpdateOperationPolicy: canConnect && fleet.canUpdateOperationPolicy,
    remove: (...args: Parameters<typeof fleet.remove>) =>
      mayChange(args[0]) ? fleet.remove(...args) : denyMutation(),
    updateAgent: (...args: Parameters<typeof fleet.updateAgent>) =>
      mayChange(args[0]) ? fleet.updateAgent(...args) : denyMutation(),
    updateOperationPolicy: (...args: Parameters<typeof fleet.updateOperationPolicy>) =>
      mayChange(args[0]) ? fleet.updateOperationPolicy(...args) : denyMutation(),
    attach: canControl ? fleet.attach : denyAttach,
    fetchSeries: canRead ? fleet.fetchSeries : emptySeries,
    mutationError: canRead ? fleet.mutationError : null,
    machines,
    activeSandboxId: canRead ? fleet.activeSandboxId : null,
    sessionMachineAccess: canRead ? fleet.sessionMachineAccess : null,
    loading: canRead && fleet.loading,
    error: canRead ? fleet.error : null,
    refresh: canRead ? fleet.refresh : ignoreRefresh,
    canAttach: canControl && fleet.canAttach,
  };
}
