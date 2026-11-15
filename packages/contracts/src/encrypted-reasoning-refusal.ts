/**
 * A model provider's definitive refusal of opaque reasoning (`encrypted_content`)
 * it cannot decrypt or parse: for example ciphertext another provider, account
 * or organization issued. One text rule shared by the runtime's recovery and
 * the failed-turn presentation, so both name the same failures.
 */

/** Exact provider `error.code` for an opaque artifact the backend can no longer use. */
export const ENCRYPTED_CONTENT_REJECTION_CODE = "invalid_encrypted_content";

/**
 * True when provider error text (message, code and type joined) names an
 * encrypted reasoning artifact that could not be decrypted or parsed. Errors
 * about the request's shape that merely mention the field are excluded. Callers
 * also require the HTTP 400 that proves the request was refused before inference.
 */
export function isEncryptedReasoningRefusalText(text: string): boolean {
  const lower = text.toLowerCase();
  if (
    /(?:invalid value|supported values?|unsupported|unknown (?:field|parameter|value))/.test(lower)
  )
    return false;
  return (
    /(?:encrypted[_ ]content|encrypted reasoning|reasoning artifact)/.test(lower) &&
    /(?:decrypt(?:ed|ion)?|could not be parsed|cannot be parsed|failed to parse)/.test(lower)
  );
}
