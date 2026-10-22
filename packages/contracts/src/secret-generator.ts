import { defineSchema } from "./define-schema";
/**
 * The one password generator shared by agents (`secret_save` with
 * `generate`), the ask card's server-side generate, and the web/mobile UI.
 *
 * Isomorphic and dependency-free: randomness comes from
 * `crypto.getRandomValues` unless a test injects `random`. Output is ASCII
 * only, and every character is drawn uniformly from the selected alphabet by
 * rejection sampling, so no modulo bias is introduced. When
 * `requireEachClass` is set, whole candidates lacking an enabled class are
 * rejected and redrawn, which keeps the result uniform over all compliant
 * passwords.
 */
import { z } from "zod";

export const SECRET_GENERATOR_DEFAULT_SYMBOLS = "!#%+-.:=?@_";
/** Characters that are easy to confuse when a person reads them. */
export const SECRET_GENERATOR_AMBIGUOUS_CHARACTERS = "0O1lI|";

const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";

function isPrintableAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

export const GeneratePasswordSpec = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      length: z.number().int().min(8).max(128).default(24),
      lowercase: z.boolean().default(true),
      uppercase: z.boolean().default(true),
      digits: z.boolean().default(true),
      symbols: z.boolean().default(true),
      // No quotes, $, `, \, braces, /, &, ; or | by default: generated values
      // stay safe to paste into shells, URLs and config files.
      symbolSet: z
        .string()
        .min(1)
        .max(64)
        .refine(isPrintableAscii, "symbolSet must be printable ASCII without spaces")
        .default(SECRET_GENERATOR_DEFAULT_SYMBOLS),
      excludeAmbiguous: z.boolean().default(true),
      requireEachClass: z.boolean().default(true),
    })
    .strict()
    .refine(
      (spec) => spec.lowercase || spec.uppercase || spec.digits || spec.symbols,
      "at least one character class must be enabled",
    ),
);
export type GeneratePasswordSpec = z.infer<typeof GeneratePasswordSpec>;
export type GeneratePasswordSpecInput = z.input<typeof GeneratePasswordSpec>;

export class PasswordGeneratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordGeneratorError";
  }
}

function defaultRandom(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function uniqueCharacters(value: string): string {
  return [...new Set(value)].join("");
}

/** The enabled character classes after exclusions; empty classes are dropped. */
export function passwordCharacterClasses(spec: GeneratePasswordSpec): string[] {
  const ambiguous = spec.excludeAmbiguous ? new Set(SECRET_GENERATOR_AMBIGUOUS_CHARACTERS) : null;
  const strip = (alphabet: string) =>
    uniqueCharacters(alphabet)
      .split("")
      .filter((character) => !ambiguous?.has(character))
      .join("");
  const classes: string[] = [];
  if (spec.lowercase) classes.push(strip(LOWERCASE));
  if (spec.uppercase) classes.push(strip(UPPERCASE));
  if (spec.digits) classes.push(strip(DIGITS));
  if (spec.symbols) classes.push(strip(spec.symbolSet));
  return classes.filter((characters) => characters.length > 0);
}

/** Draws `count` uniform indexes in `[0, size)` by rejection sampling bytes. */
function uniformIndexes(count: number, size: number, random: (n: number) => Uint8Array): number[] {
  if (size < 1 || size > 256) throw new PasswordGeneratorError("alphabet size out of range");
  const limit = 256 - (256 % size);
  const out: number[] = [];
  let guard = 0;
  while (out.length < count) {
    const bytes = random(Math.max(16, (count - out.length) * 2));
    for (const byte of bytes) {
      if (byte < limit) out.push(byte % size);
      if (out.length === count) break;
    }
    guard += 1;
    if (guard > 10_000) throw new PasswordGeneratorError("random source is not producing entropy");
  }
  return out;
}

/** Generate a password. The spec input is parsed (defaults applied) first. */
export function generatePassword(
  spec?: GeneratePasswordSpecInput,
  random: (n: number) => Uint8Array = defaultRandom,
): string {
  const parsed = GeneratePasswordSpec.parse(spec ?? {});
  const classes = passwordCharacterClasses(parsed);
  if (classes.length === 0) throw new PasswordGeneratorError("no characters available");
  const alphabet = uniqueCharacters(classes.join(""));
  const requireClasses = parsed.requireEachClass ? classes : [];
  if (requireClasses.length > parsed.length) {
    throw new PasswordGeneratorError("length is shorter than the number of required classes");
  }
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const password = uniformIndexes(parsed.length, alphabet.length, random)
      .map((index) => alphabet[index]!)
      .join("");
    if (requireClasses.every((characters) => [...password].some((c) => characters.includes(c)))) {
      return password;
    }
  }
  throw new PasswordGeneratorError("could not satisfy the character class requirements");
}

export type PasswordStrengthLabel = "weak" | "fair" | "strong" | "very_strong";

/**
 * Estimated entropy from length and the character pools the password uses.
 * A display hint for the UI, not a security decision.
 */
export function passwordStrength(password: string): {
  bits: number;
  label: PasswordStrengthLabel;
} {
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 33;
  const length = [...password].length;
  const bits = pool === 0 ? 0 : Math.round(length * Math.log2(pool) * 10) / 10;
  const label: PasswordStrengthLabel =
    bits < 40 ? "weak" : bits < 60 ? "fair" : bits < 100 ? "strong" : "very_strong";
  return { bits, label };
}
