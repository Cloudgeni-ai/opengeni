import { useCallback, useRef, useState } from "react";
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
  /** POST .../enrollments/:enrollmentId/revoke — permanently unenroll a machine. */
  revokeEnrollment?: (workspaceId: string, enrollmentId: string) => Promise<{ revoked: boolean }>;
  /**
   * POST .../sessions/:sessionId/active-sandbox — swap the session's active
   * sandbox to a machine. The default swap path; the real SDK client provides it.
   */
  swapActiveSandbox?: (
    workspaceId: string,
    sessionId: string,
    request: { target: string },
  ) => Promise<unknown>;
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
  /** Whether the host wired an attach/swap path (drives the card affordance). */
  canAttach: boolean;
  /** Fetch a downsampled metric series for one enrolled machine. */
  fetchSeries: (
    enrollmentId: string,
    window?: "15m" | "1h" | "6h" | "24h",
  ) => Promise<MetricSample[]>;
  /** Permanently revoke one connected-machine enrollment and refresh fleet truth. */
  revoke: (enrollmentId: string) => Promise<boolean>;
  /** Whether the client exposes the authenticated enrollment-management route. */
  canRevoke: boolean;
  attaching: boolean;
  /** The sandbox id of the in-flight attach (for per-card spinner gating). */
  attachingSandboxId: string | null;
  /** The enrollment id currently being revoked. */
  revokingEnrollmentId: string | null;
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
  const machinesClient = (options.machinesClient ??
    (client as unknown as MachinesClientLike)) satisfies MachinesClientLike;
  const sessionId = options.sessionId;
  const identityKey = `${workspaceId}\u0000${sessionId ?? ""}`;
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
  } = usePolledValue(load, {
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
  const [revokeState, setRevokeState] = useState<{
    identity: string;
    enrollmentId: string | null;
  }>(() => ({ identity: identityKey, enrollmentId: null }));
  const revokingEnrollmentId =
    revokeState.identity === identityKey ? revokeState.enrollmentId : null;

  const data = loadedData ?? EMPTY;
  // The swap is session-scoped: a host adapter (`attachMachine`) wins; otherwise
  // the default `swapActiveSandbox` path is wired whenever a sessionId is in
  // scope. Either way attach needs a sessionId to point at.
  const canAttach =
    sessionId !== undefined &&
    (typeof machinesClient.attachMachine === "function" ||
      typeof machinesClient.swapActiveSandbox === "function");

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
        await runSwap();
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

  const canRevoke = typeof machinesClient.revokeEnrollment === "function";
  const revoke = useCallback(
    async (enrollmentId: string): Promise<boolean> => {
      if (!machinesClient.revokeEnrollment) return false;
      const ownedIdentity = identityKey;
      setRevokeState({ identity: ownedIdentity, enrollmentId });
      const result = await run(async () => {
        // A 2xx `{ revoked: false }` is the route's retry-safe, already-revoked
        // outcome. Either value means the enrollment is terminal.
        await machinesClient.revokeEnrollment!(workspaceId, enrollmentId);
        return true;
      });
      if (identityRef.current === ownedIdentity) {
        setRevokeState({ identity: ownedIdentity, enrollmentId: null });
        if (result) await refresh();
      }
      return result === true;
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
    revoke,
    canRevoke,
    // The shared mutation runner also guards revocation. Keep this legacy flag
    // truthful: consumers must not render an attach spinner for an unenroll.
    attaching: mutating && attachingSandboxId !== null,
    attachingSandboxId,
    revokingEnrollmentId,
    mutationError,
    clearMutationError,
  };
}
