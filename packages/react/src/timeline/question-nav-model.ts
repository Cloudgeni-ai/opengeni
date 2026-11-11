/**
 * "Back to your message": which prompt the reader is reading the answer to, and
 * whether that prompt has scrolled out of view. Renderer-neutral geometry so
 * the web timeline (DOM rects) and native timelines (layout offsets) agree.
 */

/** How far above the viewport a prompt must be before the pill appears. */
export const QUESTION_NAV_HIDDEN_PX = 24;
/** Breathing room above the question when the reader jumps back to it. */
export const QUESTION_NAV_MARGIN_PX = 12;

export type QuestionNavPrompt = { key: string; top: number; bottom: number };

/**
 * The last prompt before the reading position (the viewport's middle) owns the
 * response in view; it is a target only once it has scrolled fully above the
 * viewport. Prompts are in document order; coordinates share one axis.
 */
export function questionNavTarget(
  prompts: readonly QuestionNavPrompt[],
  view: { top: number; height: number },
): string | null {
  const middle = view.top + view.height / 2;
  const prompt = [...prompts].reverse().find((candidate) => candidate.top <= middle);
  if (!prompt) return null;
  if (prompt.top >= view.top - QUESTION_NAV_HIDDEN_PX || prompt.bottom > view.top) return null;
  return prompt.key;
}
