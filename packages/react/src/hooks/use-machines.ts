import { useCallback, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { useMutationRunner, usePolledValue } from "./internal";
import type { MachinesResponse, MachineView, MetricSample } from "../types/machines";

/**
 * The slice of the SDK client the Machines surface needs. The method NAMES +
 * SIGNATURES match M10's `OpenGeniClient` (`listMachines`, `machineMetricsSeries`)
 * so the real SDK client satisfies this surface DIRECTLY for the read paths — no
 * adapter needed. It is declared structurally (not a hard `OpenGeniClient` Pick)
 * so a test/demo/Geni-frontend client can stand in, keeping the hook dual-consumer
 * safe (works in apps/web AND the separate Geni frontend).
 *
 * SEAM (surfaced to the orchestrator): there is no `attachMachine` REST method on
 * the M10 client — the active-sandbox SWAP is the M7 `sandbox_swap` MCP tool, not
 * a typed SDK call. So `attachMachine` is OPTIONAL here; the dashboard wires the
 * attach affordance to whatever swap path the host app exposes (an adapter or a
 * tool call). When absent, attach is a no-op and the card hides the button.
 */
export type MachinesClientLike = {
  /** GET /v1/workspaces/:ws/machines — the dashboard list + active pointer. */
  listMachines: (workspaceId: string, options?: { sessionId?: string }) => Promise<MachinesResponse>;
  /** GET .../machines/:enrollmentId/metrics/series — the downsampled history. */
  machineMetricsSeries?: (
    workspaceId: string,
    enrollmentId: string,
    options?: { window?: "15m" | "1h" | "6h" | "24h" },
  ) => Promise<MetricSample[]>;
  /** Swap the session's active sandbox to a machine. Optional (see SEAM above). */
  attachMachine?: (workspaceId: string, sandboxId: string) => Promise<unknown>;
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
  /** Whether the host wired an attach/swap path (drives the card affordance). */
  canAttach: boolean;
  /** Fetch a downsampled metric series for one enrolled machine. */
  fetchSeries: (enrollmentId: string, window?: "15m" | "1h" | "6h" | "24h") => Promise<MetricSample[]>;
  attaching: boolean;
  /** The sandbox id of the in-flight attach (for per-card spinner gating). */
  attachingSandboxId: string | null;
  mutationError: Error | null;
  clearMutationError: () => void;
};

const EMPTY: MachinesResponse = { activeSandboxId: null, activeEpoch: 0, machines: [] };

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
  const machinesClient = (options.machinesClient ?? (client as unknown as MachinesClientLike)) satisfies MachinesClientLike;
  const sessionId = options.sessionId;

  const load = useCallback(async () => {
    return await machinesClient.listMachines(workspaceId, sessionId ? { sessionId } : undefined);
  }, [machinesClient, workspaceId, sessionId]);

  const state = usePolledValue(load, { pollIntervalMs: options.pollIntervalMs, enabled: options.enabled });
  const mutation = useMutationRunner();
  // The sandbox id of the in-flight attach (drives the per-card spinner).
  const [attachingSandboxId, setAttachingSandboxId] = useState<string | null>(null);

  const data = state.data ?? EMPTY;
  const canAttach = typeof machinesClient.attachMachine === "function";

  const attach = useCallback(
    async (sandboxId: string): Promise<boolean> => {
      if (!machinesClient.attachMachine) return false;
      setAttachingSandboxId(sandboxId);
      const result = await mutation.run(async () => {
        await machinesClient.attachMachine!(workspaceId, sandboxId);
        return true;
      });
      setAttachingSandboxId(null);
      if (result) await state.refresh();
      return result === true;
    },
    [machinesClient, workspaceId, mutation.run, state.refresh],
  );

  const fetchSeries = useCallback(
    async (enrollmentId: string, window: "15m" | "1h" | "6h" | "24h" = "1h"): Promise<MetricSample[]> => {
      if (!machinesClient.machineMetricsSeries) return [];
      return await machinesClient.machineMetricsSeries(workspaceId, enrollmentId, { window });
    },
    [machinesClient, workspaceId],
  );

  return {
    machines: data.machines,
    activeSandboxId: data.activeSandboxId,
    activeEpoch: data.activeEpoch,
    loading: state.loading,
    error: state.error,
    refresh: state.refresh,
    attach,
    canAttach,
    fetchSeries,
    attaching: mutation.mutating,
    attachingSandboxId,
    mutationError: mutation.mutationError,
    clearMutationError: mutation.clearMutationError,
  };
}
