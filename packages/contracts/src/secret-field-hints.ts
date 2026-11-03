/**
 * Whether a name or a plain value looks like a credential (docs/secrets.md,
 * Field kinds). Used to nudge, never to block: a value saved in a plain
 * (`text`) field is shown and searched as written, so a token pasted there by
 * mistake is exposed. Callers suggest or default to `concealed` instead.
 *
 * Pure and isomorphic: the web item editor, the vault service and the agent
 * runtime use the same rules.
 */
import { detectSecretShapes, SECRET_SHAPE_KINDS } from "./secret-shape-masking";
import { secretValueEntropyBits, secretValueStrength } from "./secret-value-masking";

/** A word of a variable, header or field name that says it holds a credential. */
const SECRET_NAME_WORD =
  /^(?:tokens?|secrets?|password|passwd|passphrase|pass|pwd|keys?|apikey|credentials?|creds|auth|authorization|session|cookies?|bearer|private|signature|jwt)$/iu;
/** A compound word that ends with one: `PGPASSWORD`, `ACCESSKEY`, `AUTHTOKEN`, `CLIENTSECRET`. */
const SECRET_NAME_SUFFIX = /(?:token|secret|password|passwd|key|cookie|signature)$/iu;
/**
 * The last word says the value names, locates or describes something:
 * `GIT_AUTHOR_NAME`, `SESSION_NAME`, `TOKEN_ENDPOINT`, `KEY_ALGORITHM`.
 */
const NON_SECRET_LAST_WORD =
  /^(?:names?|user|username|email|host|hostname|url|uri|endpoint|region|path|file|dir|type|kind|mode|version|header|prefix|scopes?|expiry|expires|expiration|ttl|timeout|length|format|algorithm|issuer|audience|domain|port|method|provider|scheme|strategy)$/iu;
/** Identifiers of a credential, which are not the credential: `api key id`, `key number`. */
const IDENTIFIER_LAST_WORD = /^(?:ids?|number|no|fingerprint|hint|label)$/iu;

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter((word) => word.length > 0);
}

/**
 * Whether a variable or header name says its value is a credential, word by
 * word (`_`, `-`, `.`, spaces and camelCase separate words), so `AUTH` does
 * not match inside `GIT_AUTHOR_NAME` and `SESSION_NAME` names a session.
 */
export function credentialNameSaysSecret(name: string): boolean {
  if (typeof name !== "string") return false;
  const words = nameWords(name);
  if (words.length === 0) return false;
  if (NON_SECRET_LAST_WORD.test(words[words.length - 1]!)) return false;
  return words.some(
    (word) => SECRET_NAME_WORD.test(word) || (word.length > 4 && SECRET_NAME_SUFFIX.test(word)),
  );
}

export type PlainFieldSecretHint = {
  /** `format`: a known token or key format; `random`: a long random value; `name`: the field's name. */
  reason: "format" | "random" | "name";
  /** One short sentence for a person, such as "Looks like a GitHub token." */
  message: string;
};

/** Minimum length and estimated bits of a random-looking plain value. */
const RANDOM_MIN_CHARS = 20;
const RANDOM_MIN_BITS = 80;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Values that locate or name something, however random they look. */
const LOCATOR = /\s|:\/\/|@|^[/~.]|^[A-Za-z]:\\/u;

const DISPLAY_WORDS: Readonly<Record<string, string>> = {
  github: "GitHub",
  gitlab: "GitLab",
  openai: "OpenAI",
  anthropic: "Anthropic",
  aws: "AWS",
  azure: "Azure",
  sas: "SAS",
  jwt: "JWT",
  url: "URL",
  google: "Google",
  oauth: "OAuth",
  slack: "Slack",
  stripe: "Stripe",
  opengeni: "Opengeni",
  "1password": "1Password",
  hugging: "Hugging",
  face: "Face",
  sendgrid: "SendGrid",
  shopify: "Shopify",
  pypi: "PyPI",
  databricks: "Databricks",
  digitalocean: "DigitalOcean",
  linear: "Linear",
  doppler: "Doppler",
  atlassian: "Atlassian",
  api: "API",
};

function displayLabel(label: string): string {
  return label
    .split(" ")
    .map((word) => DISPLAY_WORDS[word] ?? word)
    .join(" ");
}

function withArticle(phrase: string): string {
  const vowelSound = /^[aeiouAEIO]/u.test(phrase) && !/^(?:URL|one)\b/u.test(phrase);
  return `${vowelSound ? "an" : "a"} ${phrase}`;
}

function characterClasses(value: string): number {
  return (
    Number(/[a-z]/u.test(value)) +
    Number(/[A-Z]/u.test(value)) +
    Number(/[0-9]/u.test(value)) +
    Number(/[^A-Za-z0-9]/u.test(value))
  );
}

/** A value that reads as random key material rather than a name or an identifier. */
export function looksRandomSecret(value: string): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (text.length < RANDOM_MIN_CHARS || LOCATOR.test(text) || UUID.test(text)) return false;
  if (characterClasses(text) < 3) return false;
  if (secretValueStrength(text) !== "distinctive") return false;
  return secretValueEntropyBits(text) >= RANDOM_MIN_BITS;
}

/**
 * Why a value saved in a plain field (named `fieldName`) probably belongs in
 * a concealed one, or `null`. Only the field name and fixed labels appear in
 * the result, never the value. Never throws.
 */
export function plainFieldSecretHint(
  fieldName: string,
  value: string | null | undefined,
): PlainFieldSecretHint | null {
  try {
    const text = typeof value === "string" ? value.trim() : "";
    if (text.length === 0) return null;
    const [shape] = detectSecretShapes(text);
    if (shape) {
      const label = displayLabel(SECRET_SHAPE_KINDS[shape.kind]?.label ?? "secret");
      const contains = shape.start > 0 || shape.end < text.length;
      return {
        reason: "format",
        message: contains ? `Contains ${withArticle(label)}.` : `Looks like ${withArticle(label)}.`,
      };
    }
    if (looksRandomSecret(text)) {
      return { reason: "random", message: "Looks like a key or password." };
    }
    const words = nameWords(typeof fieldName === "string" ? fieldName : "");
    const last = words[words.length - 1];
    if (
      last &&
      !IDENTIFIER_LAST_WORD.test(last) &&
      !words.some((word) => /^public$/iu.test(word)) &&
      credentialNameSaysSecret(fieldName)
    ) {
      return { reason: "name", message: "The field name suggests a secret." };
    }
    return null;
  } catch {
    return null;
  }
}
