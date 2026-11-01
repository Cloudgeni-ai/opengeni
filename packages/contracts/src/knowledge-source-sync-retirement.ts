import {
  ATLASSIAN_NATIVE_RETIRED_MESSAGE,
  ATLASSIAN_NATIVE_RETIRED_REASON,
  isRetiredNativeAtlassianSource,
} from "./atlassian-native-retirement";
import {
  GOOGLE_DRIVE_NATIVE_RETIRED_MESSAGE,
  GOOGLE_DRIVE_NATIVE_RETIRED_REASON,
  isRetiredNativeGoogleDriveSource,
} from "./google-drive-native-retirement";

/**
 * Integrations give agents tools and access; they no longer import provider
 * content into Knowledge. Recurring work uses an ordinary agent schedule that
 * calls the integration's tools. Every saved source task (a frozen
 * `knowledge_source_sync` action or an agent task carrying
 * `agentConfig.knowledgeSource`) fails closed with one of these reasons.
 * Imported documents, Knowledge entries and run history stay readable.
 */
export const KNOWLEDGE_SOURCE_SYNC_RETIRED_REASON = "knowledge_source_sync_retired" as const;
export const KNOWLEDGE_SOURCE_SYNC_RETIRED_MESSAGE =
  "Integration Knowledge sync has been retired. Integrations give agents tools; create an ordinary agent schedule that uses them for recurring work. Imported documents and run history remain.";

/** Provider-specific reasons are kept for sources whose native connection was retired first. */
export const KNOWLEDGE_SOURCE_SYNC_RETIREMENT_REASONS = [
  KNOWLEDGE_SOURCE_SYNC_RETIRED_REASON,
  GOOGLE_DRIVE_NATIVE_RETIRED_REASON,
  ATLASSIAN_NATIVE_RETIRED_REASON,
] as const;
export type KnowledgeSourceSyncRetirementReason =
  (typeof KNOWLEDGE_SOURCE_SYNC_RETIREMENT_REASONS)[number];

export type KnowledgeSourceSyncRetirement = {
  reason: KnowledgeSourceSyncRetirementReason;
  message: string;
};

const RETIREMENT_MESSAGES: Record<KnowledgeSourceSyncRetirementReason, string> = {
  [KNOWLEDGE_SOURCE_SYNC_RETIRED_REASON]: KNOWLEDGE_SOURCE_SYNC_RETIRED_MESSAGE,
  [GOOGLE_DRIVE_NATIVE_RETIRED_REASON]: GOOGLE_DRIVE_NATIVE_RETIRED_MESSAGE,
  // The Atlassian connection copy is shared with OAuth errors; a saved task
  // also needs to say its imported data stays.
  [ATLASSIAN_NATIVE_RETIRED_REASON]: `${ATLASSIAN_NATIVE_RETIRED_MESSAGE} Imported documents and run history remain.`,
};

export function isKnowledgeSourceSyncRetirementReason(
  value: unknown,
): value is KnowledgeSourceSyncRetirementReason {
  return (KNOWLEDGE_SOURCE_SYNC_RETIREMENT_REASONS as readonly unknown[]).includes(value);
}

/** Copy for a persisted run error, or null when the error is not a retirement. */
export function knowledgeSourceSyncRetirementMessage(reason: unknown): string | null {
  return isKnowledgeSourceSyncRetirementReason(reason) ? RETIREMENT_MESSAGES[reason] : null;
}

/** Every source is retired; the provider only selects the most helpful copy. */
export function knowledgeSourceSyncRetirement(source: unknown): KnowledgeSourceSyncRetirement {
  const reason = isRetiredNativeGoogleDriveSource(source)
    ? GOOGLE_DRIVE_NATIVE_RETIRED_REASON
    : isRetiredNativeAtlassianSource(source)
      ? ATLASSIAN_NATIVE_RETIRED_REASON
      : KNOWLEDGE_SOURCE_SYNC_RETIRED_REASON;
  return { reason, message: RETIREMENT_MESSAGES[reason] };
}

/**
 * Matches frozen historical source actions and source-bound agent tasks
 * without changing their stored bytes. Returns null for ordinary tasks.
 */
export function retiredKnowledgeSourceSyncTask(task: {
  agentConfig?: { knowledgeSource?: unknown } | null;
  action?: { kind?: unknown } | null;
}): KnowledgeSourceSyncRetirement | null {
  if (task.action?.kind === "knowledge_source_sync")
    return knowledgeSourceSyncRetirement(task.action);
  const source = task.agentConfig?.knowledgeSource;
  return source ? knowledgeSourceSyncRetirement(source) : null;
}

export function isRetiredKnowledgeSourceSyncTask(
  task: Parameters<typeof retiredKnowledgeSourceSyncTask>[0],
): boolean {
  return retiredKnowledgeSourceSyncTask(task) !== null;
}
