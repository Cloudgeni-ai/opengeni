import { useCallback, useRef, useState } from "react";
import type {
  RemoveEnrollmentRequest,
  RemoveEnrollmentResponse,
  MachineOperationPolicy,
  SwapActiveSandboxResponse,
  UpdateMachineOperationPolicyRequest,
  UpdateMachineAgentResponse,
} from "@opengeni/sdk";
import { useOpenGeni, type ClientOverride } from "../provider";
import { useMutationRunner } from "./internal";
import { EMPTY_MACHINES, useSharedMachinesList } from "./shared-machines-list";
import type { MachinesResponse, MachineView, MetricSample } from "../types/machines";

/** Dashboard list: cheap heartbeat read, keep the pill reasonably fresh. */
export const MACHINES_DASHBOARD_POLL_MS = 10_000;
/** Session surfaces share one poll for the same workspace+session. */
export const MACHINES_SESSION_POLL_MS = 15_000;
/** Composer polls only after the first load shows a machine. */
export const MACHINES_COMPOSER_POLL_MS = 30_000;

const machinesClientIds = new WeakMap<object, number>();
let nextMachinesClientId = 1;

function machinesClientId(client: object): number {
  const existing = machinesClientIds.get(client);
  if (existing !== undefined) return existing;
  const id = nextMachinesClientId++;
  machinesClientIds.set(client, id);
  return id;
}

/**
 * The slice of the SDK client the Machines surface needs. The method NAMES +
 * SIGNATURES match M10's `OpenGeniClient` (`listMachines`, `machineMetricsSeries`)
 * so the real SDK client satisfies this surface DIRECTLY for the read paths — no
 * adapter needed. It is declared structurally (not a hard `OpenGeniClient` Pick)
 * so a test/demo/Geni-frontend client can stand in, keeping the hook dual-consumer
 * safe (works in apps/web AND the separate Geni frontend).
 *
 * The active-sandbox SWAP is now a typed SDK call (`swapActiveSandbox`, the M7
 * user-authenticated REST equivalent of the `sandbox_swap` MCP tool). The real
 * SDK client satisfies it structurally, so the default attach path is wired
 * WHENEVER a sessionId is in scope (the swap is session-scoped). `attachMachine`
 * stays an OPTIONAL escape hatch for a host that wants to supply its own swap
 * adapter; when neither it nor a sessionId is present, attach is a no-op and the
 * card hides the button.
 */
export type MachinesClientLike = {
  /** GET /v1/workspaces/:ws/machines — the dashboard list + active pointer. */
  listMachines: (
    workspaceId: string,
    options?: { sessionId?: string; signal?: AbortSignal },
  ) => Promise<MachinesResponse>;
  /** GET .../machines/:enrollmentId/metrics/series — the downsampled history. */
  machineMetricsSeries?: (
    workspaceId: string,
    enrollmentId: string,
    options?: { window?: "15m" | "1h" | "6h" | "24h" },
  ) => Promise<MetricSample[]>;
  /** POST .../enrollments/:enrollmentId/revoke — workspace-admin removal. */
  removeEnrollment?: (
    workspaceId: string,
    enrollmentId: string,
    request?: RemoveEnrollmentRequest,
  ) => Promise<RemoveEnrollmentResponse>;
  /** POST .../machines/:enrollmentId/update — signed, generation-fenced update. */
  updateMachineAgent?: (
    workspaceId: string,
    enrollmentId: string,
  ) => Promise<UpdateMachineAgentResponse>;
  /** PATCH .../machines/:enrollmentId/operation-policy — revision-fenced policy. */
  updateMachineOperationPolicy?: (
    workspaceId: string,
    enrollmentId: string,
    request: UpdateMachineOperationPolicyRequest,
  ) => Promise<MachineOperationPolicy>;
  /**
   * POST .../sessions/:sessionId/active-sandbox — swap the session's active
   * sandbox to a machine. The default swap path; the real SDK client provides it.
   */
  swapActiveSandbox?: (
    workspaceId: string,
    sessionId: string,
    request: { target: string },
  ) => Promise<SwapActiveSandboxResponse>;
  /**
   * Host-supplied swap adapter (an escape hatch). When present it wins over the
   * default `swapActiveSandbox` path. Session-scoped, like the swap it backs.
   */
  attachMachine?: (workspaceId: string, sessionId: string, sandboxId: string) => Promise<unknown>;
};

export type UseMachinesOptions = ClientOverride & {
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
  /** Scope the list to a session (adds the synthetic Modal group box + pointer). */
  sessionId?: string | undefined;
  /**
   * Override the client with one implementing `MachinesClientLike`. Defaults to
   * the provider client cast to the surface (the real SDK client satisfies the
   * read paths). An app supplies an adapter to wire `attachMachine` (the swap).
   */
  machinesClient?: MachinesClientLike | undefined;
};

export type UseMachinesResult = {
  machines: MachineView[];
  activeSandboxId: string | null;
  activeEpoch: number;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  /** Attach/swap the session's active sandbox to a machine (returns the new pointer). */
  attach: (sandboxId: string) => Promise<boolean>;
  /** Remove a self-hosted enrollment while retaining history. */
  remove: (
    enrollmentId: string,
    request?: RemoveEnrollmentRequest,
  ) => Promise<RemoveEnrollmentResponse | null>;
  canRemove: boolean;
  removingEnrollmentId: string | null;
  /** Start/retry the signed self-update for one Connected Machine. */
  updateAgent: (enrollmentId: string) => Promise<UpdateMachineAgentResponse | null>;
  canUpdateAgent: boolean;
  updatingEnrollmentId: string | null;
  /** Update the optional per-enrollment command memory policy. */
  updateOperationPolicy: (
    enrollmentId: string,
    request: UpdateMachineOperationPolicyRequest,
  ) => Promise<MachineOperationPolicy | null>;
  canUpdateOperationPolicy: boolean;
  updatingOperationPolicyEnrollmentId: string | null;
  /** Whether the host wired an attach/swap path (drives the card affordance). */
  canAttach: boolean;
  /** Fetch a downsampled metric series for one enrolled machine. */
  fetchSeries: (
    enrollmentId: string,
    window?: "15m" | "1h" | "6h" | "24h",
  ) => Promise<MetricSample[]>;
  attaching: boolean;
  /** The sandbox id of the in-flight attach (for per-card spinner gating). */
  attachingSandboxId: string | null;
  mutationError: Error | null;
  clearMutationError: () => void;
};

function swapFailureMessage(result: SwapActiveSandboxResponse): string {
  if (result.reason?.trim()) return result.reason;
  switch (result.code) {
    case "recovery_in_progress":
      return "The managed sandbox is still recovering. Try again shortly.";
    case "recovery_degraded":
      return "The managed sandbox recovery is degraded and needs attention.";
    case "recovery_unrecoverable":
      return "The managed sandbox could not be recovered.";
    case "offline_enrollment":
      return "The selected machine is offline.";
    case "concurrent_swap":
      return "The session route changed concurrently. Refresh and try again.";
    default:
      return "The session stayed on its current sandbox.";
  }
}

/**
 * The workspace Machines fleet: the selfhosted enrollments + the session's Modal
 * box, each with latest metrics + state, plus the active-sandbox pointer. Polls
 * the M10 `GET /machines` endpoint and exposes attach/swap + a metric-series
 * fetch. Renders via `<MachinesDashboard>`. Dual-consumer safe: it reads only the
 * structural `MachinesClientLike` surface, so it works in apps/web AND the Geni
 * frontend (each provides its own client/adapter).
 */
export function useMachines(options: UseMachinesOptions = {}): UseMachinesResult {
  const { client, workspaceId } = useOpenGeni(options);
  const machinesClient = (options.machinesClient ??
    (client as unknown as MachinesClientLike)) satisfies MachinesClientLike;
  const sessionId = options.sessionId;
  const identityKey = `${workspaceId}\u0000${sessionId ?? ""}\u0000${machinesClientId(machinesClient)}`;
  const identityRef = useRef(identityKey);
  identityRef.current = identityKey;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      return await machinesClient.listMachines(workspaceId, {
        ...(sessionId ? { sessionId } : {}),
        ...(signal ? { signal } : {}),
      });
    },
    [machinesClient, workspaceId, sessionId],
  );

  const {
    data: loadedData,
    loading,
    error,
    refresh,
  } = useSharedMachinesList(identityKey, load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  const { run, mutating, mutationError, clearMutationError } = useMutationRunner(identityKey);
  // The sandbox id of the in-flight attach (drives the per-card spinner).
  const [attachState, setAttachState] = useState<{
    identity: string;
    sandboxId: string | null;
  }>(() => ({ identity: identityKey, sandboxId: null }));
  const attachingSandboxId = attachState.identity === identityKey ? attachState.sandboxId : null;
  const [removeState, setRemoveState] = useState<{
    identity: string;
    enrollmentId: string | null;
  }>(() => ({ identity: identityKey, enrollmentId: null }));
  const removingEnrollmentId =
    removeState.identity === identityKey ? removeState.enrollmentId : null;
  const [updateState, setUpdateState] = useState<{
    identity: string;
    enrollmentId: string | null;
  }>(() => ({ identity: identityKey, enrollmentId: null }));
  const updatingEnrollmentId =
    updateState.identity === identityKey ? updateState.enrollmentId : null;
  const [operationPolicyState, setOperationPolicyState] = useState<{
    identity: string;
    enrollmentId: string | null;
  }>(() => ({ identity: identityKey, enrollmentId: null }));
  const updatingOperationPolicyEnrollmentId =
    operationPolicyState.identity === identityKey ? operationPolicyState.enrollmentId : null;

  const data = loadedData ?? EMPTY_MACHINES;
  // The swap is session-scoped: a host adapter (`attachMachine`) wins; otherwise
  // the default `swapActiveSandbox` path is wired whenever a sessionId is in
  // scope. Either way attach needs a sessionId to point at.
  const canAttach =
    sessionId !== undefined &&
    (typeof machinesClient.attachMachine === "function" ||
      typeof machinesClient.swapActiveSandbox === "function");
  const canRemove = typeof machinesClient.removeEnrollment === "function";
  const canUpdateAgent = typeof machinesClient.updateMachineAgent === "function";
  const canUpdateOperationPolicy =
    typeof machinesClient.updateMachineOperationPolicy === "function";

  const attach = useCallback(
    async (sandboxId: string): Promise<boolean> => {
      if (sessionId === undefined) return false;
      const runSwap = machinesClient.attachMachine
        ? () => machinesClient.attachMachine!(workspaceId, sessionId, sandboxId)
        : machinesClient.swapActiveSandbox
          ? () => machinesClient.swapActiveSandbox!(workspaceId, sessionId, { target: sandboxId })
          : null;
      if (!runSwap) return false;
      const ownedIdentity = identityKey;
      setAttachState({ identity: ownedIdentity, sandboxId });
      const result = await run(async () => {
        const response = await runSwap();
        if (
          response &&
          typeof response === "object" &&
          "swapped" in response &&
          response.swapped === false
        ) {
          throw new Error(swapFailureMessage(response as SwapActiveSandboxResponse));
        }
        return true;
      });
      if (identityRef.current === ownedIdentity) {
        setAttachState({ identity: ownedIdentity, sandboxId: null });
        if (result) await refresh();
      }
      return result === true;
    },
    [machinesClient, workspaceId, sessionId, identityKey, run, refresh],
  );

  const fetchSeries = useCallback(
    async (
      enrollmentId: string,
      window: "15m" | "1h" | "6h" | "24h" = "1h",
    ): Promise<MetricSample[]> => {
      if (!machinesClient.machineMetricsSeries) return [];
      return await machinesClient.machineMetricsSeries(workspaceId, enrollmentId, { window });
    },
    [machinesClient, workspaceId],
  );

  const remove = useCallback(
    async (
      enrollmentId: string,
      request: RemoveEnrollmentRequest = {},
    ): Promise<RemoveEnrollmentResponse | null> => {
      if (!machinesClient.removeEnrollment) return null;
      const ownedIdentity = identityKey;
      setRemoveState({ identity: ownedIdentity, enrollmentId });
      const result = await run(() =>
        machinesClient.removeEnrollment!(workspaceId, enrollmentId, request),
      );
      if (identityRef.current === ownedIdentity) {
        setRemoveState({ identity: ownedIdentity, enrollmentId: null });
        if (result?.outcome === "removed" || result?.outcome === "already_removed") {
          await refresh();
        }
      }
      return result;
    },
    [machinesClient, workspaceId, identityKey, run, refresh],
  );

  const updateAgent = useCallback(
    async (enrollmentId: string): Promise<UpdateMachineAgentResponse | null> => {
      if (!machinesClient.updateMachineAgent) return null;
      const ownedIdentity = identityKey;
      setUpdateState({ identity: ownedIdentity, enrollmentId });
      const result = await run(() => machinesClient.updateMachineAgent!(workspaceId, enrollmentId));
      if (identityRef.current === ownedIdentity) {
        setUpdateState({ identity: ownedIdentity, enrollmentId: null });
        await refresh();
      }
      return result;
    },
    [machinesClient, workspaceId, identityKey, run, refresh],
  );

  const updateOperationPolicy = useCallback(
    async (
      enrollmentId: string,
      request: UpdateMachineOperationPolicyRequest,
    ): Promise<MachineOperationPolicy | null> => {
      if (!machinesClient.updateMachineOperationPolicy) return null;
      const ownedIdentity = identityKey;
      setOperationPolicyState({ identity: ownedIdentity, enrollmentId });
      const result = await run(() =>
        machinesClient.updateMachineOperationPolicy!(workspaceId, enrollmentId, request),
      );
      if (identityRef.current === ownedIdentity) {
        setOperationPolicyState({ identity: ownedIdentity, enrollmentId: null });
        if (result) await refresh();
      }
      return result;
    },
    [machinesClient, workspaceId, identityKey, run, refresh],
  );

  return {
    machines: data.machines,
    activeSandboxId: data.activeSandboxId,
    activeEpoch: data.activeEpoch,
    loading,
    error,
    refresh,
    attach,
    canAttach,
    fetchSeries,
    attaching: mutating && attachingSandboxId !== null,
    attachingSandboxId,
    remove,
    canRemove,
    removingEnrollmentId,
    updateAgent,
    canUpdateAgent,
    updatingEnrollmentId,
    updateOperationPolicy,
    canUpdateOperationPolicy,
    updatingOperationPolicyEnrollmentId,
    mutationError,
    clearMutationError,
  };
}
