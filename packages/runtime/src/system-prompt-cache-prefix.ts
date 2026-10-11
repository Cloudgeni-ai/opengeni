/**
 * Experiment OPENGENI_EXPERIMENT_SYSTEM_PROMPT_CACHE_SPLIT.
 *
 * Instruction composition records the leading part of the system prompt that
 * holds no workspace-, session- or turn-specific text. The Anthropic Messages
 * transport ends a separate system block (and a cache breakpoint) after it, so
 * a cold session reuses that prefix written by any other session instead of
 * only the tools block.
 *
 * The record is content-addressed: a prefix is used only where the sent
 * instructions contain it byte for byte, and splitting one text block into two
 * adjacent blocks preserves the text. A stale or unrelated entry can therefore
 * cost at most a cache miss; it never changes what the model reads. Nothing is
 * recorded while the experiment is off.
 */
const MAX_RECORDED_PREFIXES = 32;
/** Shorter prefixes are not worth a breakpoint (Anthropic's minimum is 1,024+ tokens). */
const MIN_PREFIX_CHARS = 2_048;

const recorded = new Map<string, true>();

export function recordStableSystemPromptPrefix(prefix: string | undefined): void {
  if (!prefix || prefix.length < MIN_PREFIX_CHARS) return;
  recorded.delete(prefix);
  recorded.set(prefix, true);
  while (recorded.size > MAX_RECORDED_PREFIXES) {
    recorded.delete(recorded.keys().next().value!);
  }
}

/**
 * Splits `instructions` after the furthest-ending recorded stable prefix it
 * contains. The prefix may follow a deterministic SDK preamble (the sandbox
 * agent wraps our instructions under "# Agent instructions"). Returns
 * undefined when nothing matches or nothing would follow the prefix.
 */
export function splitStableSystemPromptPrefix(
  instructions: string,
): [stable: string, tail: string] | undefined {
  let end = 0;
  for (const prefix of recorded.keys()) {
    const at = instructions.indexOf(prefix);
    if (at >= 0 && at + prefix.length > end) end = at + prefix.length;
  }
  if (end === 0 || end >= instructions.length) return undefined;
  return [instructions.slice(0, end), instructions.slice(end)];
}

/** Test isolation only. */
export function clearStableSystemPromptPrefixes(): void {
  recorded.clear();
}
