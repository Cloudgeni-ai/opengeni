export type RuntimeMetricsHooks = {
  onModelCall?: (input: {
    provider: string;
    outcome: "completed" | "failed";
    durationSeconds: number;
  }) => void;
  onSandboxCreate?: (input: {
    backend: string;
    outcome: "completed" | "failed";
    durationSeconds: number;
  }) => void;
  onSandboxWarmingTimeout?: (input: { backend: string }) => void;
  /**
   * One completed Connected Machine (selfhosted) control op — the out-of-band
   * telemetry twin of the in-band fault rendering. `code` is the typed wire-code
   * NAME on a failure (bounded label cardinality); `healed` marks a success that
   * only landed after ≥1 retry (the leading indicator of the next unhealed fault);
   * `replyBytes` is set only on a payload-wall fault. Wired from the runtime's
   * `SelfhostedOpObserver` seam.
   */
  onSandboxOp?: (input: {
    backend: string;
    op: string;
    outcome: "ok" | "failed";
    code?: string;
    healed: boolean;
    retries: number;
    durationSeconds: number;
    replyBytes?: number;
  }) => void;
};
