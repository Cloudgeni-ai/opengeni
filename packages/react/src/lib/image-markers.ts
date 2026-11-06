/**
 * Inline image tags: an opt-in composer mode in which each image added to a
 * message gets a numbered tag, `[Image 1]`, placed in the text where the
 * person was writing when they added it. The tags are ordinary text, so the
 * message keeps the same shape and API; image N is the Nth image the message
 * carries, which is also the order the images reach the agent. People can
 * move a tag or write around it to say which comment goes with which image.
 */

const TAG = /\[Image (\d+)\]/g;

export function imageMarker(number: number): string {
  return `[Image ${number}]`;
}

export type ImageMarkerEdit = { text: string; caret: number };

export type ImageMarkerChange = {
  text: string;
  /** The message's images before the change, in send order. */
  previous: readonly string[];
  /** The message's images after the change, in send order. */
  next: readonly string[];
  /**
   * Images in `next` the person just added, which get a new tag at `caret`.
   * Images that came back with a restored draft are not listed: their tags
   * are already in the restored text.
   */
  insert: readonly string[];
  caret: number;
};

/**
 * Brings the tags in `text` in line with a new list of images. A tag names
 * the image at its number in `previous`: tags of removed images are deleted
 * (with one space beside them), the rest are renumbered to their image's new
 * position, and each image in `insert` gets a tag at `caret`, in image order.
 * Tags whose number matches no image (typed by hand) stay as written. Returns
 * null when the text does not change.
 */
export function reconcileImageMarkers({
  text,
  previous,
  next,
  insert,
  caret,
}: ImageMarkerChange): ImageMarkerEdit | null {
  const nextNumber = new Map(next.map((id, index) => [id, index + 1]));
  const inserted = new Set(insert.filter((id) => nextNumber.has(id)));
  const changedOrder =
    previous.length !== next.length || previous.some((id, index) => next[index] !== id);
  if (!inserted.size && !changedOrder) return null;

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
    const replacement = number === undefined ? "" : imageMarker(number);
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

  if (inserted.size) {
    const tags = next
      .filter((id) => inserted.has(id))
      .map((id) => imageMarker(nextNumber.get(id)!))
      .join(" ");
    const before = result.slice(0, position);
    const after = result.slice(position);
    // Keep the tag a word of its own without doubling the spacing around it.
    const lead = before.length && !/\s$/.test(before) ? " " : "";
    const trail = !/^\s/.test(after) ? " " : "";
    result = before + lead + tags + trail + after;
    position = before.length + lead.length + tags.length + trail.length;
  }
  return result === text ? null : { text: result, caret: position };
}

/**
 * The images a message carries, in the order they reach the agent: files
 * restored with a draft first, then the attachments added since. An
 * attachment that is also a restored file is sent once, in its restored place.
 */
export function messageImageIds(
  restoredImageFileIds: readonly string[],
  attachments: readonly { id: string; contentType: string; file?: { id: string } | undefined }[],
): string[] {
  const restored = new Set(restoredImageFileIds);
  return [
    ...restoredImageFileIds.map(restoredImageKey),
    ...attachments
      .filter(
        (attachment) =>
          attachment.contentType.startsWith("image/") &&
          !(attachment.file && restored.has(attachment.file.id)),
      )
      .map((attachment) => attachment.id),
  ];
}

/** The image id of a file restored with a draft (not an attachment id). */
export function restoredImageKey(fileId: string): string {
  return `restored-file:${fileId}`;
}
