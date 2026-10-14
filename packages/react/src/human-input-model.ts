import type {
  GeneratePasswordSpec,
  HumanInputAnswer,
  HumanInputQuestion,
  HumanInputSecretAnswer,
  HumanInputSecretAnswerResult,
  HumanInputSecretSaveTo,
  HumanInputSecretSpec,
} from "@opengeni/sdk";

/* Pure drafting and validation rules for structured human-input requests,
   shared by the web HumanInputForm and non-DOM renderers. */

export type HumanInputAnswerDraft = {
  values: string[];
  other: string;
  otherSelected: boolean;
};

export type HumanInputFormMessages = {
  title: string;
  description: string;
  submit: string;
  skip: string;
  submitting: string;
  other: string;
  deadlineLabel: string;
  formatDeadline: (value: string) => string;
  required: string;
  otherRequired: string;
  minSelections: (count: number) => string;
  maxSelections: (count: number) => string;
  optional: string;
  /** Shown when the question list overflows the card and more content is below. */
  moreBelow: string;
  questionCount: (count: number) => string;
  collapse: string;
  expand: string;
  selectionHint: (min: number | null | undefined, max: number | null | undefined) => string | null;
  /** Secret questions (`kind: "secret"`). */
  secretShow: string;
  secretHide: string;
  secretGenerate: string;
  /** Shown in place of the input when the server will generate the value. */
  secretWillGenerate: string;
  secretUndo: string;
  secretSaveTo: string;
  secretSaveToOptions: Record<HumanInputSecretSaveTo, string>;
  /** One line under Save to: where the value goes. `vault` is the agent's named vault, if any. */
  secretVaultHint: (saveTo: HumanInputSecretSaveTo, vault: string | null) => string;
  /** The requested Save to is not allowed for this person. */
  secretSaveToDowngraded: (
    requested: HumanInputSecretSaveTo,
    actual: HumanInputSecretSaveTo,
  ) => string;
  secretLooksLike: (example: string) => string;
  /** Soft warning only: the value does not match the agent's pattern. */
  secretPatternWarning: (looksLike: string | null) => string;
  /** The answered chip: "Saved to Private › GitHub". */
  secretSaved: (vaultName: string, itemName: string) => string;
};

const SAVE_TO_IN_SENTENCE: Record<HumanInputSecretSaveTo, string> = {
  user: "Only me",
  task: "this task",
  workspace: "this workspace",
};

export const defaultHumanInputFormMessages: HumanInputFormMessages = {
  title: "Input required",
  /** Multi-question chrome has no default subtitle; hosts may still override. */
  description: "",
  submit: "Send answers",
  skip: "Skip",
  submitting: "Submitting…",
  other: "Other",
  deadlineLabel: "Expires",
  formatDeadline,
  required: "This question is required.",
  otherRequired: "Enter a value for Other.",
  minSelections: (count) => `Choose at least ${count} option${count === 1 ? "" : "s"}.`,
  maxSelections: (count) => `Choose no more than ${count} option${count === 1 ? "" : "s"}.`,
  optional: "Optional",
  moreBelow: "More below",
  questionCount: (count) => `${count} questions`,
  collapse: "Collapse",
  expand: "Expand",
  selectionHint: (min, max) => {
    if (min != null && max != null) return `Choose ${min}–${max}.`;
    if (min != null) return `Choose at least ${min}.`;
    if (max != null) return `Choose up to ${max}.`;
    return null;
  },
  secretShow: "Show",
  secretHide: "Hide",
  secretGenerate: "Generate",
  secretWillGenerate: "A strong password will be generated",
  secretUndo: "Undo",
  secretSaveTo: "Save to",
  secretSaveToOptions: { user: "Only me", task: "This task", workspace: "This workspace" },
  secretVaultHint: (saveTo, vault) =>
    vault
      ? `Saves to the ${vault} vault`
      : saveTo === "user"
        ? "Saves to your private vault"
        : saveTo === "task"
          ? "Saves to this task"
          : "Saves to the workspace vault",
  secretSaveToDowngraded: (requested, actual) =>
    `You can't save to ${SAVE_TO_IN_SENTENCE[requested]}, so it will be saved to ${SAVE_TO_IN_SENTENCE[actual]}.`,
  secretLooksLike: (example) => `Looks like ${example}`,
  secretPatternWarning: (looksLike) =>
    looksLike
      ? `This doesn't look like ${looksLike}. You can still send it.`
      : "This doesn't match the expected format. You can still send it.",
  secretSaved: (vaultName, itemName) => `Saved to ${vaultName} › ${itemName}`,
};

/**
 * Text, single- and multi-select drafts. Secret questions are not drafted:
 * their value lives only in an uncontrolled input and is collected with
 * {@link secretAnswerFromReading} at submit time.
 */
export function answersFromDrafts(
  questions: HumanInputQuestion[],
  drafts: Record<string, HumanInputAnswerDraft>,
  messageOverrides: Partial<HumanInputFormMessages> = {},
): { answers: HumanInputAnswer[]; errors: Record<string, string> } {
  const messages = { ...defaultHumanInputFormMessages, ...messageOverrides };
  const answers: HumanInputAnswer[] = [];
  const errors: Record<string, string> = {};
  for (const question of questions) {
    if (question.kind === "secret") continue;
    const draft = drafts[question.id] ?? emptyDraft();
    const values = question.kind === "text" ? draft.values.filter(Boolean) : draft.values;
    const other = draft.otherSelected ? draft.other : "";
    const hasOther = Boolean(other.trim());
    const supplied = values.length + (hasOther ? 1 : 0);

    // Other-selected-but-empty must win over generic "required" — otherwise the
    // user sees the wrong diagnosis next to a clearly selected control.
    if (question.kind !== "text" && draft.otherSelected && !hasOther) {
      errors[question.id] = messages.otherRequired;
      continue;
    }

    if (question.required && supplied === 0) {
      errors[question.id] = messages.required;
      continue;
    }
    if (question.kind !== "text") {
      const min = question.validation?.minSelections;
      const max = question.kind === "single_select" ? 1 : question.validation?.maxSelections;
      if (min != null && supplied < min) {
        errors[question.id] = messages.minSelections(min);
        continue;
      }
      if (max != null && supplied > max) {
        errors[question.id] = messages.maxSelections(max);
        continue;
      }
    }
    if (supplied > 0) {
      answers.push({
        questionId: question.id,
        values,
        ...(hasOther ? { other } : {}),
      });
    }
  }
  return { answers, errors };
}

export function initialDrafts(
  questions: HumanInputQuestion[],
): Record<string, HumanInputAnswerDraft> {
  return Object.fromEntries(questions.map((question) => [question.id, emptyDraft()]));
}

export function emptyDraft(): HumanInputAnswerDraft {
  return { values: [], other: "", otherSelected: false };
}

export function formatDeadline(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const ms = date.getTime() - Date.now();
  if (ms <= 0) return "deadline passed";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return date.toLocaleString();
}

/** The form heading: a single question leads with its own label/prompt. */
export function humanInputHeading(
  questions: readonly HumanInputQuestion[],
  messages: Pick<HumanInputFormMessages, "title" | "description">,
): { title: string; description: string | null } {
  const single = questions.length === 1 ? questions[0]! : null;
  return {
    title: single ? (single.label ?? single.prompt) : messages.title,
    description: single
      ? single.label
        ? single.prompt
        : (single.helpText ?? null)
      : messages.description || null,
  };
}

/* ---- secret questions ------------------------------------------------------ */

export const SECRET_SAVE_TO_ORDER: readonly HumanInputSecretSaveTo[] = [
  "user",
  "task",
  "workspace",
];

export type SecretAutocomplete = "current-password" | "new-password" | "one-time-code" | "off";

/**
 * The `autocomplete` token for the secret input. The contract defaults
 * `autocomplete` to "current-password", so that value is treated as "not
 * chosen": a TOTP field asks for a one-time code, and a field the person may
 * generate is a new password (password managers offer to create and save it).
 */
export function secretAutocomplete(spec: HumanInputSecretSpec): SecretAutocomplete {
  if (spec.autocomplete && spec.autocomplete !== "current-password") return spec.autocomplete;
  if (spec.fieldKind === "totp") return "one-time-code";
  if (spec.allowGenerate || spec.generate) return "new-password";
  return "current-password";
}

/** Digits keyboard on phones for one-time codes. */
export function secretInputMode(spec: HumanInputSecretSpec): "numeric" | undefined {
  return secretAutocomplete(spec) === "one-time-code" ? "numeric" : undefined;
}

/** A plain-text field kind is not concealed (no show/hide). */
export function secretConcealed(spec: HumanInputSecretSpec): boolean {
  return spec.fieldKind !== "text";
}

/** Generate is offered for concealed values the agent allows to be generated. */
export function secretCanGenerate(spec: HumanInputSecretSpec): boolean {
  return Boolean(spec.allowGenerate || spec.generate) && spec.fieldKind !== "totp";
}

/** The input's label: "Password", "API key", "One-time code", or the field name. */
export function secretFieldLabel(spec: HumanInputSecretSpec): string {
  const field = spec.field?.trim() || "password";
  if (spec.fieldKind === "totp" && field.toLowerCase() === "password") return "One-time code";
  if (spec.itemType === "api_key" && field.toLowerCase() === "password") return "API key";
  if (spec.itemType === "note" && field.toLowerCase() === "password") return "Note";
  const words = field.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export type SecretSaveToChoice = {
  /** What the agent asked for (contract default: "user"). */
  requested: HumanInputSecretSaveTo;
  /** The initial selection: the request, or the best allowed target. */
  initial: HumanInputSecretSaveTo;
  /** True when the request is not allowed and was replaced. */
  downgraded: boolean;
  /** Allowed choices in display order. */
  options: HumanInputSecretSaveTo[];
};

/**
 * Filter Save to by what this person may write. A request that is not allowed
 * falls back to the most private allowed target (Only me, then This task).
 */
export function resolveSecretSaveTo(
  spec: HumanInputSecretSpec,
  allowed: readonly HumanInputSecretSaveTo[] = SECRET_SAVE_TO_ORDER,
): SecretSaveToChoice {
  const requested = spec.saveTo ?? "user";
  const options = SECRET_SAVE_TO_ORDER.filter((target) => allowed.includes(target));
  if (options.includes(requested)) {
    return { requested, initial: requested, downgraded: false, options };
  }
  // Nothing allowed is a host error; keep the request so the server decides.
  if (options.length === 0) {
    return { requested, initial: requested, downgraded: false, options: [requested] };
  }
  return { requested, initial: options[0]!, downgraded: true, options };
}

/** The vault the agent named applies only to the scope it asked for. */
export function secretVaultForTarget(
  spec: HumanInputSecretSpec,
  saveTo: HumanInputSecretSaveTo,
): string | null {
  return spec.vault && saveTo === (spec.saveTo ?? "user") ? spec.vault : null;
}

/**
 * Soft check against the agent's `pattern` (a regular expression searched in
 * the value, not anchored). Never blocks submit; an invalid pattern is ignored.
 */
export function secretPatternMismatch(pattern: string | null | undefined, value: string): boolean {
  if (!pattern || !value) return false;
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, "u");
  } catch {
    try {
      expression = new RegExp(pattern);
    } catch {
      return false;
    }
  }
  return !expression.test(value);
}

/** What a secret field holds at submit time. `value` exists only for this call. */
export type SecretFieldReading = {
  value: string | null;
  generate: GeneratePasswordSpec | null;
  username: string | null;
  saveTo: HumanInputSecretSaveTo;
};

/**
 * Build the write-only `secretAnswers` entry and the public answer for one
 * secret question. The public answer has no values: the server adds the
 * saved reference. Returns null for an unanswered optional question.
 */
export function secretAnswerFromReading(
  question: HumanInputQuestion,
  reading: SecretFieldReading,
  messageOverrides: Partial<HumanInputFormMessages> = {},
): { answer: HumanInputAnswer; secretAnswer: HumanInputSecretAnswer } | { error: string } | null {
  const messages = { ...defaultHumanInputFormMessages, ...messageOverrides };
  const value = reading.generate ? null : reading.value || null;
  if (!reading.generate && value === null) {
    return question.required ? { error: messages.required } : null;
  }
  const username = reading.username?.trim() || null;
  const secretAnswer: HumanInputSecretAnswer = {
    questionId: question.id,
    ...(reading.generate ? { generate: reading.generate } : { value: value! }),
    ...(username ? { username } : {}),
    saveTo: reading.saveTo,
  };
  return { answer: { questionId: question.id, values: [] }, secretAnswer };
}

/** The answered chip label, never a value. */
export function secretAnswerLabel(
  result: HumanInputSecretAnswerResult,
  messageOverrides: Partial<HumanInputFormMessages> = {},
): string {
  const messages = { ...defaultHumanInputFormMessages, ...messageOverrides };
  return messages.secretSaved(result.vaultName, result.itemName);
}
