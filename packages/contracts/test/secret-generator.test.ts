import { describe, expect, test } from "bun:test";
import {
  GeneratePasswordSpec,
  generatePassword,
  passwordCharacterClasses,
  passwordStrength,
  SECRET_GENERATOR_AMBIGUOUS_CHARACTERS,
} from "../src/index";

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let index = 0; index < n; index += 1) {
      state = (state ^ (state << 13)) >>> 0;
      state = (state ^ (state >>> 17)) >>> 0;
      state = (state ^ (state << 5)) >>> 0;
      out[index] = state & 0xff;
    }
    return out;
  };
}

describe("password generator", () => {
  test("defaults: 24 ASCII characters with every class and no ambiguous characters", () => {
    for (let run = 0; run < 200; run += 1) {
      const password = generatePassword();
      expect(password).toHaveLength(24);
      expect(/^[\x21-\x7e]+$/.test(password)).toBe(true);
      expect(/[a-z]/.test(password)).toBe(true);
      expect(/[A-Z]/.test(password)).toBe(true);
      expect(/[0-9]/.test(password)).toBe(true);
      expect(/[!#%+\-.:=?@_]/.test(password)).toBe(true);
      for (const ambiguous of SECRET_GENERATOR_AMBIGUOUS_CHARACTERS) {
        expect(password.includes(ambiguous)).toBe(false);
      }
    }
  });

  test("never emits shell-hostile characters by default", () => {
    const joined = Array.from({ length: 200 }, () => generatePassword({ length: 64 })).join("");
    expect(/["'`$\\{}/&;| ]/.test(joined)).toBe(false);
  });

  test("respects length and class settings", () => {
    expect(generatePassword({ length: 8 })).toHaveLength(8);
    expect(generatePassword({ length: 128 })).toHaveLength(128);
    expect(
      /^[0-9]+$/.test(
        generatePassword({ lowercase: false, uppercase: false, symbols: false, length: 12 }),
      ),
    ).toBe(true);
    expect(
      /^[a-z]+$/.test(generatePassword({ uppercase: false, digits: false, symbols: false })),
    ).toBe(true);
    expect(/^[a-zA-Z0-9*]+$/.test(generatePassword({ symbolSet: "*" }))).toBe(true);
    const withAmbiguous = Array.from({ length: 300 }, () =>
      generatePassword({ excludeAmbiguous: false, symbols: false, length: 32 }),
    ).join("");
    expect(/[0O1lI]/.test(withAmbiguous)).toBe(true);
  });

  test("rejects invalid specs", () => {
    expect(() => generatePassword({ length: 7 })).toThrow();
    expect(() => generatePassword({ length: 129 })).toThrow();
    expect(() =>
      generatePassword({ lowercase: false, uppercase: false, digits: false, symbols: false }),
    ).toThrow();
    expect(() => generatePassword({ symbolSet: "a b" })).toThrow();
    expect(() => generatePassword({ symbolSet: "€" })).toThrow();
    expect(GeneratePasswordSpec.safeParse({ unknown: true }).success).toBe(false);
  });

  test("deterministic with an injected random source", () => {
    expect(generatePassword({}, seededRandom(7))).toBe(generatePassword({}, seededRandom(7)));
    expect(generatePassword({}, seededRandom(7))).not.toBe(generatePassword({}, seededRandom(8)));
  });

  test("uniformity: chi-square over 100k characters (p > 0.001)", () => {
    const spec = GeneratePasswordSpec.parse({ requireEachClass: false, length: 100 });
    const alphabet = [...new Set(passwordCharacterClasses(spec).join(""))];
    const counts = new Map(alphabet.map((character) => [character, 0]));
    const random = seededRandom(12345);
    for (let run = 0; run < 1_000; run += 1) {
      for (const character of generatePassword(spec, random)) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }
    const total = 100_000;
    const expected = total / alphabet.length;
    let chiSquare = 0;
    for (const count of counts.values()) chiSquare += (count - expected) ** 2 / expected;
    const df = alphabet.length - 1;
    // Wilson–Hilferty critical value for p = 0.001 (z = 3.0902).
    const critical = df * (1 - 2 / (9 * df) + 3.0902 * Math.sqrt(2 / (9 * df))) ** 3;
    expect(counts.size).toBe(alphabet.length);
    expect(chiSquare).toBeLessThan(critical);
  });

  test("strength labels", () => {
    expect(passwordStrength("abc").label).toBe("weak");
    expect(passwordStrength("abcdefghijkl").label).toBe("fair");
    expect(passwordStrength("Abcdefgh1234").label).toBe("strong");
    expect(passwordStrength(generatePassword()).label).toBe("very_strong");
    expect(passwordStrength("").bits).toBe(0);
  });
});
