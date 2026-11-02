/**
 * Inline image tags: an opt-in composer mode in which each attached image gets
 * a numbered tag, `[Image 1]`, placed in the text where the person was
 * writing when they added it. The tags are ordinary text, so the message keeps
 * the same shape and API; image N is the Nth image attached, which is also the
 * order the images reach the agent. People can move a tag or write around it
 * to say which comment goes with which image.
 */

const TAG = /\[Image (\d+)\]/g;

export function imageMarker(number: number): string {
  return `[Image ${number}]`;
}

export type ImageMarkerEdit = { text: string; caret: number };

/**
 * Brings the tags in `text` in line with a new list of attached images.
 * Tags of removed images are deleted (with one space beside them), the rest
 * are renumbered to their image's new position, and new images get a tag at
 * `caret`. Tags that match no image (typed by hand) stay as written. Returns
 * null when nothing changes.
 */
export function reconcileImageMarkers(
  text: string,
  previous: readonly string[],
  next: readonly string[],
  caret: number,
): ImageMarkerEdit | null {
  const nextNumber = new Map(next.map((id, index) => [id, index + 1]));
  const added = next.filter((id) => !previous.includes(id));
  const changedOrder = previous.some((id, index) => nextNumber.get(id) !== index + 1);
  if (!added.length && !changedOrder) return null;

  let position = Math.max(0, Math.min(caret, text.length));
  let result = "";
  let last = 0;
  for (const match of text.matchAll(TAG)) {
    const start = match.index;
    const end = start + match[0].length;
    const id = previous[Number(match[1]) - 1];
    if (id === undefined) continue;
    const number = nextNumber.get(id);
    let cutStart = start;
    let cutEnd = end;
    let replacement = number === undefined ? "" : imageMarker(number);
    if (number === undefined) {
      // Take one neighbouring space with the tag, so no double space is left.
      if (text[cutEnd] === " ") cutEnd += 1;
      else if (start > last && text[start - 1] === " ") cutStart -= 1;
    }
    result += text.slice(last, cutStart) + replacement;
    if (position >= cutEnd) position += replacement.length - (cutEnd - cutStart);
    else if (position > cutStart) position = cutStart + replacement.length;
    last = cutEnd;
  }
  result += text.slice(last);

  if (added.length) {
    // A restored draft brings its images back after its text, tags included.
    const missing = added
      .map((id) => imageMarker(nextNumber.get(id)!))
      .filter((tag) => !result.includes(tag));
    if (!missing.length) return result === text ? null : { text: result, caret: position };
    const tags = missing.join(" ");
    const before = result.slice(0, position);
    const after = result.slice(position);
    const lead = before.length && !/\s$/.test(before) ? " " : "";
    const trail = !/^\s/.test(after) ? " " : "";
    result = before + lead + tags + trail + after;
    position = before.length + lead.length + tags.length + trail.length;
  }
  return result === text ? null : { text: result, caret: position };
}
