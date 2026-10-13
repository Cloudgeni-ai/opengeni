import type { GeneratePasswordSpec } from "@opengeni/sdk";
import { createContext, useContext, type ReactNode } from "react";

/**
 * Secret-reference token shapes (structural mirror of `@opengeni/contracts`
 * `SecretTextToken`). @opengeni/react may not depend on the contracts
 * runtime, so hosts inject the one tokenizer and generator through
 * `SecretsUiProvider`.
 */
export type SecretReferenceTargetLike =
  | { form: "id"; itemId: string; field: string | null }
  | { form: "path"; segments: readonly string[] };

export type SecretReferenceLike = {
  kind: "secret" | "secretfile";
  raw: string;
  start: number;
  end: number;
  target: SecretReferenceTargetLike;
  otp: boolean;
  previous: boolean;
};

export type SecretTextTokenLike =
  | { type: "text"; value: string }
  | { type: "reference"; reference: SecretReferenceLike }
  | { type: "invalid"; raw: string; start: number; end: number; reason: string };

export type PasswordStrengthLike = {
  bits: number;
  label: "weak" | "fair" | "strong" | "very_strong";
};

export type SecretsUi = {
  /** Split text into plain text, references and invalid reference-looking text. */
  tokenize: (text: string) => SecretTextTokenLike[];
  /** Client-side password generator (same implementation as the server). */
  generatePassword: (spec?: GeneratePasswordSpec) => string;
  passwordStrength?: ((password: string) => PasswordStrengthLike) | undefined;
  /** Optional link target for a reference chip (for example the item page). */
  hrefForReference?: ((reference: SecretReferenceLike) => string | null) | undefined;
};

const SecretsUiContext = createContext<SecretsUi | null>(null);

export function SecretsUiProvider({
  value,
  children,
}: {
  value: SecretsUi | null;
  children?: ReactNode;
}) {
  return <SecretsUiContext.Provider value={value}>{children}</SecretsUiContext.Provider>;
}

/** Null without a provider: chips render as plain text, Generate is server-side. */
export function useSecretsUi(): SecretsUi | null {
  return useContext(SecretsUiContext);
}
