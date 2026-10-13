import { describe, expect, test } from "bun:test";
import type { HumanInputQuestion, HumanInputSecretSpec } from "@opengeni/sdk";
import {
  applePasswordRules,
  humanInputAnswerLines,
  initialSecretDraft,
  secretInputMode,
  secretInputTraits,
  secretPatternMismatch,
  secretSavedLabel,
  secretSubmission,
  secretUsernameTraits,
} from "../src/timeline/secret-field-model";

function secretQuestion(
  id: string,
  secret: HumanInputSecretSpec,
  required = true,
): HumanInputQuestion {
  return {
    id,
    kind: "secret",
    prompt: `Enter ${id}`,
    options: [],
    required,
    allowOther: false,
    secret,
  };
}

describe("secret input traits", () => {
  test("every variant is a secure, uncorrected, uncapitalized field", () => {
    const specs: HumanInputSecretSpec[] = [
      { item: "GitHub" },
      { item: "GitHub", allowGenerate: true },
      { item: "Code", autocomplete: "one-time-code" },
      { item: "2FA", fieldKind: "totp" },
      { item: "OpenAI", itemType: "api_key" },
      { item: "Other", autocomplete: "off" },
    ];
    for (const spec of specs) {
      const traits = secretInputTraits(spec);
      expect(traits.secureTextEntry).toBe(true);
      expect(traits.autoCorrect).toBe(false);
      expect(traits.autoCapitalize).toBe("none");
      expect(traits.spellCheck).toBe(false);
    }
  });

  test("a login password is the current password (iOS password, Android password hint)", () => {
    expect(secretInputTraits({ item: "GitHub" })).toMatchObject({
      mode: "current-password",
      textContentType: "password",
      autoComplete: "password",
      importantForAutofill: "yes",
      keyboardType: "default",
    });
    expect(secretInputMode({ item: "GitHub", autocomplete: "current-password" })).toBe(
      "current-password",
    );
  });

  test("new-password and Generate get the new-password traits and iOS password rules", () => {
    const generated = secretInputTraits({
      item: "Acme",
      allowGenerate: true,
      generate: { length: 32, symbols: false },
    });
    expect(generated).toMatchObject({
      mode: "new-password",
      textContentType: "newPassword",
      autoComplete: "password-new",
      importantForAutofill: "yes",
    });
    expect(generated.passwordRules).toBe(
      "required: lower; required: upper; required: digit; minlength: 32;",
    );
    const explicit = secretInputTraits({ item: "Acme", autocomplete: "new-password" });
    expect(explicit.textContentType).toBe("newPassword");
    expect(explicit.passwordRules).toBeUndefined();
    // An explicit current-password wins over allowGenerate.
    expect(
      secretInputMode({ item: "Acme", allowGenerate: true, autocomplete: "current-password" }),
    ).toBe("current-password");
  });

  test("a one-time code uses the OTP traits and the number pad", () => {
    expect(secretInputTraits({ item: "Code", autocomplete: "one-time-code" })).toMatchObject({
      mode: "one-time-code",
      textContentType: "oneTimeCode",
      autoComplete: "sms-otp",
      importantForAutofill: "yes",
      keyboardType: "number-pad",
    });
  });

  test("a TOTP seed, API key or explicit off is never offered to the password manager", () => {
    for (const spec of [
      { item: "2FA", fieldKind: "totp" },
      { item: "OpenAI", itemType: "api_key" },
      { item: "Note", itemType: "note" },
      { item: "Other", autocomplete: "off" },
    ] satisfies HumanInputSecretSpec[]) {
      expect(secretInputTraits(spec)).toMatchObject({
        textContentType: "none",
        autoComplete: "off",
        importantForAutofill: "no",
        keyboardType: "default",
      });
    }
    expect(secretInputMode({ item: "2FA", fieldKind: "totp" })).toBe("setup-key");
  });

  test("the username field pairs with the password for autofill", () => {
    expect(secretUsernameTraits).toMatchObject({
      textContentType: "username",
      autoComplete: "username",
      importantForAutofill: "yes",
      autoCorrect: false,
      autoCapitalize: "none",
    });
  });

  test("password rules follow the generator spec and its defaults", () => {
    expect(applePasswordRules({})).toBe(
      "required: lower; required: upper; required: digit; required: [-!#%+.:=?@_]; minlength: 24;",
    );
    expect(
      applePasswordRules({ requireEachClass: false, uppercase: false, symbolSet: '"]$' }),
    ).toBe("allowed: lower, digit, [$]; minlength: 24;");
  });
});

describe("secret submission", () => {
  test("the value goes only to secretAnswers; answers carry an empty entry", () => {
    const question = secretQuestion("password", {
      item: "GitHub",
      username: { prompt: "Username" },
    });
    const draft = { ...initialSecretDraft(question.secret), username: " octo " };
    const result = secretSubmission(
      [question],
      { password: draft },
      { password: "hunter2" },
      "Required",
    );
    expect(result.errors).toEqual({});
    expect(result.answers).toEqual([{ questionId: "password", values: [] }]);
    expect(result.secretAnswers).toEqual([
      { questionId: "password", value: "hunter2", username: "octo", saveTo: "user" },
    ]);
    expect(JSON.stringify(result.answers)).not.toContain("hunter2");
  });

  test("Generate sends the question's generator spec (or {}) and no value", () => {
    const withSpec = secretQuestion("a", {
      item: "A",
      allowGenerate: true,
      generate: { length: 40 },
    });
    const bare = secretQuestion("b", { item: "B", allowGenerate: true, saveTo: "workspace" });
    const result = secretSubmission(
      [withSpec, bare],
      {
        a: { ...initialSecretDraft(withSpec.secret), generate: true },
        b: { ...initialSecretDraft(bare.secret), generate: true },
      },
      { a: "typed-then-generated" },
      "Required",
    );
    expect(result.secretAnswers).toEqual([
      { questionId: "a", generate: { length: 40 }, saveTo: "user" },
      { questionId: "b", generate: {}, saveTo: "workspace" },
    ]);
    expect(JSON.stringify(result)).not.toContain("typed-then-generated");
  });

  test("Save to defaults to the spec, then Only me", () => {
    expect(initialSecretDraft({ item: "A" }).saveTo).toBe("user");
    expect(initialSecretDraft({ item: "A", saveTo: "task" }).saveTo).toBe("task");
    expect(initialSecretDraft({ item: "A", username: { prompt: "U", value: "me" } }).username).toBe(
      "me",
    );
  });

  test("a required empty secret is an error; an optional one is left out", () => {
    const required = secretQuestion("r", { item: "R" });
    const optional = secretQuestion("o", { item: "O" }, false);
    const result = secretSubmission([required, optional], {}, {}, "Required");
    expect(result.errors).toEqual({ r: "Required" });
    expect(result.answers).toEqual([]);
    expect(result.secretAnswers).toEqual([]);
  });

  test("a username is only sent when the question asks for one", () => {
    const question = secretQuestion("p", { item: "P" });
    const result = secretSubmission(
      [question],
      { p: { generate: false, username: "ignored", saveTo: "user" } },
      { p: "v" },
      "Required",
    );
    expect(result.secretAnswers).toEqual([{ questionId: "p", value: "v", saveTo: "user" }]);
  });

  test("non-secret questions are ignored", () => {
    const text: HumanInputQuestion = {
      id: "t",
      kind: "text",
      prompt: "Why?",
      options: [],
      required: true,
      allowOther: false,
    };
    expect(secretSubmission([text], {}, {}, "Required")).toEqual({
      answers: [],
      secretAnswers: [],
      errors: {},
    });
  });
});

describe("soft pattern check", () => {
  test("warns on a mismatch, anchored like the HTML pattern attribute", () => {
    expect(secretPatternMismatch("sk-[A-Za-z0-9]+", "sk-abc123")).toBe(false);
    expect(secretPatternMismatch("sk-[A-Za-z0-9]+", "xsk-abc123")).toBe(true);
    expect(secretPatternMismatch("\\d{6}", "12345")).toBe(true);
  });

  test("never warns without a pattern, on an empty value, or on an invalid pattern", () => {
    expect(secretPatternMismatch(undefined, "x")).toBe(false);
    expect(secretPatternMismatch("\\d+", "")).toBe(false);
    expect(secretPatternMismatch("([", "x")).toBe(false);
  });
});

describe("saved answer", () => {
  const saved = (vault: string, item: string) => `Saved to ${vault} › ${item}`;

  test("the chip names the vault and item, never a value", () => {
    expect(secretSavedLabel({ vaultName: "Private", itemName: "GitHub" })).toBe(
      "Saved to Private › GitHub",
    );
  });

  test("answer lines replace a secret answer with where it was saved", () => {
    const lines = humanInputAnswerLines(
      [
        { questionId: "env", label: "Environment", values: ["Staging"] },
        { questionId: "pw", label: "GitHub password", values: [] },
      ],
      {
        outcome: "answered",
        answers: [
          { questionId: "env", values: ["staging"] },
          {
            questionId: "pw",
            values: [],
            secret: {
              reference: "{{secret:Private/GitHub/password}}",
              username: "octo",
              vaultName: "Private",
              itemName: "GitHub",
              saveTo: "user",
            },
          },
        ],
      },
      saved,
      true,
    );
    expect(lines).toEqual([
      { questionId: "env", text: "Environment: Staging", secret: false },
      { questionId: "pw", text: "GitHub password: Saved to Private › GitHub", secret: true },
    ]);
  });

  test("a skipped request has no secret lines", () => {
    expect(humanInputAnswerLines([], { outcome: "skipped" }, saved, false)).toEqual([]);
  });
});
