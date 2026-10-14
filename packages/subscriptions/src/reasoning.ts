import type { ModelDescriptor } from "./types";

/**
 * Map a requested reasoning level onto a target model (SUB-FAIL-03, D-16).
 *
 * A level the target supports by name is kept. Otherwise the level's relative
 * position on the source model's ladder (lowest 0, highest 1) is mapped to the
 * nearest relative position on the target's ladder, an exact tie going to the
 * lower level. A level the source ladder does not list has no position and
 * maps to the middle of the target's ladder (the lower middle of two).
 */
export function mapReasoningLevel(
  requested: string,
  source: Pick<ModelDescriptor, "reasoningLevels"> | undefined,
  target: Pick<ModelDescriptor, "reasoningLevels">,
): string {
  const levels = target.reasoningLevels;
  if (levels.includes(requested)) return requested;
  if (levels.length <= 1) return levels[0] ?? "";
  const sourceLevels = source?.reasoningLevels ?? [];
  const position = sourceLevels.indexOf(requested);
  // The requested position as an exact fraction numerator / denominator.
  const [numerator, denominator] =
    position < 0 || sourceLevels.length <= 1 ? [1, 2] : [position, sourceLevels.length - 1];
  // round(numerator / denominator * (L - 1)) with ties down, in integers.
  const scaled = numerator * (levels.length - 1);
  const index = Math.floor((2 * scaled + denominator - 1) / (2 * denominator));
  return levels[Math.min(index, levels.length - 1)]!;
}
