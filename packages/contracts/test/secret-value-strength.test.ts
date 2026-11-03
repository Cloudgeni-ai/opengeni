/**
 * Known-value masking by strength (docs/secrets.md, Matching): a weak saved
 * value (a dictionary word, a word with digits, a host) is replaced only in a
 * credential position, so file names, imports, identifiers, hosts and URL
 * paths that merely contain the word stay readable. Distinctive values
 * (tokens, random passwords) are replaced everywhere, in every form, as
 * before. Every value here is fake and assembled at runtime.
 */
import { describe, expect, test } from "bun:test";
import {
  compileSecretValueMasks,
  maskSecretShapesInText,
  maskSecretValuesInText,
  SecretValueMemory,
  secretValueStrength,
  type SecretValueMatchEvent,
} from "../src";

const ref = (path: string) => `\u007B\u007Bsecret:${path}}}`;
const LABEL = ref("Fake Vault/fake-db/password");
// A dictionary word, as a weak saved password or username would be.
const WORD = ["harbor", "master"].join("");
const DISTINCTIVE = ["Zq8", "vR2", "xW9", "pL4", "mT7", "kB1", "nY6"].join("");
const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const scheme = (name: string) => `${name}://`;

function memoryWith(value: string, options: { weakValues?: "anywhere" } = {}) {
  const memory = new SecretValueMemory(options);
  memory.remember(value, LABEL);
  return memory;
}

describe("value strength", () => {
  test("words, words with digits, short values, hosts and emails are weak", () => {
    for (const value of [
      WORD,
      `${WORD}2024`,
      `${WORD[0]!.toUpperCase()}${WORD.slice(1)}1!`,
      WORD.toUpperCase(),
      "abcdefgh",
      `${WORD}.example.com`,
      `${WORD}@example.com`,
      `/srv/${WORD}/data`,
      "aaaaaaaaaaaaaaaaaaaa",
    ]) {
      expect([value, secretValueStrength(value)]).toEqual([value, "weak"]);
    }
  });

  test("tokens, random passwords and digit-only values are distinctive", () => {
    for (const value of [
      DISTINCTIVE,
      "Tr0ub4dor&3",
      `ghp_${DISTINCTIVE}${DISTINCTIVE}`,
      "4111111111111111",
      `https://hooks.example.com/services/${DISTINCTIVE}`,
    ]) {
      expect([value, secretValueStrength(value)]).toEqual([value, "distinctive"]);
    }
  });
});

describe("a weak saved value", () => {
  test("does not alter paths, imports, identifiers, hosts or URL paths", () => {
    const memory = memoryWith(WORD);
    const unchanged = [
      `src/${WORD}/config.ts`,
      `packages/${WORD}-client/src/index.ts`,
      `import { ${WORD}Client } from "./${WORD}-client";`,
      `const ${WORD}_timeout = 30;`,
      `class ${WORD[0]!.toUpperCase()}${WORD.slice(1)}Service {}`,
      `ssh deploy@${WORD}.example.com`,
      `https://example.com/${WORD}/releases?tag=${WORD}-v2`,
      `C:\\Users\\${WORD}\\AppData`,
      `git log --author=${WORD}`,
      `{"path":"docs/${WORD}.md","name":"${WORD}-notes"}`,
      `The ${WORD} role owns the pipeline.`,
    ];
    for (const text of unchanged) expect(memory.maskText(text)).toBe(text);
  });

  test("is still masked in credential positions", () => {
    const memory = memoryWith(WORD);
    const cases: Array<[string, string]> = [
      [`password=${WORD}`, `password=${LABEL}`],
      [`PGPASSWORD: ${WORD}`, `PGPASSWORD: ${LABEL}`],
      [`export DB_PASS="${WORD}"`, `export DB_PASS="${LABEL}"`],
      [JSON.stringify({ password: WORD }), JSON.stringify({ password: LABEL })],
      [`${WORD}\n`, `${LABEL}\n`],
      [`login ok\n${WORD}\nnext`, `login ok\n${LABEL}\nnext`],
      [
        `${scheme("mysql")}app:${WORD}@db.internal:3306/app`,
        `${scheme("mysql")}app:${LABEL}@db.internal:3306/app`,
      ],
    ];
    for (const [text, masked] of cases) expect(memory.maskText(text)).toBe(masked);
    // Inside a base64 run (Basic auth): the encoded value is replaced in the run.
    const basic = `Authorization: Basic ${base64(`app:${WORD}`)}`;
    expect(memory.maskText(basic)).toContain(LABEL);
    expect(memory.maskText(basic)).not.toBe(basic);
  });

  test("is masked anywhere when the caller asks (the history scrub and typed values)", () => {
    const memory = memoryWith(WORD, { weakValues: "anywhere" });
    expect(memory.maskText(`src/${WORD}/config.ts`)).toBe(`src/${LABEL}/config.ts`);
  });

  test("inside a URL or connection string is still caught by the shape detectors", () => {
    const url = `${scheme("mysql")}app:${WORD}@db.internal:3306/app`;
    expect(maskSecretShapesInText(url)).toBe(
      `${scheme("mysql")}app:[masked url password]@db.internal:3306/app`,
    );
    const connection = `Server=db;User Id=app;Password=${WORD};Database=app`;
    expect(maskSecretShapesInText(connection)).toBe(
      "Server=db;User Id=app;Password=[masked connection string password];Database=app",
    );
  });
});

describe("a distinctive saved value", () => {
  test("is masked everywhere it was before, in every form", () => {
    const memory = memoryWith(DISTINCTIVE);
    const cases: Array<[string, string]> = [
      [`src/${DISTINCTIVE}/config.ts`, `src/${LABEL}/config.ts`],
      [`const x${DISTINCTIVE}y = 1;`, `const x${LABEL}y = 1;`],
      [`https://example.com/${DISTINCTIVE}?a=1`, `https://example.com/${LABEL}?a=1`],
      [`b64 ${base64(DISTINCTIVE)}`, `b64 ${LABEL}`],
      [`q=${encodeURIComponent(`${DISTINCTIVE}/+`)}`, `q=${LABEL}%2F%2B`],
    ];
    for (const [text, masked] of cases) expect(memory.maskText(text)).toBe(masked);
    expect(memory.maskText(`blob ${base64(`user:${DISTINCTIVE}:tail`)}`)).not.toContain(
      base64(`user:${DISTINCTIVE}:tail`),
    );
  });

  test("a clipped start at the end of a text is still masked", () => {
    const long = `${DISTINCTIVE}${[...DISTINCTIVE].reverse().join("")}`;
    const memory = memoryWith(long);
    const clipped = long.slice(0, Math.ceil(long.length * 0.75));
    // Output clipped to a size: a long text whose end cuts the value off.
    const output = `${"log line\n".repeat(200)}${clipped}`;
    expect(memory.maskText(output)).not.toContain(clipped);
    expect(memory.maskText(output)).toEndWith(LABEL);
  });

  test("the compiled masks behave the same with either weak-value policy", () => {
    const entries = [{ value: DISTINCTIVE, label: LABEL }];
    const texts = [
      `src/${DISTINCTIVE}/x`,
      `id_${DISTINCTIVE}_2`,
      JSON.stringify({ a: `pre${DISTINCTIVE}post` }),
      `b64 ${base64(DISTINCTIVE)}`,
    ];
    const positions = compileSecretValueMasks(entries);
    const anywhere = compileSecretValueMasks(entries, { weakValues: "anywhere" });
    for (const text of texts) {
      expect(maskSecretValuesInText(text, positions)).toBe(maskSecretValuesInText(text, anywhere));
      expect(maskSecretValuesInText(text, positions)).not.toContain(DISTINCTIVE);
    }
  });
});

describe("match metrics", () => {
  test("reports masked and kept occurrences without the value or the text", () => {
    const events: SecretValueMatchEvent[] = [];
    const memory = new SecretValueMemory({ onMatch: (event) => events.push(event) });
    memory.remember(WORD, LABEL);
    memory.remember(DISTINCTIVE, ref("Fake Vault/fake-api/value"));
    memory.maskText(`src/${WORD}/x.ts password=${WORD} token ${DISTINCTIVE}`);
    expect(events.map(({ outcome, strength, position }) => [outcome, strength, position])).toEqual([
      ["kept", "weak", "path"],
      ["masked", "weak", "token"],
      ["masked", "distinctive", "token"],
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(WORD);
    expect(serialized).not.toContain(DISTINCTIVE);
    for (const event of events) expect(event.entropy).toMatch(/^(?:lt32|32_64|64_128|ge128)$/u);
  });
});
