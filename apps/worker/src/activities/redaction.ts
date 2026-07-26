const MIN_REDACTABLE_VALUE_LENGTH = 6;

export type SecretForRedaction = {
  name: string;
  value: string;
};

/**
 * Defense-in-depth against an agent echoing injected workspace environment
 * values (for example via `env`) into session events. Deep-walks payloads and
 * replaces every exact occurrence of each secret value with
 * `[redacted:<NAME>]`. Values shorter than six characters are skipped to avoid
 * a false-positive flood; secrets are applied longest-value-first so
 * overlapping values redact deterministically.
 */
export function createSecretRedactor(secrets: SecretForRedaction[]): (payload: unknown) => unknown {
  const usable = secrets
    .filter((secret) => secret.value.length >= MIN_REDACTABLE_VALUE_LENGTH)
    .sort((a, b) => b.value.length - a.value.length);
  if (usable.length === 0) {
    return identityRedactor;
  }
  const redact = (payload: unknown): unknown => {
    if (typeof payload === "string") {
      let out = payload;
      for (const secret of usable) {
        if (out.includes(secret.value)) {
          out = out.split(secret.value).join(`[redacted:${secret.name}]`);
        }
      }
      return out;
    }
    if (Array.isArray(payload)) {
      return payload.map(redact);
    }
    if (isPlainObject(payload)) {
      return Object.fromEntries(
        Object.entries(payload).map(([key, value]) => [key, redact(value)]),
      );
    }
    return payload;
  };
  return redact;
}

export function identityRedactor(payload: unknown): unknown {
  return payload;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
