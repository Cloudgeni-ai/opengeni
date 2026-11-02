import {
  adoptSessionSearchRecordsAsInput,
  sessionSearchRecordsAsInput,
  type Database,
} from "@opengeni/db";
import {
  projectHistoryForProvider,
  searchRecordFormMatters,
  type HistoryProviderApi,
  type SearchRecordForm,
} from "@opengeni/runtime";

/**
 * How this turn's hosted web searches reach the model (docs/web-search.md).
 * One object per turn, read by every model-facing projection of the turn, so
 * compaction, history and the run's own model calls always agree.
 */
export type TurnSearchRecords = { form: SearchRecordForm };

export async function loadTurnSearchRecords(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<TurnSearchRecords> {
  const asInput = await sessionSearchRecordsAsInput(db, workspaceId, sessionId);
  return { form: asInput ? "runtime" : "assistant" };
}

/**
 * Settle the turn's form against the history it sends. A session moves to
 * `runtime` only while that history projects the same in both forms (from its
 * first turn, or after compaction or clearing for an older one), so the move
 * changes no text an earlier request sent. The move is recorded before any
 * request uses it; a session that stays `assistant` decides again next turn.
 */
export async function settleTurnSearchRecords(
  db: Database,
  workspaceId: string,
  sessionId: string,
  records: TurnSearchRecords,
  history: readonly unknown[],
): Promise<SearchRecordForm> {
  if (records.form === "runtime" || searchRecordFormMatters(history)) return records.form;
  await adoptSessionSearchRecordsAsInput(db, workspaceId, sessionId);
  records.form = "runtime";
  return records.form;
}

/**
 * The turn's provider projection of history, in the form the turn holds when
 * it is called. Turn input and compaction both use it, so compaction's
 * request shares the turn's cached prefix and its summarizer sees what the
 * model saw.
 */
export function projectTurnHistoryForProvider(
  items: Array<Record<string, unknown>>,
  providerApi: HistoryProviderApi,
  records: TurnSearchRecords,
): Array<Record<string, unknown>> {
  return projectHistoryForProvider(items, providerApi, { searchRecordForm: records.form });
}
