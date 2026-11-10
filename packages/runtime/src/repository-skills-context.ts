import type { AgentInputItem, CallModelInputFilter } from "@openai/agents";
import { latestRepositorySkillsIndex } from "@opengeni/contracts";
import type { RepositorySkillsIndex } from "./workspace-skills";

/**
 * Stores the run's index durably as a Repository skills history item placed
 * before the turn's first history item, and returns the index the model
 * reads from now on (the turn's frozen snapshot on a retry), or null when it
 * reads none. Null (a deferred run) stores nothing and keeps what the model
 * already reads for the rest of the turn, so a later indexed attempt of the
 * same turn cannot add an item between its requests.
 */
export type PublishRepositorySkills = (
  index: RepositorySkillsIndex | null,
) => Promise<string | null>;

/** What one agent's runs show: set once discovery has published the index. */
export type RepositorySkillsContextState = { visible: string | null };

/**
 * The durable history of the run input as later turns will load it once the
 * index is stored: the same rows, projected the same way, with the Repository
 * skills item before this turn's first row. Null when it cannot be built.
 */
export type HistoryWithRepositorySkills = (
  index: string,
) => Promise<readonly AgentInputItem[] | null>;

/**
 * Show the published index where later turns will load it from. Discovery
 * runs inside the run, after its input was assembled, so the durable item is
 * not in that input yet. The run's durable history prefix (its first
 * `historyLength` items) is replaced by `withIndex`, the same history as later
 * turns load it; anything else would make this run's requests differ from the
 * history the next turn sends, which breaks prompt caching and the provider's
 * binding of this run's reasoning to its request prefix.
 *
 * Nothing changes when the input already shows the same index (a retry that
 * loaded it, or an unchanged index), or when the prefix was rewritten (for
 * example by compaction during the run). A failure to build the history fails
 * the request: the index is already stored, so going on without it would make
 * this turn's requests differ from what later turns load, and a retry loads it.
 */
export function repositorySkillsContextInputFilter(
  state: RepositorySkillsContextState,
  original: unknown,
  historyLength: number,
  withIndex: HistoryWithRepositorySkills | undefined,
): CallModelInputFilter | undefined {
  if (
    !withIndex ||
    !Array.isArray(original) ||
    !Number.isSafeInteger(historyLength) ||
    historyLength < 0 ||
    historyLength > original.length
  )
    return undefined;
  const prefix: readonly unknown[] = original.slice(0, historyLength);
  let built: { index: string; items: Promise<readonly AgentInputItem[] | null> } | undefined;
  return async ({ modelData }) => {
    const visible = state.visible;
    if (visible === null) return modelData;
    const input = modelData.input;
    // The SDK passes the run's original items through by identity (external
    // history ownership); any other input was rewritten.
    if (input.length < historyLength || prefix.some((item, index) => input[index] !== item))
      return modelData;
    if (latestRepositorySkillsIndex(input) === visible) return modelData;
    if (built?.index !== visible) built = { index: visible, items: withIndex(visible) };
    const history = await built.items;
    if (!history) return modelData;
    return { ...modelData, input: [...history, ...input.slice(historyLength)] };
  };
}
