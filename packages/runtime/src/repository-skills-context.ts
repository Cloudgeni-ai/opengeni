import type { AgentInputItem, CallModelInputFilter } from "@openai/agents";
import { latestRepositorySkillsIndex, repositorySkillsContextItem } from "@opengeni/contracts";
import type { RepositorySkillsIndex } from "./workspace-skills";

/**
 * Stores the run's index durably as a Repository skills history item placed
 * before the turn's first history item, and returns the index the model
 * reads from now on (the turn's frozen snapshot on a retry), or null when it
 * reads none.
 */
export type PublishRepositorySkills = (index: RepositorySkillsIndex) => Promise<string | null>;

/** What one agent's runs show: set once discovery has published the index. */
export type RepositorySkillsContextState = { visible: string | null };

/**
 * Show the published index where later turns will load it from: before the
 * turn's first item of the run input (`turnStartIndex`). Discovery runs inside
 * the run, after its input was assembled, so the durable item is not in that
 * input yet. Placing it anywhere else would make this run's requests differ
 * from the history the next turn sends, which breaks prompt caching and the
 * provider's binding of this run's reasoning to its request prefix.
 *
 * `render` gives the item the form the caller's projection gives stored
 * history items, so it is the same item later turns load.
 *
 * Nothing is added when the input already shows the same index (a retry that
 * loaded it, or an unchanged index), or when the input was rewritten so the
 * turn start is no longer known.
 */
export function repositorySkillsContextInputFilter(
  state: RepositorySkillsContextState,
  original: unknown,
  turnStartIndex: number | undefined,
  render: (index: string) => AgentInputItem = (index) =>
    repositorySkillsContextItem(index) as AgentInputItem,
): CallModelInputFilter | undefined {
  if (
    !Array.isArray(original) ||
    turnStartIndex === undefined ||
    !Number.isSafeInteger(turnStartIndex) ||
    turnStartIndex < 0 ||
    turnStartIndex > original.length
  )
    return undefined;
  const before: unknown = turnStartIndex > 0 ? original[turnStartIndex - 1] : undefined;
  const at: unknown = original[turnStartIndex];
  return ({ modelData }) => {
    const visible = state.visible;
    if (visible === null) return modelData;
    const input = modelData.input;
    // The SDK passes the run's original items through by identity (external
    // history ownership); any other input was rewritten.
    if (
      input.length < turnStartIndex ||
      (turnStartIndex > 0 && input[turnStartIndex - 1] !== before) ||
      (at !== undefined && input[turnStartIndex] !== at)
    )
      return modelData;
    if (latestRepositorySkillsIndex(input) === visible) return modelData;
    return {
      ...modelData,
      input: [...input.slice(0, turnStartIndex), render(visible), ...input.slice(turnStartIndex)],
    };
  };
}
