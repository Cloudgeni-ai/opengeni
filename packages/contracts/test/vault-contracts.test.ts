import { describe, expect, test } from "bun:test";
import {
  allAgentCapabilities,
  buildMissingSecretAskCard,
  CreateVaultItemRequest,
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  HumanInputQuestion,
  HumanInputSecretAnswer,
  intersectVaultPolicies,
  isValidSecretName,
  ListVaultItemsQuery,
  normalizePermission,
  Permission,
  RequestHumanInputToolInput,
  ResolvedAgentConfig,
  SECRET_PERMISSION_ALIASES,
  SecretReferenceError,
  secretValueAtDispatch,
  SubmitHumanInputResponseRequest,
  UpdateVaultItemRequest,
  VAULT_ERROR_HTTP_STATUS,
  VaultErrorCode,
  VaultFieldInput,
  VaultFieldName,
  VaultName,
  VaultPolicy,
  type ResolvedSecretValue,
} from "../src/index";
import { parseSecretReference, referenceKey } from "../src/secret-references";

const UUID_A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const UUID_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("names", () => {
  test.each(["GitHub", "My API key", "Ålesund", "x", "a.b-c_d (prod)", "n".repeat(120), "otp"])(
    "accepts %p",
    (name) => {
      expect(isValidSecretName(name)).toBe(true);
      expect(VaultName.safeParse(name).success).toBe(true);
    },
  );
  test.each([
    "",
    " x",
    "x ",
    "a/b",
    "a{b",
    "a}b",
    "a#b",
    "a\\b",
    "tab\tx",
    "id:abc",
    "ID:abc",
    "n".repeat(121),
  ])("rejects %p", (name) => {
    expect(isValidSecretName(name)).toBe(false);
    expect(VaultName.safeParse(name).success).toBe(false);
  });
  test("field names cannot be otp", () => {
    expect(VaultFieldName.safeParse("otp").success).toBe(false);
    expect(VaultFieldName.safeParse("OTP").success).toBe(false);
    expect(VaultFieldName.safeParse("otp seed").success).toBe(true);
  });
});

describe("vault policy", () => {
  test("schema", () => {
    expect(VaultPolicy.safeParse({ mode: "all" }).success).toBe(true);
    expect(VaultPolicy.safeParse({ mode: "selected", vaultIds: [UUID_A] }).success).toBe(true);
    expect(VaultPolicy.safeParse({ mode: "selected", vaultIds: ["nope"] }).success).toBe(false);
    expect(VaultPolicy.safeParse({ mode: "all", vaultIds: [] }).success).toBe(false);
    expect(
      VaultPolicy.safeParse({ mode: "selected", vaultIds: Array(201).fill(UUID_A) }).success,
    ).toBe(false);
  });
  test("intersection", () => {
    expect(intersectVaultPolicies({ mode: "all" }, { mode: "all" })).toEqual({ mode: "all" });
    expect(
      intersectVaultPolicies({ mode: "all" }, { mode: "selected", vaultIds: [UUID_A] }),
    ).toEqual({
      mode: "selected",
      vaultIds: [UUID_A],
    });
    expect(
      intersectVaultPolicies(
        { mode: "selected", vaultIds: [UUID_A, UUID_B] },
        { mode: "selected", vaultIds: [UUID_B] },
      ),
    ).toEqual({ mode: "selected", vaultIds: [UUID_B] });
  });
});

describe("item requests", () => {
  test("field input needs exactly one value source", () => {
    expect(VaultFieldInput.safeParse({ name: "password", value: "x" }).success).toBe(true);
    expect(VaultFieldInput.safeParse({ name: "password", generate: {} }).success).toBe(true);
    expect(VaultFieldInput.safeParse({ name: "password", remove: true }).success).toBe(true);
    expect(VaultFieldInput.safeParse({ name: "password" }).success).toBe(false);
    expect(VaultFieldInput.safeParse({ name: "password", value: "x", generate: {} }).success).toBe(
      false,
    );
    expect(VaultFieldInput.safeParse({ name: "otp", value: "x" }).success).toBe(false);
  });
  test("create and update", () => {
    expect(
      CreateVaultItemRequest.safeParse({
        type: "login",
        name: "GitHub",
        websites: ["https://github.com"],
        fields: [
          { name: "username", value: "octo" },
          { name: "password", generate: { length: 32 } },
        ],
      }).success,
    ).toBe(true);
    expect(
      UpdateVaultItemRequest.safeParse({ expectedGeneration: 2, name: "GitHub 2" }).success,
    ).toBe(true);
    expect(UpdateVaultItemRequest.safeParse({ name: "GitHub 2" }).success).toBe(false);
  });
  test("list query accepts query-string values", () => {
    expect(ListVaultItemsQuery.parse({ includeArchived: "true", limit: "50" })).toEqual({
      includeArchived: true,
      limit: 50,
    });
  });
});

describe("errors", () => {
  test("every code has an HTTP status", () => {
    for (const code of VaultErrorCode.options)
      expect(VAULT_ERROR_HTTP_STATUS[code]).toBeGreaterThan(0);
  });
});

describe("ask card secret field", () => {
  const secretQuestion = {
    id: "q1",
    kind: "secret",
    prompt: "GitHub password",
    secret: { item: "GitHub" },
  };
  test("secret questions require a spec and no options", () => {
    const parsed = HumanInputQuestion.parse(secretQuestion);
    expect(parsed.secret).toEqual({
      item: "GitHub",
      field: "password",
      fieldKind: "concealed",
      itemType: "login",
      saveTo: "user",
      allowGenerate: false,
      autocomplete: "current-password",
    });
    expect(HumanInputQuestion.safeParse({ ...secretQuestion, secret: undefined }).success).toBe(
      false,
    );
    expect(
      HumanInputQuestion.safeParse({ ...secretQuestion, options: [{ id: "a", label: "A" }] })
        .success,
    ).toBe(false);
    expect(
      HumanInputQuestion.safeParse({
        id: "q",
        kind: "text",
        prompt: "x",
        secret: { item: "GitHub" },
      }).success,
    ).toBe(false);
    expect(
      HumanInputQuestion.safeParse({ ...secretQuestion, secret: { item: "a/b" } }).success,
    ).toBe(false);
  });
  test("secret answers are value xor generate", () => {
    expect(
      HumanInputSecretAnswer.safeParse({ questionId: "q1", value: "x", saveTo: "user" }).success,
    ).toBe(true);
    expect(
      HumanInputSecretAnswer.safeParse({ questionId: "q1", generate: {}, saveTo: "task" }).success,
    ).toBe(true);
    expect(HumanInputSecretAnswer.safeParse({ questionId: "q1", saveTo: "user" }).success).toBe(
      false,
    );
    expect(
      HumanInputSecretAnswer.safeParse({
        questionId: "q1",
        value: "x",
        generate: {},
        saveTo: "user",
      }).success,
    ).toBe(false);
  });
  test("submit request carries write-only secretAnswers", () => {
    const parsed = SubmitHumanInputResponseRequest.parse({
      outcome: "answered",
      answers: [{ questionId: "q1", values: [] }],
      secretAnswers: [{ questionId: "q1", value: "hunter2", saveTo: "user" }],
    });
    expect(parsed.outcome === "answered" && parsed.secretAnswers?.length).toBe(1);
  });
  test("missing-secret ask card is a valid request_human_input call", () => {
    const failures = [
      { raw: "{{secret:GitHub}}", code: "not_found" as const, message: "missing" },
      { raw: "{{secret:Team/Stripe/api key}}", code: "not_found" as const, message: "missing" },
      { raw: "{{secret:GitHub/otp}}", code: "not_found" as const, message: "missing" },
      { raw: "{{secret:GitHub}}", code: "not_found" as const, message: "dup" },
      { raw: `{{secret:id:${UUID_A}}}`, code: "not_found" as const, message: "by id" },
      {
        raw: "{{secret:Other}}",
        code: "ambiguous" as const,
        message: "two",
        candidates: ["{{secret:A/Other}}"],
      },
    ];
    const card = buildMissingSecretAskCard(failures, { hasActingHuman: true });
    expect(card).not.toBeNull();
    const parsed = RequestHumanInputToolInput.parse(card);
    expect(
      parsed.questions.map((question) => [
        question.secret?.item,
        question.secret?.field,
        question.secret?.fieldKind,
      ]),
    ).toEqual([
      ["GitHub", "password", "concealed"],
      ["Stripe", "api key", "concealed"],
      ["GitHub", "totp", "totp"],
    ]);
    expect(parsed.questions.every((question) => question.secret?.saveTo === "user")).toBe(true);
    expect(
      buildMissingSecretAskCard(failures, { hasActingHuman: false })?.questions[0]?.secret?.saveTo,
    ).toBe("workspace");
    expect(buildMissingSecretAskCard([failures[4]!], { hasActingHuman: true })).toBeNull();
  });
  test("SecretReferenceError model output carries the card and never values", () => {
    const failures = [
      { raw: "{{secret:GitHub}}", code: "not_found" as const, message: "no GitHub item" },
    ];
    const error = new SecretReferenceError(
      failures,
      buildMissingSecretAskCard(failures, { hasActingHuman: true }),
    );
    const output = JSON.parse(error.toModelOutput());
    expect(output.error).toBe("secret_reference_error");
    expect(output.failures).toEqual(failures);
    expect(RequestHumanInputToolInput.safeParse(output.askCard).success).toBe(true);
    expect(typeof output.hint).toBe("string");
  });
});

describe("dispatch materialization", () => {
  test("text, bytes and totp", async () => {
    const reference = parseSecretReference("{{secret:X}}");
    const base: Omit<ResolvedSecretValue, "material"> = {
      key: referenceKey(reference),
      reference,
      source: "opengeni",
      vaultId: UUID_A,
      vaultName: "V",
      itemId: UUID_B,
      itemName: "X",
      fieldId: null,
      fieldName: "password",
      version: 1,
    };
    expect(await secretValueAtDispatch({ ...base, material: { type: "text", value: "v" } })).toBe(
      "v",
    );
    const bytes = new Uint8Array([1, 2]);
    expect(
      await secretValueAtDispatch({ ...base, material: { type: "bytes", value: bytes } }),
    ).toBe(bytes);
    const code = await secretValueAtDispatch(
      {
        ...base,
        material: {
          type: "totp",
          params: {
            secretBase32: "JBSWY3DPEHPK3PXP",
            algorithm: "SHA1",
            digits: 6,
            periodSeconds: 30,
          },
        },
      },
      { now: () => 10_000, sleep: async () => {} },
    );
    expect(code).toMatch(/^\d{6}$/);
  });
});

describe("permissions and capability", () => {
  test("aliases map legacy names to secrets permissions", () => {
    expect(Permission.safeParse("secrets:use").success).toBe(true);
    for (const [legacy, current] of Object.entries(SECRET_PERMISSION_ALIASES)) {
      expect(Permission.safeParse(legacy).success).toBe(true);
      expect(normalizePermission(legacy)).toBe(current);
    }
    expect(normalizePermission("secrets:read")).toBe("secrets:read");
    expect(normalizePermission("sessions:read")).toBe("sessions:read");
    expect(normalizePermission("toString")).toBe("toString");
  });
  test("agents get secrets:list, use and write by default, never read", () => {
    const defaults: readonly string[] = DEFAULT_FIRST_PARTY_MCP_PERMISSIONS;
    expect(defaults).toContain("secrets:list");
    expect(defaults).toContain("secrets:use");
    expect(defaults).toContain("secrets:write");
    expect(defaults).not.toContain("secrets:read");
  });
  test("secrets capability is on by default", () => {
    expect(allAgentCapabilities().secrets).toBe(true);
  });
  test("stored configurations without secrets read as from === all (Q-17)", () => {
    const stored = (from: "all" | "none") => {
      const capabilities: Record<string, unknown> = { ...allAgentCapabilities() };
      delete capabilities.secrets;
      return {
        version: 1,
        from,
        capabilities,
        unavailable: [],
        identity: null,
        renderer: "opengeni",
        source: "request",
      };
    };
    expect(ResolvedAgentConfig.parse(stored("all")).capabilities.secrets).toBe(true);
    expect(ResolvedAgentConfig.parse(stored("none")).capabilities.secrets).toBe(false);
    const explicit = {
      ...stored("all"),
      capabilities: { ...stored("all").capabilities, secrets: false },
    };
    expect(ResolvedAgentConfig.parse(explicit).capabilities.secrets).toBe(false);
  });
});
