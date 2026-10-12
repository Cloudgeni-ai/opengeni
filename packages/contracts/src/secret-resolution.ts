/**
 * Secret resolver contract (dossier §10B.1.3). Types live here; the hosted
 * implementation is `createSecretResolver` in `@opengeni/core` and a static
 * stub is `createStaticSecretResolver` in `@opengeni/vaults/testing`.
 *
 * Invariants: a call resolves all of its references or fails before
 * dispatch (I2); plaintext only ever lives in `ResolvedSecretValue.material`
 * and in delivery locals (I1); TOTP codes are computed at dispatch (I4).
 */
import type { RequestHumanInputToolInput } from "./index";
import { parseSecretReference, secretNameKey, type SecretReference } from "./secret-references";
import { totpCodeAtDispatch, type SecretClock, type TotpParams } from "./secret-totp";
import type { VaultSource } from "./vaults";

export type SecretPrincipal =
  | {
      kind: "attempt";
      accountId: string;
      workspaceId: string;
      sessionId: string;
      turnId: string;
      attemptId: string;
      executionGeneration: number;
    }
  | {
      kind: "site_viewer";
      accountId: string;
      workspaceId: string;
      subjectId: string;
      siteId: string;
      siteVersion: string;
    }
  | {
      kind: "human";
      accountId: string;
      workspaceId: string;
      subjectId: string;
      verifiedHuman: boolean;
      viaApiKey: boolean;
    };

export const SECRET_USE_SURFACES = [
  "shell",
  "stdin",
  "file_write",
  "secretfile",
  "view_image",
  "run_on",
  "mcp",
  "codemode",
  "site",
  "browser",
  "desktop",
  "human_reveal",
] as const;
export type SecretUseSurface = (typeof SECRET_USE_SURFACES)[number];
export interface SecretUseContext {
  surface: SecretUseSurface;
  toolName: string;
  operationId?: string;
  sourceCallId?: string;
}

export type SecretMaterial =
  | { type: "text"; value: string }
  /** File fields. */
  | { type: "bytes"; value: Uint8Array }
  /** The code is computed at dispatch (I4). */
  | { type: "totp"; params: TotpParams };

export interface ResolvedSecretValue {
  /** `referenceKey(reference)` */
  key: string;
  reference: SecretReference;
  source: VaultSource;
  vaultId: string;
  vaultName: string;
  itemId: string;
  itemName: string;
  fieldId: string | null;
  fieldName: string;
  version: number | null;
  material: SecretMaterial;
}

export interface SecretResolver {
  readonly principal: SecretPrincipal;
  /** false when agent.capabilities.secrets is off: adapters must pass references through literally (Q-35). */
  readonly enabled: boolean;
  /** All-or-nothing (I2). Throws SecretReferenceError. Keys are referenceKey(ref). */
  resolve(
    refs: readonly SecretReference[],
    use: SecretUseContext,
  ): Promise<Map<string, ResolvedSecretValue>>;
}

export const SECRET_REFERENCE_FAILURE_CODES = [
  "invalid_reference",
  "not_found",
  "ambiguous",
  "denied",
  "no_primary_field",
  "provider_unavailable",
  "provider_rate_limited",
  "provider_auth_expired",
  "too_large",
  "binary_value",
  "unsupported_shell",
  "secretfile_not_allowed",
] as const;
export type SecretReferenceFailureCode = (typeof SECRET_REFERENCE_FAILURE_CODES)[number];

export interface SecretReferenceFailure {
  raw: string;
  code: SecretReferenceFailureCode;
  message: string;
  /** ambiguous: ready references to choose from (Q-49). */
  candidates?: string[];
}

export const SECRET_REFERENCE_ERROR_CODE = "secret_reference_error" as const;

function failureHint(
  failures: readonly SecretReferenceFailure[],
  askCard: RequestHumanInputToolInput | null,
): string {
  const hints: string[] = [];
  if (askCard !== null) {
    hints.push(
      "Nothing was run. A secret is missing: call request_human_input with askCard exactly as given, then retry with the returned references.",
    );
  }
  if (failures.some((failure) => failure.code === "ambiguous")) {
    hints.push("Nothing was run. Retry with one of the candidate references.");
  }
  if (failures.some((failure) => failure.code === "invalid_reference")) {
    hints.push(
      "Nothing was run. Fix the reference syntax: {{secret:Item}}, {{secret:Item/field}}, {{secret:Vault/Item/field}}, {{secret:id:<uuid>}}, optional /otp and #previous. Escape a literal reference as \\{{secret:…}}.",
    );
  }
  if (hints.length === 0) hints.push("Nothing was run. See each failure's message.");
  return hints.join(" ");
}

/** Thrown by `SecretResolver.resolve` and by delivery adapters before dispatch. */
export class SecretReferenceError extends Error {
  readonly code = SECRET_REFERENCE_ERROR_CODE;
  readonly failures: SecretReferenceFailure[];
  readonly askCard: RequestHumanInputToolInput | null;

  constructor(
    failures: SecretReferenceFailure[],
    askCard: RequestHumanInputToolInput | null = null,
  ) {
    const first = failures[0];
    super(
      first === undefined
        ? "secret reference error"
        : `${first.code}: ${first.message}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ""}`,
    );
    this.name = "SecretReferenceError";
    this.failures = failures;
    this.askCard = askCard;
  }

  /** JSON string for tool output: {error, failures, askCard, hint}. Never contains values. */
  toModelOutput(): string {
    return JSON.stringify({
      error: this.code,
      failures: this.failures.map((failure) => ({
        raw: failure.raw,
        code: failure.code,
        message: failure.message,
        ...(failure.candidates ? { candidates: failure.candidates } : {}),
      })),
      askCard: this.askCard,
      hint: failureHint(this.failures, this.askCard),
    });
  }
}

export function isSecretReferenceError(error: unknown): error is SecretReferenceError {
  return (
    error instanceof SecretReferenceError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === SECRET_REFERENCE_ERROR_CODE &&
      Array.isArray((error as { failures?: unknown }).failures))
  );
}

/** Materialize at dispatch: text/bytes as-is; TOTP via totpCodeAtDispatch (waits when < 3 s remain). */
export async function secretValueAtDispatch(
  v: ResolvedSecretValue,
  clock?: SecretClock,
): Promise<string | Uint8Array> {
  switch (v.material.type) {
    case "text":
      return v.material.value;
    case "bytes":
      return v.material.value;
    case "totp":
      return (await totpCodeAtDispatch(v.material.params, clock)).code;
  }
}

const TEXT_FIELD_NAMES = new Set(["username", "user", "email", "login", "account"]);

/**
 * The ready-made ask card for `not_found` failures (§10B.1.3, D11): one
 * secret question per missing item. Path references name the item in their
 * last item segment (`Item`, `Item/field` read as Item/field, `Vault/Item/field`);
 * ID references cannot be asked for by name and are skipped. Returns null
 * when nothing can be asked. The model submits it unchanged.
 */
export function buildMissingSecretAskCard(
  failures: readonly SecretReferenceFailure[],
  ctx: { hasActingHuman: boolean },
): RequestHumanInputToolInput | null {
  const saveTo = ctx.hasActingHuman ? "user" : "workspace";
  const questions: RequestHumanInputToolInput["questions"] = [];
  const seen = new Set<string>();
  for (const failure of failures) {
    if (failure.code !== "not_found") continue;
    let reference: SecretReference;
    try {
      reference = parseSecretReference(failure.raw);
    } catch {
      continue;
    }
    if (reference.target.form !== "path") continue;
    const segments = reference.target.segments;
    const item = segments.length === 3 ? segments[1] : segments[0];
    const requestedField = segments.length === 3 ? segments[2] : segments[1];
    const totp = reference.otp && requestedField === undefined;
    const field = requestedField ?? (totp ? "totp" : "password");
    const key = `${secretNameKey(item)}/${secretNameKey(field)}`;
    if (seen.has(key) || questions.length >= 20) continue;
    seen.add(key);
    const fieldKind =
      totp || reference.otp
        ? "totp"
        : TEXT_FIELD_NAMES.has(secretNameKey(field))
          ? "text"
          : "concealed";
    const prompt =
      fieldKind === "totp"
        ? `Enter the two-factor setup key (or otpauth link) for ${item}. It is saved to a vault, never shown in chat.`
        : `Enter the ${field} for ${item}. It is saved to a vault, never shown in chat.`;
    questions.push({
      id: `secret_${questions.length + 1}`,
      kind: "secret",
      prompt,
      label: item.slice(0, 128),
      helpText: null,
      skillReview: null,
      options: [],
      required: true,
      allowOther: false,
      validation: null,
      secret: {
        item,
        field,
        fieldKind,
        itemType: "login",
        saveTo,
        allowGenerate: false,
        autocomplete: fieldKind === "concealed" ? "current-password" : "off",
      },
    });
  }
  if (questions.length === 0) return null;
  return { questions, allowSkip: true, expiresInSeconds: null };
}
