export type KnowledgeSourceSyncDriverInventory<Entry, StopReason extends string> = {
  status: "complete" | "paused";
  stopReason: StopReason | null;
  entries: Entry[];
  checkpoint: Record<string, unknown> | null;
  providerCursor: Record<string, unknown> | null;
  authoritativeFullScan: boolean;
  cursorInvalidated: boolean;
  providerRequests: number;
  elapsedMs: number;
  hardLimitReached: boolean;
};

/** Provider port for deterministic knowledge ingestion. Implementations own
 * provider JSON and byte transfer; the shared activity owns authority,
 * persistence, indexing obligations, telemetry, and checkpoint settlement. */
export type KnowledgeSourceSyncDriver<Entry, StopReason extends string> = {
  providerKey: string;
  providerDomain: string;
  providerCoordinationKey: string;
  inventory: (
    executionCheckpoint: Record<string, unknown> | null,
    providerCursor: Record<string, unknown> | null,
  ) => Promise<KnowledgeSourceSyncDriverInventory<Entry, StopReason>>;
  fetchContent: (entry: Entry, maxBytes: number) => Promise<Uint8Array>;
  citationLocator: (entry: Entry) => Record<string, unknown>;
};
