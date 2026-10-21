/**
 * Ranks short labels (chat titles, action names) against what someone typed.
 *
 * Higher is better; `null` means no match. Tiers, best first:
 * whole label starts with the query, a word starts with it, it appears
 * anywhere, every query word appears in some order, and finally the query's
 * letters appear in order ("kbsh" → "Keyboard shortcuts"). Within a tier,
 * shorter labels and earlier positions win.
 */

const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Case- and accent-insensitive form used for matching. */
export function foldForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function wordStarts(label: string): number[] {
  const starts: number[] = [];
  for (let index = 0; index < label.length; index++) {
    const previous = index === 0 ? " " : label[index - 1]!;
    const current = label[index]!;
    if (/[\p{L}\p{N}]/u.test(current) && !/[\p{L}\p{N}]/u.test(previous)) starts.push(index);
  }
  return starts;
}

function subsequenceScore(label: string, query: string): number | null {
  // Letters in order; consecutive letters and letters at word starts are worth more.
  const starts = new Set(wordStarts(label));
  let position = 0;
  let score = 0;
  let previous = -2;
  for (const character of query) {
    if (character === " ") continue;
    const found = label.indexOf(character, position);
    if (found < 0) return null;
    score += found === previous + 1 ? 3 : starts.has(found) ? 2 : 0;
    previous = found;
    position = found + 1;
  }
  return score;
}

export function rankLabel(rawLabel: string, rawQuery: string): number | null {
  const query = foldForSearch(rawQuery);
  if (!query) return 0;
  const label = foldForSearch(rawLabel);
  if (!label) return null;
  const lengthPenalty = Math.min(label.length, 200) / 1000;
  if (label === query) return 1000;
  if (label.startsWith(query)) return 900 - lengthPenalty;
  const at = label.indexOf(query);
  if (at >= 0) {
    const starts = wordStarts(label);
    if (starts.includes(at)) return 800 - at / 100 - lengthPenalty;
    return 600 - at / 100 - lengthPenalty;
  }
  const words = query.split(" ").filter(Boolean);
  if (words.length > 1 && words.every((word) => label.includes(word))) {
    const starts = wordStarts(label);
    const wordStartHits = words.filter((word) =>
      starts.some((start) => label.startsWith(word, start)),
    ).length;
    return 500 + (wordStartHits / words.length) * 50 - lengthPenalty;
  }
  if (query.replace(/ /g, "").length < 2) return null;
  const subsequence = subsequenceScore(label, query);
  if (subsequence === null) return null;
  // Only keep loose matches that hit word starts or runs; random letters scattered
  // across a long title are noise.
  const letters = query.replace(/ /g, "").length;
  if (subsequence < letters) return null;
  return 100 + Math.min(subsequence, 200) - lengthPenalty * 10;
}

/** The best rank across a label and extra keywords (a keyword match ranks below the same match on the name). */
export function rankWithKeywords(
  label: string,
  keywords: readonly string[] | undefined,
  query: string,
): number | null {
  let best = rankLabel(label, query);
  for (const keyword of keywords ?? []) {
    const rank = rankLabel(keyword, query);
    if (rank !== null) {
      const discounted = rank - 150;
      if (best === null || discounted > best) best = discounted;
    }
  }
  return best;
}
