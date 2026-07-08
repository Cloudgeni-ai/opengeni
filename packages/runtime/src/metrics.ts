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
};
