import { prepareMathMarkdown } from "@opengeni/react/markdown-math";

// About 1,300 words: ordinary replies keep formatting; long reports/logs must
// not make synchronous Markdown, math or preview parsing grow without bound.
export const MAX_MARKDOWN_LENGTH = 8_192;

export function prepareBoundedMarkdown(text: string) {
  if (text.length > MAX_MARKDOWN_LENGTH) return null;
  const prepared = prepareMathMarkdown(text);
  // Math delimiter normalization can expand otherwise in-budget input.
  return prepared.text.length <= MAX_MARKDOWN_LENGTH ? prepared : null;
}

// Leave one code unit of headroom to keep surrogate pairs together without
// scanning/splitting the entire message or exceeding the per-page bound.
const PAGE_LENGTH = MAX_MARKDOWN_LENGTH - 1;

export function plainTextPage(text: string, requestedPage: number) {
  const count = Math.max(1, Math.ceil(text.length / PAGE_LENGTH));
  const index = Math.max(0, Math.min(requestedPage, count - 1));
  const boundary = (offset: number) => {
    const before = text.charCodeAt(offset - 1);
    const after = text.charCodeAt(offset);
    return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
      ? offset - 1
      : offset;
  };
  return {
    index,
    count,
    text: text.slice(boundary(index * PAGE_LENGTH), boundary((index + 1) * PAGE_LENGTH)),
  };
}
