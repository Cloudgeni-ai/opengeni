/**
 * The languages offered wherever a meeting's language is picked: the
 * recorder, Meetings settings and "Transcribe again". "auto" detects it.
 */
import { languageName } from "../recordings";
import type { SelectOption } from "../ui/select-menu";

export const DETECT_LANGUAGE = "auto";

export const MEETING_LANGUAGES = [
  "en",
  "no",
  "sv",
  "da",
  "de",
  "fr",
  "es",
  "nl",
  "fi",
  "it",
  "pt",
  "pl",
] as const;

/** "Detect automatically" first, then the common languages, plus `current` if it's another one. */
export function meetingLanguageOptions(
  current: string | null | undefined,
  detectLabel = "Detect automatically",
): SelectOption[] {
  const codes: string[] = [...MEETING_LANGUAGES];
  if (current && current !== DETECT_LANGUAGE && !codes.includes(current)) codes.push(current);
  return [
    { value: DETECT_LANGUAGE, label: detectLabel },
    ...codes.map((code) => ({ value: code, label: languageName(code) })),
  ];
}
