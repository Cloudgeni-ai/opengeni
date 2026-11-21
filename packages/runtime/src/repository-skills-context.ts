import type { AgentInputItem, CallModelInputFilter } from "@openai/agents";
import {
  hasStartingContext,
  latestRepositorySkillsIndex,
  repositorySkillsContextItem,
  startingContextItem,
} from "@opengeni/contracts";
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
export type RepositorySkillsContextState = {
  visible: string | null;
  /** The starting context the run published (see `starting-context.ts`). */
  starting?: string | null;
  /** The order the run's items were published in, which is how they are stored. */
  order?: ("repository" | "starting")[];
};

/**
 * The durable history as later turns will load it once the run's published
 * context items are stored: each item, in publication order, sits before the
 * turn's first row at the time it was stored (so a later item comes first).
 */
export type HistoryWithSessionContext = (
  items: readonly Record<string, unknown>[],
) => Promise<readonly AgentInputItem[] | null>;

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
  withContext?: HistoryWithSessionContext,
): CallModelInputFilter | undefined {
  if (
    (!withIndex && !withContext) ||
    !Array.isArray(original) ||
    !Number.isSafeInteger(historyLength) ||
    historyLength < 0 ||
    historyLength > original.length
  )
    return undefined;
  const prefix: readonly unknown[] = original.slice(0, historyLength);
  let built: { key: string; items: Promise<readonly AgentInputItem[] | null> } | undefined;
  return async ({ modelData }) => {
    const visible = state.visible;
    const starting = state.starting ?? null;
    if (visible === null && starting === null) return modelData;
    const input = modelData.input;
    // The SDK passes the run's original items through by identity (external
    // history ownership); any other input was rewritten.
    if (input.length < historyLength || prefix.some((item, index) => input[index] !== item))
      return modelData;
    const index =
      visible !== null && latestRepositorySkillsIndex(input) !== visible ? visible : null;
    const start = starting !== null && !hasStartingContext(input) ? starting : null;
    if (index === null && start === null) return modelData;
    if (start === null) {
      if (!withIndex) return modelData;
      if (built?.key !== `index:${index}`)
        built = { key: `index:${index}`, items: withIndex(index!) };
    } else {
      if (!withContext) return modelData;
      const order: readonly ("repository" | "starting")[] = state.order?.includes("starting")
        ? state.order
        : [...(state.order ?? ["repository"]), "starting"];
      const items = order.flatMap((kind) =>
        kind === "repository"
          ? index === null
            ? []
            : [repositorySkillsContextItem(index)]
          : [startingContextItem(start)],
      );
      const key = `context:${JSON.stringify(items)}`;
      if (built?.key !== key) built = { key, items: withContext(items) };
    }
    const history = await built.items;
    if (!history) throw new Error("The run's history with its published context is missing");
    return { ...modelData, input: [...history, ...input.slice(historyLength)] };
  };
}
