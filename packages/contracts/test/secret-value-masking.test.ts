import { describe, expect, test } from "bun:test";
import {
  FIRST_PARTY_SECRET_VALUES_META_KEY,
  SECRET_VALUE_MASK_MIN_CHARS,
  SecretValueMemory,
  firstPartySecretValuesFromMeta,
  isBase64DataUrl,
  isSecretRevealToolName,
  isTextMediaType,
  maskSecretValues,
  maskSecretValuesInError,
  revealSecretGetResult,
  secretGetRevealedValues,
  parseSecretReference,
  rememberingSecretResolver,
  secretCredentialMaskLabel,
  secretReferenceMaskLabel,
  secretValueForms,
  type ResolvedSecretValue,
  type SecretResolver,
} from "../src";

// References are assembled so no tool on the way resolves them.
const ref = (path: string) => `\u007B\u007Bsecret:${path}}}`;
const DB_REF = ref("Fake Vault/fake-db/password");
const FAKE = "fake-Pa55word-not-real-0001";
const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

function memoryWith(value = FAKE, label = DB_REF) {
  const memory = new SecretValueMemory();
  memory.remember(value, label);
  return memory;
}

describe("known-value secret masking", () => {
  test("replaces the value with its reference", () => {
    const memory = memoryWith();
    expect(memory.maskText(`echo ${FAKE}\n${FAKE}\n`)).toBe(`echo ${DB_REF}\n${DB_REF}\n`);
  });

  test("masks the JSON-escaped, percent-encoded and base64 forms", () => {
    const value = 'fake"quote\\back/slash value!';
    const memory = memoryWith(value);
    const json = JSON.stringify({ value });
    expect(memory.maskText(json)).toBe(JSON.stringify({ value: DB_REF }));
    expect(memory.maskText(`x=${encodeURIComponent(value)}&y=1`)).toBe(`x=${DB_REF}&y=1`);
    const form = new URLSearchParams({ v: value }).toString().slice(2);
    expect(memory.maskText(`v=${form}`)).toBe(`v=${DB_REF}`);
    expect(memory.maskText(`b64: ${base64(value)}`)).toBe(`b64: ${DB_REF}`);
    const urlSafe = base64(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    expect(memory.maskText(`b64url: ${urlSafe}`)).toBe(`b64url: ${DB_REF}`);
    // Twice-escaped JSON (a JSON string inside a JSON string).
    const nested = JSON.stringify({ outer: JSON.stringify({ value }) });
    expect(memory.maskText(nested)).toContain(DB_REF);
    expect(memory.maskText(nested)).not.toContain("quote");
  });

  test("masks a value inside a longer base64 run at every alignment", () => {
    const memory = memoryWith();
    for (const prefix of ["u:", "us:", "use:"]) {
      const header = `Authorization: Basic ${base64(`${prefix}${FAKE}`)}`;
      const masked = memory.maskText(header);
      expect(masked).toContain(DB_REF);
      expect(masked).not.toContain(base64(`${prefix}${FAKE}`));
    }
  });

  test("leaves values shorter than the minimum alone", () => {
    expect(SECRET_VALUE_MASK_MIN_CHARS).toBe(8);
    const memory = new SecretValueMemory();
    expect(memory.remember("1234567", DB_REF)).toBeFalse();
    expect(memory.maskText("PIN 1234567 port 1234567")).toBe("PIN 1234567 port 1234567");
    expect(secretValueForms("short")).toEqual([]);
  });

  test("prefers the longest match and is idempotent", () => {
    const memory = new SecretValueMemory();
    memory.remember("fake-token-abcdefgh", ref("V/short"));
    memory.remember("fake-token-abcdefgh-and-more", ref("V/long"));
    const once = memory.maskText("a fake-token-abcdefgh-and-more b fake-token-abcdefgh c");
    expect(once).toBe(`a ${ref("V/long")} b ${ref("V/short")} c`);
    expect(memory.maskText(once)).toBe(once);
  });

  test("masks a value clipped by truncation", () => {
    const memory = memoryWith();
    const clipped = `token=${FAKE.slice(0, 20)}`;
    expect(memory.maskText(`${clipped}... [truncated] tail`)).toBe(
      `token=${DB_REF}... [truncated] tail`,
    );
    // The end of a long text (output clipped to a size) is a cut too...
    const long = `${"x".repeat(1_100)} ${clipped}`;
    expect(memory.maskText(long)).toBe(`${"x".repeat(1_100)} token=${DB_REF}`);
    // ...but not the end of a short one (review 2, finding 8).
    expect(memory.maskText(clipped)).toBe(clipped);
    // A short or shared start is not a clipped value.
    expect(memory.maskText(`token=${FAKE.slice(0, 12)}...`)).toBe(`token=${FAKE.slice(0, 12)}...`);
  });

  test("dot-progress output with a long remembered value stays fast (review 2, finding 1)", () => {
    // Deterministic, non-repeating fake key material.
    let seed = 7;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const key = Array.from({ length: 2_600 }, () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return alphabet[(seed >>> 16) % 64];
    }).join("");
    const memory = memoryWith(key, ref("V/key/value"));
    const progress = `${"....... ".repeat(32_000)}done`;
    const started = performance.now();
    expect(memory.maskText(progress)).toBe(progress);
    expect(performance.now() - started).toBeLessThan(2_000);
    // A clipped start of the long value before a mark is still found.
    const clipped = `${key.slice(0, 1_400)}... more`;
    expect(memory.maskText(clipped)).toBe(`${ref("V/key/value")}... more`);
  });

  test("ordinary lines of a multi-line value are not searched alone (review 2, finding 3)", () => {
    const env = [
      "NODE_ENV=production",
      "APP_URL=https://example.test",
      "FAKE_KEY=fakeFAKEfake0123456789abcdef",
    ].join("\n");
    const memory = memoryWith(env, ref("V/env/file"));
    const example = "NODE_ENV=production\nAPP_URL=https://example.test\n";
    expect(memory.maskText(example)).toBe(example);
    expect(memory.maskText(env)).toBe(ref("V/env/file"));
    // A PEM-style body line is still searched alone.
    const body = "q3x9Lm2Pz8Kd7Rt4Vw1Ys6Nb0Hf5Jc2G".repeat(2);
    const pem = `-----BEGIN FAKE KEY-----\nMIIfakeFAKE0123456789abcdefABCDEF\n${body}\n-----END FAKE KEY-----`;
    const pemMemory = memoryWith(pem, ref("V/pem/value"));
    expect(pemMemory.maskText(`line ${body}`)).toBe(`line ${ref("V/pem/value")}`);
    // Identifier-like lines are not key material (review 3, M2).
    const config = "production-cluster-name\nregion_eu_west_primary\nfakeFAKEfake0123456789secret";
    const configMemory = memoryWith(config, ref("V/config/file"));
    const unrelated = "deploy production-cluster-name in region_eu_west_primary";
    expect(configMemory.maskText(unrelated)).toBe(unrelated);
  });

  test("the clipped-start index stays bounded with many long values (review 3, M1)", () => {
    const memory = new SecretValueMemory();
    let seed = 11;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const values = Array.from({ length: 50 }, () =>
      Array.from({ length: 6_000 }, () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return alphabet[(seed >>> 16) % 62];
      }).join(""),
    );
    values.forEach((value, index) => memory.remember(value, ref(`V/big-${index}/value`)));
    const started = performance.now();
    expect(memory.maskText(`a ${values[49]} b`)).toBe(`a ${ref("V/big-49/value")} b`);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("an own __proto__ key survives masking (review 2, finding 10)", () => {
    const memory = memoryWith();
    const input = JSON.parse(`{"__proto__":{"a":1},"t":"${FAKE}"}`) as Record<string, unknown>;
    const masked = memory.mask(input);
    expect(Object.keys(masked)).toEqual(["__proto__", "t"]);
    expect(JSON.stringify(masked)).toBe(
      `{"__proto__":{"a":1},"t":"${DB_REF.replaceAll('"', '\\"')}"}`,
    );
    expect(Object.getPrototypeOf(masked)).toBe(Object.prototype);
  });

  test("errors are masked in message, stack and cause", () => {
    const memory = memoryWith();
    const error = new Error(`failed with ${FAKE}`, { cause: new Error(`inner ${FAKE}`) });
    expect(maskSecretValuesInError(error, memory)).toBe(error);
    expect(error.message).toBe(`failed with ${DB_REF}`);
    expect(error.stack).not.toContain(FAKE);
    expect((error.cause as Error).message).toBe(`inner ${DB_REF}`);
    expect(maskSecretValuesInError("not an error", memory)).toBe("not an error");
    // AggregateError inner errors too (review 3, nit).
    const aggregate = new AggregateError([new Error(`one ${FAKE}`)], `all ${FAKE}`);
    maskSecretValuesInError(aggregate, memory);
    expect(aggregate.message).toBe(`all ${DB_REF}`);
    expect((aggregate.errors[0] as Error).message).toBe(`one ${DB_REF}`);
  });

  test("secret_get reveals, including the decoded text of a base64 result (review 2, finding 4)", () => {
    const memory = memoryWith();
    const result = JSON.stringify({ value: base64(FAKE), encoding: "base64" });
    revealSecretGetResult(memory, "exec_command", result);
    expect(memory.has(FAKE)).toBeTrue();
    revealSecretGetResult(memory, "opengeni__secret_get", result);
    expect(memory.has(FAKE)).toBeFalse();
    expect(memory.mask(result)).toBe(result);
    expect(memory.maskText(`printed ${FAKE}`)).toBe(`printed ${FAKE}`);
    expect(secretGetRevealedValues({ value: FAKE, encoding: "utf8" })).toEqual([FAKE]);
    expect(isSecretRevealToolName("secret_get")).toBeTrue();
    expect(isSecretRevealToolName("opengeni__secret_get")).toBeTrue();
    // A connector's tool of the same name is not Opengeni's reveal (review 3, L2).
    expect(isSecretRevealToolName("vaultcorp__secret_get")).toBeFalse();
  });

  test("common prefixes of known values are not masked (review finding 2)", () => {
    const url = "postgres://fake-user:fake-Pa55word-0001@db.example.test:5432/app";
    const hook = "https://hooks.slack.example/services/T000/B000/fakeFAKEfake0001";
    const jwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${"eyJzdWIiOiJmYWtlIn0".repeat(3)}.fakeSIG0001fakeSIG`;
    const memory = new SecretValueMemory();
    memory.remember(url, ref("V/db/url"));
    memory.remember(hook, ref("V/hook/url"));
    memory.remember(jwt, ref("V/jwt/value"));
    for (const text of [
      '{"engine":"postgres"}',
      "I use postgres",
      "see https://...",
      "docs at https://",
      "header eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "clipped eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIi…",
    ]) {
      expect(memory.maskText(text)).toBe(text);
    }
    expect(memory.mask({ a: ["postgres://fake-user:"] })).toEqual({ a: ["postgres://fake-user:"] });
  });

  test("text that starts with data: is masked unless it is a data URL (review finding 1)", () => {
    const memory = memoryWith();
    expect(memory.mask(`data: {"token":"${FAKE}"}`)).toBe(`data: {"token":"${DB_REF}"}`);
    expect(memory.mask({ out: `data: ${FAKE}\n\n` })).toEqual({ out: `data: ${DB_REF}\n\n` });
    const dataUrl = `data:image/png;base64,${base64(FAKE)}`;
    expect(memory.mask(dataUrl)).toBe(dataUrl);
    // Only a string that is entirely a base64 data URL is skipped (review 2, finding 5).
    expect(memory.mask(`data:text/plain,${FAKE}`)).toBe(`data:text/plain,${DB_REF}`);
    expect(memory.mask(`data:image/png;base64,AAAA\nlater log ${FAKE}`)).toBe(
      `data:image/png;base64,AAAA\nlater log ${DB_REF}`,
    );
    expect(isBase64DataUrl(dataUrl)).toBeTrue();
    // Binary `data` beside any MIME type key, including the SDK's mediaType.
    const image = { type: "image", mediaType: "image/png", data: base64(FAKE) };
    expect(memory.mask(image)).toBe(image);
    const png = `data:image/png;base64,${base64(FAKE)}`;
    expect(memory.mask(png)).toBe(png);
  });

  test("text payloads are masked decoded and stay valid base64 (review 3, L1)", () => {
    const memory = memoryWith();
    const masked = memory.mask(`data:application/json;base64,${base64(`{"token":"${FAKE}"}`)}`);
    expect(masked).toBe(`data:application/json;base64,${base64(`{"token":"${DB_REF}"}`)}`);
    const file = memory.mask({ mimeType: "text/plain", data: base64(`token=${FAKE}\n`) });
    expect(file).toEqual({ mimeType: "text/plain", data: base64(`token=${DB_REF}\n`) });
    // A text payload that is not base64 is plain text.
    expect(memory.mask({ mimeType: "text/plain", data: `token=${FAKE}` })).toEqual({
      mimeType: "text/plain",
      data: `token=${DB_REF}`,
    });
    expect(isTextMediaType("application/vnd.api+json")).toBeTrue();
    expect(isTextMediaType("application/octet-stream")).toBeFalse();
  });

  test("a text payload that is itself valid base64 text is masked as written (review 4, N2)", () => {
    // A fake token that is the base64 of ASCII text decodes cleanly, but the
    // decoded text holds nothing known: the value as written is masked.
    const token = base64("fake-base64-shaped-token-0001");
    const memory = new SecretValueMemory();
    memory.remember(token, DB_REF);
    expect(memory.mask({ mimeType: "text/plain", data: token })).toEqual({
      mimeType: "text/plain",
      data: DB_REF,
    });
  });

  test("a value written inside reference syntax is still masked (review finding 6)", () => {
    const memory = memoryWith();
    expect(memory.maskText(`${ref(FAKE)} and ${DB_REF}`)).toBe(`${ref(DB_REF)} and ${DB_REF}`);
  });

  test("an explicit reveal is not masked; dispose forgets everything", () => {
    const memory = memoryWith();
    memory.reveal(FAKE);
    expect(memory.maskText(`value ${FAKE}`)).toBe(`value ${FAKE}`);
    expect(memory.remember(FAKE, DB_REF)).toBe(false);
    const other = memoryWith();
    other.dispose();
    expect(other.size).toBe(0);
    expect(other.remember(FAKE, DB_REF)).toBe(false);
    expect(other.maskText(`value ${FAKE}`)).toBe(`value ${FAKE}`);
  });

  test("Opengeni's own credentials are kept when the memory is full (review finding 12)", () => {
    const memory = new SecretValueMemory({ maxEntries: 3 });
    const bearer = "fake-codemode-bearer-0001";
    memory.remember(bearer, secretCredentialMaskLabel("codemode token"));
    for (let index = 0; index < 10; index += 1) {
      memory.remember(`fake-history-value-${index}`, ref(`V/item${index}`));
    }
    expect(memory.size).toBe(3);
    expect(memory.has(bearer)).toBe(true);
    expect(memory.has("fake-history-value-9")).toBe(true);
  });

  test("masks deeply and keeps identity when nothing matches", () => {
    const memory = memoryWith();
    const untouched = { a: ["plain", { b: "text" }] };
    expect(memory.mask(untouched)).toBe(untouched);
    const masked = memory.mask({ a: [`x ${FAKE}`], image: { mimeType: "image/png", data: FAKE } });
    expect(masked).toEqual({ a: [`x ${DB_REF}`], image: { mimeType: "image/png", data: FAKE } });
  });

  test("labels: references stay usable, credentials get a marker", () => {
    expect(secretReferenceMaskLabel({ raw: DB_REF })).toBe(DB_REF);
    const fileRef = "\u007B\u007Bsecretfile:Fake Vault/fake-db/password}}";
    expect(secretReferenceMaskLabel({ raw: fileRef })).toBe(DB_REF);
    const quoted = ref('Fake "Vault"/item');
    expect(
      secretReferenceMaskLabel({
        raw: quoted,
        itemId: "11111111-1111-4111-8111-111111111111",
        fieldName: "password",
      }),
    ).not.toContain('"');
    expect(secretCredentialMaskLabel("codemode token")).toBe(
      "[opengeni credential: codemode token]",
    );
  });

  test("a reference label beats a credential marker for the same value", () => {
    const memory = new SecretValueMemory();
    memory.remember(FAKE, secretCredentialMaskLabel("git token"));
    memory.remember(FAKE, DB_REF);
    expect(memory.maskText(FAKE)).toBe(DB_REF);
  });

  test("never throws and reports metadata only", () => {
    const diagnostics: unknown[] = [];
    const memory = new SecretValueMemory({ onDiagnostic: (entry) => diagnostics.push(entry) });
    memory.remember(FAKE, DB_REF);
    const hostile = {
      get boom() {
        throw new Error(`contains ${FAKE}`);
      },
    };
    expect(memory.mask(hostile)).toBe(hostile);
    expect(diagnostics).toEqual([{ stage: "mask", error: "Error" }]);
  });

  test("remembers per operation for first-party call metadata", () => {
    const memory = new SecretValueMemory();
    memory.rememberForOperation("op-1", FAKE, DB_REF);
    expect(memory.operationEntries("op-1")).toEqual([{ value: FAKE, label: DB_REF }]);
    expect(memory.operationEntries("op-2")).toEqual([]);
    const meta = { [FIRST_PARTY_SECRET_VALUES_META_KEY]: memory.operationEntries("op-1") };
    expect(firstPartySecretValuesFromMeta(meta)).toEqual([{ value: FAKE, label: DB_REF }]);
    expect(firstPartySecretValuesFromMeta({ other: true })).toEqual([]);
  });

  test("a remembering resolver records every resolved text value", async () => {
    const reference = parseSecretReference(DB_REF);
    const resolved: ResolvedSecretValue = {
      key: "k",
      reference,
      source: "opengeni",
      vaultId: "v",
      vaultName: "Fake Vault",
      itemId: "11111111-1111-4111-8111-111111111111",
      itemName: "fake-db",
      fieldId: null,
      fieldName: "password",
      version: 1,
      material: { type: "text", value: FAKE },
    };
    const base: SecretResolver = {
      principal: {
        kind: "human",
        accountId: "a",
        workspaceId: "w",
        subjectId: "s",
        verifiedHuman: true,
        viaApiKey: false,
      },
      enabled: true,
      resolve: async () => new Map([["k", resolved]]),
    };
    const memory = new SecretValueMemory();
    await rememberingSecretResolver(base, memory).resolve([reference], {
      surface: "shell",
      toolName: "exec_command",
      operationId: "op-9",
    });
    expect(memory.maskText(`out ${FAKE}`)).toBe(`out ${DB_REF}`);
    expect(memory.operationEntries("op-9")).toHaveLength(1);
  });

  test("a remembering resolver skips plain text fields (review 2, finding 2)", async () => {
    const reference = parseSecretReference(ref("Fake Vault/fake-login/username"));
    const resolved: ResolvedSecretValue = {
      key: "k",
      reference,
      source: "opengeni",
      vaultId: "v",
      vaultName: "Fake Vault",
      itemId: "22222222-2222-4222-8222-222222222222",
      itemName: "fake-login",
      fieldId: null,
      fieldName: "username",
      fieldKind: "text",
      version: 1,
      material: { type: "text", value: "fake-user-name-0001" },
    };
    const base: SecretResolver = {
      principal: {
        kind: "human",
        accountId: "a",
        workspaceId: "w",
        subjectId: "s",
        verifiedHuman: true,
        viaApiKey: false,
      },
      enabled: true,
      resolve: async () => new Map([["k", resolved]]),
    };
    const memory = new SecretValueMemory();
    await rememberingSecretResolver(base, memory).resolve([reference], {
      surface: "shell",
      toolName: "exec_command",
      operationId: "op-10",
    });
    expect(memory.size).toBe(0);
  });

  test("maskSecretValues compiles plain entries", () => {
    expect(maskSecretValues({ t: FAKE }, [{ value: FAKE, label: DB_REF }])).toEqual({ t: DB_REF });
  });
});
