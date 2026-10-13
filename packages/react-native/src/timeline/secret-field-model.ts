import type {
  GeneratePasswordSpec,
  HumanInputAnswer,
  HumanInputQuestion,
  HumanInputResponse,
  HumanInputSecretAnswer,
  HumanInputSecretAnswerResult,
  HumanInputSecretSaveTo,
  HumanInputSecretSpec,
} from "@opengeni/sdk";

/* ----------------------------------------------------------------------------
   Pure rules for the native secret question: which keyboard and autofill
   traits the field gets, what a submission sends, and how a saved answer
   reads. No React Native imports, so the rules are unit-tested under bun.
   -------------------------------------------------------------------------- */

/**
 * - `current-password` / `new-password`: the OS password manager fills or
 *   suggests a password.
 * - `one-time-code`: a code the person just received (number pad, SMS autofill).
 * - `setup-key`: a TOTP seed (`fieldKind: "totp"` stores the seed, not a code).
 * - `off`: an API key, token or note; no autofill.
 */
export type SecretInputMode =
  | "current-password"
  | "new-password"
  | "one-time-code"
  | "setup-key"
  | "off";

export function secretInputMode(spec: HumanInputSecretSpec | null | undefined): SecretInputMode {
  const autocomplete = spec?.autocomplete;
  if (autocomplete === "one-time-code") return "one-time-code";
  if (autocomplete === "new-password") return "new-password";
  if (autocomplete === "current-password") return "current-password";
  if (autocomplete === "off") return spec?.fieldKind === "totp" ? "setup-key" : "off";
  if (spec?.fieldKind === "totp") return "setup-key";
  if (spec?.allowGenerate) return "new-password";
  if (spec?.itemType === "api_key" || spec?.itemType === "note") return "off";
  return "current-password";
}

/** The `TextInput` props that make the field secure and autofill-aware. */
export type SecretInputTraits = {
  mode: SecretInputMode;
  secureTextEntry: true;
  autoCorrect: false;
  autoCapitalize: "none";
  spellCheck: false;
  /** iOS. */
  textContentType: "password" | "newPassword" | "oneTimeCode" | "none";
  /** Android autofill hint (RN maps it to the platform constant). */
  autoComplete: "password" | "password-new" | "sms-otp" | "off";
  /** Android. */
  importantForAutofill: "yes" | "no";
  keyboardType: "default" | "number-pad";
  /** iOS strong-password rules, from the question's generator spec. */
  passwordRules?: string | undefined;
};

export function secretInputTraits(
  spec: HumanInputSecretSpec | null | undefined,
): SecretInputTraits {
  const mode = secretInputMode(spec);
  const base = {
    mode,
    secureTextEntry: true,
    autoCorrect: false,
    autoCapitalize: "none",
    spellCheck: false,
  } as const;
  switch (mode) {
    case "current-password":
      return {
        ...base,
        textContentType: "password",
        autoComplete: "password",
        importantForAutofill: "yes",
        keyboardType: "default",
      };
    case "new-password": {
      const passwordRules = spec?.generate ? applePasswordRules(spec.generate) : undefined;
      return {
        ...base,
        textContentType: "newPassword",
        autoComplete: "password-new",
        importantForAutofill: "yes",
        keyboardType: "default",
        ...(passwordRules ? { passwordRules } : {}),
      };
    }
    case "one-time-code":
      return {
        ...base,
        textContentType: "oneTimeCode",
        autoComplete: "sms-otp",
        importantForAutofill: "yes",
        keyboardType: "number-pad",
      };
    case "setup-key":
    case "off":
      return {
        ...base,
        textContentType: "none",
        autoComplete: "off",
        importantForAutofill: "no",
        keyboardType: "default",
      };
  }
}

/** The username field paired with the password, so the OS saves them together. */
export const secretUsernameTraits = {
  textContentType: "username",
  autoComplete: "username",
  importantForAutofill: "yes",
  autoCorrect: false,
  autoCapitalize: "none",
  spellCheck: false,
} as const;

/**
 * Apple password-rules markup for the iOS strong-password suggestion, from the
 * same spec the server generates with (defaults as in `@opengeni/contracts`).
 */
export function applePasswordRules(spec: GeneratePasswordSpec): string {
  const rules: string[] = [];
  const lower = spec.lowercase ?? true;
  const upper = spec.uppercase ?? true;
  const digits = spec.digits ?? true;
  const symbols = spec.symbols ?? true;
  const requireEach = spec.requireEachClass ?? true;
  // In the rules grammar a hyphen is literal only first in a class, and "]"
  // or a quote cannot appear at all.
  const rawSymbols = spec.symbolSet ?? "!#%+-.:=?@_";
  const symbolSet = (rawSymbols.includes("-") ? "-" : "") + rawSymbols.replace(/[-\]"]/gu, "");
  const classes = [
    lower ? "lower" : null,
    upper ? "upper" : null,
    digits ? "digit" : null,
    symbols && symbolSet ? `[${symbolSet}]` : null,
  ].filter((entry): entry is string => entry !== null);
  if (requireEach) for (const entry of classes) rules.push(`required: ${entry};`);
  else rules.push(`allowed: ${classes.join(", ")};`);
  rules.push(`minlength: ${spec.length ?? 24};`);
  return rules.join(" ");
}

/** What the person picked for one secret question. The value itself lives in a ref. */
export type SecretDraft = {
  generate: boolean;
  username: string;
  saveTo: HumanInputSecretSaveTo;
};

export const SECRET_SAVE_TO_OPTIONS: readonly HumanInputSecretSaveTo[] = [
  "user",
  "task",
  "workspace",
];

export function initialSecretDraft(spec: HumanInputSecretSpec | null | undefined): SecretDraft {
  return {
    generate: false,
    username: spec?.username?.value ?? "",
    saveTo: spec?.saveTo ?? "user",
  };
}

export function isSecretQuestion(question: Pick<HumanInputQuestion, "kind">): boolean {
  return question.kind === "secret";
}

/**
 * The secret half of a submission. Each answered secret question sends an
 * empty `answers` entry and its value (or a generate spec) only in
 * `secretAnswers`, which the API strips before anything is stored.
 */
export function secretSubmission(
  questions: readonly HumanInputQuestion[],
  drafts: Readonly<Record<string, SecretDraft | undefined>>,
  values: Readonly<Record<string, string | undefined>>,
  requiredMessage: string,
): {
  answers: HumanInputAnswer[];
  secretAnswers: HumanInputSecretAnswer[];
  errors: Record<string, string>;
} {
  const answers: HumanInputAnswer[] = [];
  const secretAnswers: HumanInputSecretAnswer[] = [];
  const errors: Record<string, string> = {};
  for (const question of questions) {
    if (!isSecretQuestion(question)) continue;
    const spec = question.secret;
    const draft = drafts[question.id] ?? initialSecretDraft(spec);
    const value = values[question.id] ?? "";
    const supplied = draft.generate || value.length > 0;
    if (!supplied) {
      if (question.required) errors[question.id] = requiredMessage;
      continue;
    }
    const username = draft.username.trim();
    answers.push({ questionId: question.id, values: [] });
    secretAnswers.push({
      questionId: question.id,
      ...(draft.generate ? { generate: spec?.generate ?? {} } : { value }),
      ...(spec?.username && username ? { username } : {}),
      saveTo: draft.saveTo,
    });
  }
  return { answers, secretAnswers, errors };
}

/**
 * A soft check against the question's `pattern` (anchored, like the HTML
 * attribute). Never blocks; an invalid pattern never warns.
 */
export function secretPatternMismatch(pattern: string | null | undefined, value: string): boolean {
  if (!pattern || value.length === 0) return false;
  let expression: RegExp;
  try {
    expression = new RegExp(`^(?:${pattern})$`, "u");
  } catch {
    return false;
  }
  return !expression.test(value);
}

export type SecretFieldMessages = {
  saveTo: string;
  saveToOption: Record<HumanInputSecretSaveTo, string>;
  vaultHint: (vault: string) => string;
  show: string;
  hide: string;
  generate: string;
  generated: string;
  undo: string;
  looksLike: (example: string) => string;
  patternWarning: string;
  placeholder: Record<SecretInputMode, string>;
  saved: (vaultName: string, itemName: string) => string;
};

export const defaultSecretFieldMessages: SecretFieldMessages = {
  saveTo: "Save to",
  saveToOption: { user: "Only me", task: "This task", workspace: "Workspace" },
  vaultHint: (vault) => `Saves to the ${vault} vault`,
  show: "Show secret",
  hide: "Hide secret",
  generate: "Generate",
  generated: "A strong password will be generated",
  undo: "Undo",
  looksLike: (example) => `Looks like ${example}`,
  patternWarning: "This doesn't match the expected format. You can still send it.",
  placeholder: {
    "current-password": "Password",
    "new-password": "New password",
    "one-time-code": "Code",
    "setup-key": "Setup key or otpauth:// link",
    off: "Value",
  },
  saved: (vaultName, itemName) => `Saved to ${vaultName} › ${itemName}`,
};

/** The answered chip: where the value went, never the value. */
export function secretSavedLabel(
  result: Pick<HumanInputSecretAnswerResult, "vaultName" | "itemName">,
  messages: Pick<SecretFieldMessages, "saved"> = defaultSecretFieldMessages,
): string {
  return messages.saved(result.vaultName, result.itemName);
}

/**
 * The lines of a settled answer bubble. A secret answer reads as where it was
 * saved ("Saved to Private › GitHub"); its value never reaches the timeline.
 */
export function humanInputAnswerLines(
  answers: readonly { questionId: string; label: string; values: readonly string[] }[],
  response: HumanInputResponse,
  saved: (vaultName: string, itemName: string) => string,
  multiple: boolean,
): { questionId: string; text: string; secret: boolean }[] {
  const secrets = new Map(
    response.outcome === "answered"
      ? response.answers.flatMap((answer) =>
          answer.secret ? [[answer.questionId, answer.secret] as const] : [],
        )
      : [],
  );
  return answers.map((answer) => {
    const prefix = multiple ? `${answer.label}: ` : "";
    const secret = secrets.get(answer.questionId);
    return secret
      ? {
          questionId: answer.questionId,
          text: `${prefix}${saved(secret.vaultName, secret.itemName)}`,
          secret: true,
        }
      : {
          questionId: answer.questionId,
          text: `${prefix}${answer.values.join(", ")}`,
          secret: false,
        };
  });
}
