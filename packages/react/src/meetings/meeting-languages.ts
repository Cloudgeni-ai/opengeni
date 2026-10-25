/**
 * The languages offered wherever a meeting's language is picked: the
 * recorder, Meetings settings and "Transcribe again". "auto" detects it.
 */
import { createOpenGeniText, type OpenGeniText } from "../messages/runtime";
import { languageName } from "../recordings";
import type { SelectOption } from "../ui/select-menu";

const defaultText = createOpenGeniText();

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
  detectLabel: string | undefined = undefined,
  msg: OpenGeniText = defaultText,
): SelectOption[] {
  const codes: string[] = [...MEETING_LANGUAGES];
  if (current && current !== DETECT_LANGUAGE && !codes.includes(current)) codes.push(current);
  return [
    { value: DETECT_LANGUAGE, label: detectLabel ?? msg("meetings.languages.detectAutomatically") },
    ...codes.map((code) => ({ value: code, label: languageName(code, msg.locale) })),
  ];
}
