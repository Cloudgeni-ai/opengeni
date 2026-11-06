/**
 * Hide internal IDs (UUIDs) in text shown to people without leaving broken
 * text behind. An ID is dropped with what only named it: its label
 * ("Organisation: <id>", "Worker session id: <id>", "id=<id>") or a
 * parenthetical that held only it ("(run <id>)"). The punctuation and
 * spacing around the removed fragment are then tidied, so "Set up.
 * Organisation: <id>." reads "Set up." and never "Set up. Organisation:.".
 *
 * Text without an ID is returned unchanged, character for character.
 */
export function withoutInternalIds(text: string): string {
  if (!ANY_ID.test(text)) return text;
  return text
    .split("\n")
    .flatMap((line) => {
      const redacted = redactLine(line);
      return redacted === null ? [] : [redacted];
    })
    .join("\n")
    .trim();
}

const ID = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;
const QUOTED_ID = String.raw`["'\x60]?${ID}["'\x60]?`;
/** One word of a label: letters or digits, then those, apostrophes, _ or -. */
const WORD = String.raw`[\p{L}\p{N}][\p{L}\p{N}_'’-]*`;

const ANY_ID = new RegExp(ID, "iu");
/** "(<id>)", "(run <id>)", "[id: <id>]": a bracket that held only the ID. */
const BRACKETED = new RegExp(
  String.raw`[ \t]*[(\[][ \t]*(?:${WORD}[ \t]*[:=]?[ \t]*){0,2}${QUOTED_ID}[ \t]*[)\]]`,
  "giu",
);
/**
 * A label that starts a clause (at the start or after ". ", "; ", ", " or
 * "· ") and names the ID: two words ("Assigned to: <id>"), or up to four
 * that end in an ID word ("Worker session id: <id>"). A longer clause keeps
 * its words and loses only the last one with the ID.
 */
const CLAUSE_START = String.raw`(^|[.;!?·|,])([ \t]*)`;
const ID_WORD = String.raw`(?:id|ids|identifier|uuid|key|ref|reference)`;
const LABELLED_ID_CLAUSE = new RegExp(
  String.raw`${CLAUSE_START}(?:${WORD}[ \t]+){0,3}${ID_WORD}[ \t]*[:=][ \t]*${QUOTED_ID}`,
  "giu",
);
const LABELLED_CLAUSE = new RegExp(
  String.raw`${CLAUSE_START}(?:${WORD}[ \t]+)?${WORD}[ \t]*[:=][ \t]*${QUOTED_ID}`,
  "giu",
);
/** A one-word label anywhere else: "… for Organisation: <id>". */
const LABELLED = new RegExp(String.raw`[ \t]*${WORD}[ \t]*[:=][ \t]*${QUOTED_ID}`, "giu");
const BARE = new RegExp(String.raw`[ \t]*${QUOTED_ID}`, "giu");

/** The line without its IDs, or null when it said nothing but them. */
function redactLine(line: string): string | null {
  if (!ANY_ID.test(line)) return line;
  const indent = /^[ \t]*/u.exec(line)![0];
  const tidied = line
    .replace(BRACKETED, "")
    .replace(LABELLED_ID_CLAUSE, (_match, boundary: string) => boundary)
    .replace(LABELLED_CLAUSE, (_match, boundary: string) => boundary)
    .replace(LABELLED, "")
    .replace(BARE, "")
    // Separators left next to each other by a removal: keep one, preferring
    // the sentence end ("Done, ." → "Done.", "Done.." → "Done.").
    .replace(/[ \t]*[,;:·|](?:[ \t]*[,;:·|])*[ \t]*(?=[.!?)\]])/gu, "")
    .replace(/([.!?])(?:[ \t]*[.,;:·|])+/gu, "$1")
    .replace(/([,;:·|])(?:[ \t]*[,;:·|])+/gu, "$1")
    .replace(/[ \t]+([.,;:!?)\]])/gu, "$1")
    .replace(/([([])[ \t]+/gu, "$1")
    .replace(/[([][ \t]*[)\]]/gu, "")
    // A separator left at either end joined the ID to nothing.
    .replace(/^[ \t]*[.,;:·|]+[ \t]*/u, "")
    .replace(/[ \t]*(?:[,;·|]|[ \t][–—-])+[ \t]*$/u, "")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
  // A line left as punctuation alone said nothing but the ID.
  if (!/[\p{L}\p{N}]/u.test(tidied)) return null;
  return `${indent}${tidied}`;
}
