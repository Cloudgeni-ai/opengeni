/** Lines the composer field shows before it scrolls, room allowing. */
export const COMPOSER_FIELD_LINES = 6;
/** Lines it always shows before it scrolls, however little room there is. */
export const COMPOSER_FIELD_MIN_LINES = 4;

/**
 * How tall the composer's text field may be.
 *
 * With text in it, the field sizes itself from its content and scrolls only
 * once it reaches `maxHeight`: up to {@link COMPOSER_FIELD_LINES} lines, fewer
 * when they would take more than a quarter of the screen, never fewer than
 * {@link COMPOSER_FIELD_MIN_LINES}. An empty field is pinned to one line, so a
 * long placeholder can't make it taller and a cleared field (after Send)
 * shrinks back.
 *
 * The field never sets its own height from `onContentSizeChange`: on the new
 * architecture iOS reports a content size only when the field's layout
 * changes, so a fixed height never learned that the text grew and the field
 * stayed one line tall while earlier lines scrolled out of view.
 */
export function composerFieldSize(input: {
  /** One line at the person's text size. */
  line: number;
  /** Vertical padding inside the field. */
  padding: number;
  /** The smallest height the field's layout allows. */
  minHeight: number;
  hasText: boolean;
  windowHeight: number;
}): { height?: number; minHeight: number; maxHeight: number } {
  const { line, padding, minHeight, hasText, windowHeight } = input;
  const lines = Math.max(
    COMPOSER_FIELD_MIN_LINES,
    Math.min(COMPOSER_FIELD_LINES, Math.floor((windowHeight / 4 - padding) / line)),
  );
  const maxHeight = padding + lines * line;
  const oneLine = Math.max(minHeight, padding + line);
  return hasText ? { minHeight: oneLine, maxHeight } : { height: oneLine, minHeight, maxHeight };
}
