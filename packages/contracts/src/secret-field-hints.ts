/**
 * Whether a name or a plain value looks like a credential (docs/secrets.md,
 * Field kinds). Used to nudge, never to block: a value saved in a plain
 * (`text`) field is shown and searched as written, so a token pasted there by
 * mistake is exposed. Callers suggest or default to `concealed` instead.
 *
 * Pure and isomorphic: the web item editor, the vault service and the agent
 * runtime use the same rules.
 */
import { credentialNameSaysSecret, credentialNameWords } from "./credential-names";
import { detectSecretShapes, SECRET_SHAPE_KINDS } from "./secret-shape-masking";
import { secretValueEntropyBits, secretValueStrength } from "./secret-value-masking";

/** Identifiers of a credential, which are not the credential: `api key id`, `key number`. */
const IDENTIFIER_LAST_WORD = /^(?:ids?|number|no|fingerprint|hint|label)$/iu;

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
    const words = credentialNameWords(typeof fieldName === "string" ? fieldName : "");
    const last = words[words.length - 1];
    // A fingerprint or key id is random but identifies a key; it is not one.
    const identifier = last !== undefined && IDENTIFIER_LAST_WORD.test(last);
    if (!identifier && looksRandomSecret(text)) {
      return { reason: "random", message: "Looks like a key or password." };
    }
    if (
      last &&
      !identifier &&
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
