import { type TotpParams, VAULT_LIMITS } from "./contract";

// Mirrors contracts isValidSecretName (Q-10): no / { } # \ or control chars,
// trimmed, 1..120 chars, not "id:…"; field names additionally may not be "otp".
const FORBIDDEN_NAME_CHARS = /[/{}#\\\u0000-\u001f\u007f-\u009f]/g;

export function nameKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

export function safeSecretName(raw: string, fallback: string): string {
  const max = VAULT_LIMITS.nameMaxChars;
  let name = raw.replace(FORBIDDEN_NAME_CHARS, "-").trim().slice(0, max).trim();
  if (!name) name = fallback.replace(FORBIDDEN_NAME_CHARS, "-").trim().slice(0, max) || "item";
  if (/^id:/i.test(name)) name = `id-${name.slice(3)}`;
  return name;
}

export function safeFieldName(raw: string, fallback: string): string {
  const name = safeSecretName(raw, fallback);
  return nameKey(name) === "otp" ? "otp-code" : name;
}

/** Appends " (2)", " (3)" … so names are unique case-insensitively. */
export function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(nameKey(candidate)); n += 1) {
    const suffix = ` (${n})`;
    candidate = `${name.slice(0, VAULT_LIMITS.nameMaxChars - suffix.length)}${suffix}`;
  }
  taken.add(nameKey(candidate));
  return candidate;
}

/** A canonical otpauth URI for a parsed seed, for stores that require URIs. */
export function totpUri(params: TotpParams, label: string): string {
  const query = new URLSearchParams({
    secret: params.secretBase32,
    algorithm: params.algorithm,
    digits: String(params.digits),
    period: String(params.periodSeconds),
  });
  return `otpauth://totp/${encodeURIComponent(label || "Opengeni")}?${query.toString()}`;
}
