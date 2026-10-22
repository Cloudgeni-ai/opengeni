/**
 * Secret ask-card answers on the way in. Every surface that accepts an answer
 * (the events route, `session_human_input_respond`) prepares them here: the
 * value is generated when asked for, encrypted with the vault key and sized.
 * The prepared answers go to `acceptSessionHumanInputResponse`, which writes
 * them in the accept transaction; nothing here is stored or logged.
 */
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  generatePassword,
  VAULT_LIMITS,
  type HumanInputSecretAnswer,
  type SecretPrincipal,
} from "@opengeni/contracts";
import {
  encryptEnvironmentValue,
  VaultError,
  type PreparedSecretAnswer,
  type PreparedSecretValue,
  type VaultDbContext,
} from "@opengeni/db";

export type SecretAnswerSource = "human" | "agent";

function encrypted(key: Uint8Array, plaintext: string): PreparedSecretValue {
  const valueSize = Buffer.byteLength(plaintext, "utf8");
  if (valueSize > VAULT_LIMITS.textValueMaxBytes) {
    throw new VaultError(
      "secret_value_too_large",
      `the value is larger than ${VAULT_LIMITS.textValueMaxBytes} bytes`,
      { limit: VAULT_LIMITS.textValueMaxBytes },
    );
  }
  return { valueEncrypted: encryptEnvironmentValue(key, plaintext), valueSize };
}

/**
 * Generate and encrypt write-only secret answers. Agents may only send a
 * generate spec (AC-7): a raw value from an agent is refused here, before
 * anything is written.
 */
export function prepareSecretAnswers(
  settings: Settings,
  answers: readonly HumanInputSecretAnswer[],
  source: SecretAnswerSource,
): PreparedSecretAnswer[] {
  if (answers.length === 0) return [];
  if (source === "agent" && answers.some((answer) => answer.value !== undefined)) {
    throw new SecretAnswerRejectedError(
      "An agent answers a secret question with a {{secret:...}} reference or a generate spec, never a value.",
    );
  }
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new VaultError(
      "encryption_key_missing",
      "vaults require OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY",
    );
  }
  return answers.map((answer) => {
    const generated = answer.generate !== undefined;
    const plaintext = generated ? generatePassword(answer.generate) : (answer.value ?? "");
    const username = answer.username?.trim();
    return {
      questionId: answer.questionId,
      saveTo: answer.saveTo,
      ...(answer.vaultId ? { vaultId: answer.vaultId } : {}),
      value: encrypted(key, plaintext),
      ...(username ? { username: { plain: username, ...encrypted(key, username) } } : {}),
      generated,
    };
  });
}

/** A raw value where only a reference or generate spec is allowed. */
export class SecretAnswerRejectedError extends Error {
  override readonly name = "SecretAnswerRejectedError";
}

/** The vault authority that writes a person's answers. */
export function humanSecretWriteContext(input: {
  accountId: string;
  workspaceId: string;
  subjectId: string;
}): VaultDbContext {
  return {
    kind: "subject",
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
  };
}

/** The vault authority that writes an agent attempt's generated answers. */
export function attemptSecretWriteContext(
  principal: Extract<SecretPrincipal, { kind: "attempt" }>,
): VaultDbContext {
  return { kind: "principal", principal };
}

/**
 * Separate the write-only secret answers from a submitted response. They may
 * arrive inside the response (the documented shape) or next to it on the
 * event payload; both are merged and removed from what gets stored.
 */
export function splitSecretAnswers<T>(
  response: T,
  besideResponse: readonly HumanInputSecretAnswer[] | undefined,
): { response: T; secretAnswers: HumanInputSecretAnswer[] } {
  const inside =
    response && typeof response === "object" && "secretAnswers" in response
      ? ((response as { secretAnswers?: HumanInputSecretAnswer[] }).secretAnswers ?? [])
      : [];
  if (!response || typeof response !== "object" || !("secretAnswers" in response)) {
    return { response, secretAnswers: [...(besideResponse ?? [])] };
  }
  const { secretAnswers: _writeOnly, ...rest } = response as T & { secretAnswers?: unknown };
  return { response: rest as T, secretAnswers: [...inside, ...(besideResponse ?? [])] };
}
