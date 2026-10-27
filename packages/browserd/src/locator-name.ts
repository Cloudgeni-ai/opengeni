/**
 * Whether an accessible name contains a locator's name as whole words,
 * ignoring case and spacing: "Save" finds "Save as draft" and "plain
 * language" finds "Ask in plain language", but "OK" does not find
 * "workbook" and "Add" does not find "Address". Scripts written without
 * spaces between words (Chinese, Japanese, Thai and the like) have no word
 * edges to check, so there any part of the name matches.
 */
export function nameContainsWords(name: string | null | undefined, requested: string): boolean {
  if (name == null) return false;
  const haystack = normalizeName(name);
  const needle = normalizeName(requested);
  if (needle === "") return true;
  const first = firstCharacter(needle);
  const last = lastCharacter(needle);
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    if (
      !(
        isSpacedWordCharacter(first) && isSpacedWordCharacter(lastCharacter(haystack.slice(0, at)))
      ) &&
      !(isSpacedWordCharacter(last) && isSpacedWordCharacter(firstCharacter(haystack.slice(end))))
    )
      return true;
  }
  return false;
}

function normalizeName(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function firstCharacter(value: string): string {
  return value === "" ? "" : String.fromCodePoint(value.codePointAt(0)!);
}

function lastCharacter(value: string): string {
  return Array.from(value.slice(-2)).at(-1) ?? "";
}

/** A letter or digit of a script that puts spaces between its words. */
function isSpacedWordCharacter(character: string): boolean {
  return (
    /^[\p{L}\p{M}\p{N}]$/u.test(character) &&
    !/^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]$/u.test(
      character,
    )
  );
}
