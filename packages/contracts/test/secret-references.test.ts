import { describe, expect, test } from "bun:test";
import {
  collectInvalidReferencesDeep,
  collectReferencesDeep,
  containsSecretReference,
  findInvalidSecretReferences,
  findSecretReferences,
  formatSecretReference,
  parseSecretReference,
  referenceKey,
  replaceReferencesDeep,
  SecretReferenceSyntaxError,
  secretNameKey,
  tokenizeSecretText,
  unescapeSecretText,
  type SecretReference,
} from "../src/index";

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

type Expected = {
  kind?: "secret" | "secretfile";
  path?: string[];
  id?: string | undefined;
  field?: string | null;
  otp?: boolean;
  previous?: boolean;
};

const VALID: Array<[string, Expected]> = [
  ["{{secret:GitHub}}", { path: ["GitHub"] }],
  ["{{secret:GitHub/token}}", { path: ["GitHub", "token"] }],
  ["{{secret:Team/GitHub/token}}", { path: ["Team", "GitHub", "token"] }],
  ["{{secretfile:Cert}}", { kind: "secretfile", path: ["Cert"] }],
  ["{{secretfile:Team/Cert/file}}", { kind: "secretfile", path: ["Team", "Cert", "file"] }],
  ["{{secret:GitHub/otp}}", { path: ["GitHub"], otp: true }],
  ["{{secret:GitHub/OTP}}", { path: ["GitHub"], otp: true }],
  ["{{secret:Team/GitHub/otp}}", { path: ["Team", "GitHub"], otp: true }],
  ["{{secret:Team/GitHub/seed/otp}}", { path: ["Team", "GitHub", "seed"], otp: true }],
  ["{{secret:GitHub#previous}}", { path: ["GitHub"], previous: true }],
  ["{{secret:GitHub/token#previous}}", { path: ["GitHub", "token"], previous: true }],
  ["{{secret:Team/GitHub/token#previous}}", { path: ["Team", "GitHub", "token"], previous: true }],
  ["{{secret:GitHub/otp#previous}}", { path: ["GitHub"], otp: true, previous: true }],
  [`{{secret:id:${UUID}}}`, { id: UUID, field: null }],
  [`{{secret:id:${UUID}/password}}`, { id: UUID, field: "password" }],
  [`{{secret:id:${UUID}/otp}}`, { id: UUID, field: null, otp: true }],
  [`{{secret:id:${UUID}/seed/otp}}`, { id: UUID, field: "seed", otp: true }],
  [`{{secret:id:${UUID}#previous}}`, { id: UUID, field: null, previous: true }],
  [`{{secret:id:${UUID.toUpperCase()}}}`, { id: UUID, field: null }],
  [`{{secretfile:id:${UUID}/file}}`, { kind: "secretfile", id: UUID, field: "file" }],
  ["{{secret:My API key}}", { path: ["My API key"] }],
  ["{{secret:Stripe live/secret key}}", { path: ["Stripe live", "secret key"] }],
  ["{{secret:Ålesund bank}}", { path: ["Ålesund bank"] }],
  ["{{secret:日本語のキー}}", { path: ["日本語のキー"] }],
  ["{{secret:emoji 🔑}}", { path: ["emoji 🔑"] }],
  ["{{secret:a}}", { path: ["a"] }],
  ["{{secret:otp}}", { path: ["otp"] }],
  ["{{secret:x:y}}", { path: ["x:y"] }],
  ["{{secret:a.b-c_d}}", { path: ["a.b-c_d"] }],
  ["{{secret:AWS (prod)}}", { path: ["AWS (prod)"] }],
  ['{{secret:quote"inside}}', { path: ['quote"inside'] }],
  ["{{secret:single'inside}}", { path: ["single'inside"] }],
  ["{{secret:dollar$inside}}", { path: ["dollar$inside"] }],
  ["{{secret:back`tick}}", { path: ["back`tick"] }],
  ["{{secret:semi;colon}}", { path: ["semi;colon"] }],
  ["{{secret:pipe|amp&}}", { path: ["pipe|amp&"] }],
  ["{{secret:percent%20}}", { path: ["percent%20"] }],
  ["{{secret:with=equals}}", { path: ["with=equals"] }],
  ["{{secret:CLOUDGENI_GITHUB_TOKEN}}", { path: ["CLOUDGENI_GITHUB_TOKEN"] }],
  [
    "{{secret:Private/CLOUDGENI_GITHUB_TOKEN/value}}",
    { path: ["Private", "CLOUDGENI_GITHUB_TOKEN", "value"] },
  ],
  [`{{secret:${"n".repeat(120)}}}`, { path: ["n".repeat(120)] }],
  ["{{secret:a b c}}", { path: ["a b c"] }],
  ["{{secret:Vault/Item/otp#previous}}", { path: ["Vault", "Item"], otp: true, previous: true }],
  ["{{secret:café}}", { path: ["café"] }],
  ["{{secret:x/y/z}}", { path: ["x", "y", "z"] }],
  ["{{secretfile:x/y}}", { kind: "secretfile", path: ["x", "y"] }],
  ["{{secretfile:x/otp}}", { kind: "secretfile", path: ["x"], otp: true }],
  ["{{secret:a/b/otp}}", { path: ["a", "b"], otp: true }],
  ["{{secret:a/otp/b}}", { path: ["a", "otp", "b"] }],
  ["{{secret:ID-like}}", { path: ["ID-like"] }],
];

const INVALID: Array<[string, string]> = [
  ["{{secret:}}", "empty_body"],
  ["{{secret:/x}}", "empty_segment"],
  ["{{secret:x/}}", "empty_segment"],
  ["{{secret:x//y}}", "empty_segment"],
  ["{{secret: x}}", "invalid_segment"],
  ["{{secret:x }}", "invalid_segment"],
  ["{{secret:a/b/c/d}}", "too_many_segments"],
  ["{{secret:a/b/c/d/otp}}", "too_many_segments"],
  ["{{secret:x#prev}}", "unsupported_version_suffix"],
  ["{{secret:x#previous#previous}}", "unsupported_version_suffix"],
  ["{{secret:x#previous/otp}}", "unsupported_version_suffix"],
  ["{{secret:x#1}}", "unsupported_version_suffix"],
  ["{{secret:id:not-a-uuid}}", "invalid_id"],
  ["{{secret:id:}}", "invalid_id"],
  [`{{secret:id:${UUID}/a/b}}`, "too_many_segments"],
  ["{{secret:a\\b}}", "invalid_segment"],
  [`{{secret:${"n".repeat(121)}}}`, "invalid_segment"],
  [`{{secret:${"a/".repeat(150)}}}`, "too_long"],
  ["{{secret:a/id:x}}", "invalid_segment"],
  ["{{secret:tab\there}}", "unterminated"],
  ["{{secret:new\nline}}", "unterminated"],
  ["{{secret:a{b}}", "unterminated"],
  ["{{secret:a}b}}", "unterminated"],
  ["{{secret:abc", "unterminated"],
  ["{{secret:abc}", "unterminated"],
  ["{{secretfile:}}", "empty_body"],
  ["{{secretfile:a/b/c/d}}", "too_many_segments"],
];

function describeTarget(ref: SecretReference): Expected {
  return {
    kind: ref.kind,
    ...(ref.target.form === "path"
      ? { path: [...ref.target.segments] }
      : { id: ref.target.itemId, field: ref.target.field }),
    otp: ref.otp,
    previous: ref.previous,
  };
}

describe("secret reference grammar", () => {
  for (const [raw, expected] of VALID) {
    test(`parses ${JSON.stringify(raw).slice(0, 60)}`, () => {
      const ref = parseSecretReference(raw);
      expect(describeTarget(ref)).toEqual({
        kind: expected.kind ?? "secret",
        ...(expected.path
          ? { path: expected.path }
          : { id: expected.id, field: expected.field ?? null }),
        otp: expected.otp ?? false,
        previous: expected.previous ?? false,
      });
      expect(ref.raw).toBe(raw);
      expect(ref.start).toBe(0);
      expect(ref.end).toBe(raw.length);
      // Found inside surrounding text with correct offsets.
      const text = `echo ${raw} done`;
      const [found] = findSecretReferences(text);
      expect(found?.start).toBe(5);
      expect(text.slice(found!.start, found!.end)).toBe(raw);
    });
  }

  for (const [raw, reason] of INVALID) {
    test(`rejects ${JSON.stringify(raw).slice(0, 60)} (${reason})`, () => {
      let caught: unknown;
      try {
        parseSecretReference(raw);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SecretReferenceSyntaxError);
      expect((caught as SecretReferenceSyntaxError).reason).toBe(reason);
      const tokens = tokenizeSecretText(`x ${raw} y`);
      expect(tokens.some((token) => token.type === "invalid")).toBe(true);
      expect(findSecretReferences(raw)).toEqual([]);
    });
  }

  test.each([
    "{{ secret:x}}",
    "{{Secret:x}}",
    "{{SECRET:x}}",
    "{{secrets:x}}",
    "{{secret}}",
    "{{secretx:y}}",
    "{secret:x}",
    "{{ secret:x }}",
    "{{secret_file:x}}",
    "plain text",
    "",
    "{{other:thing}}",
    "{{secret",
  ])("treats %p as plain text", (text) => {
    const tokens = tokenizeSecretText(text);
    expect(tokens.every((token) => token.type === "text")).toBe(true);
    expect(tokens.map((token) => (token.type === "text" ? token.value : "")).join("")).toBe(text);
  });

  test("prefix is strict and longest-match for secretfile", () => {
    expect(parseSecretReference("{{secretfile:a}}").kind).toBe("secretfile");
    expect(parseSecretReference("{{secret:file}}").target).toEqual({
      form: "path",
      segments: ["file"],
    });
  });

  test("total length is capped at 300 characters", () => {
    const body = `${"a".repeat(100)}/${"b".repeat(100)}/${"c".repeat(87)}`;
    const ok = `{{secret:${body}}}`;
    expect(ok.length).toBe(300);
    expect(parseSecretReference(ok).target.form).toBe("path");
    const tooLong = `{{secret:${body}c}}`;
    expect(tooLong.length).toBe(301);
    expect(() => parseSecretReference(tooLong)).toThrow(SecretReferenceSyntaxError);
  });

  test("rejects trailing text and missing prefix in parseSecretReference", () => {
    expect(() => parseSecretReference("{{secret:a}} ")).toThrow(SecretReferenceSyntaxError);
    expect(() => parseSecretReference("secret:a")).toThrow(SecretReferenceSyntaxError);
  });
});

describe("tokenizer", () => {
  test("splits text, references and invalid candidates with offsets", () => {
    const text = 'curl -H "Authorization: Bearer {{secret:GitHub/token}}" {{secret:}} end';
    const tokens = tokenizeSecretText(text);
    expect(tokens.map((token) => token.type)).toEqual([
      "text",
      "reference",
      "text",
      "invalid",
      "text",
    ]);
    const ref = tokens[1];
    expect(ref?.type === "reference" && text.slice(ref.reference.start, ref.reference.end)).toBe(
      "{{secret:GitHub/token}}",
    );
    const invalid = tokens[3];
    expect(invalid?.type === "invalid" && text.slice(invalid.start, invalid.end)).toBe(
      "{{secret:}}",
    );
  });

  test("adjacent references", () => {
    const refs = findSecretReferences("{{secret:a}}{{secret:b}}{{secretfile:c}}");
    expect(refs.map((ref) => ref.raw)).toEqual([
      "{{secret:a}}",
      "{{secret:b}}",
      "{{secretfile:c}}",
    ]);
    expect(refs.map((ref) => ref.start)).toEqual([0, 12, 24]);
  });

  test("escapes emit the reference literally without the backslash", () => {
    const text = "keep \\{{secret:Literal}} but resolve {{secret:Real}}";
    const tokens = tokenizeSecretText(text);
    expect(tokens.map((token) => token.type)).toEqual(["text", "reference"]);
    expect(tokens[0]).toEqual({ type: "text", value: "keep {{secret:Literal}} but resolve " });
    expect(unescapeSecretText(text)).toBe("keep {{secret:Literal}} but resolve {{secret:Real}}");
    expect(findSecretReferences(text).map((ref) => ref.raw)).toEqual(["{{secret:Real}}"]);
  });

  test("an escaped invalid candidate is literal text, not invalid", () => {
    expect(tokenizeSecretText("\\{{secret:}}")).toEqual([{ type: "text", value: "{{secret:}}" }]);
    expect(findInvalidSecretReferences("\\{{secret:}}")).toEqual([]);
  });

  test("a backslash elsewhere is untouched", () => {
    expect(unescapeSecretText("a\\b {{secret:x}} c\\")).toBe("a\\b {{secret:x}} c\\");
    expect(tokenizeSecretText("C:\\path")).toEqual([{ type: "text", value: "C:\\path" }]);
  });

  test("double escape keeps one backslash and the escaped reference literal", () => {
    expect(tokenizeSecretText("\\\\{{secret:x}}")).toEqual([
      { type: "text", value: "\\{{secret:x}}" },
    ]);
  });

  test("unterminated candidate stops before a newline and scanning continues", () => {
    const tokens = tokenizeSecretText("{{secret:abc\n{{secret:ok}}");
    expect(tokens.map((token) => token.type)).toEqual(["invalid", "text", "reference"]);
  });

  test("references in JSON payloads", () => {
    const json = JSON.stringify({ token: "{{secret:API/key}}", nested: ["x {{secret:Other}}"] });
    expect(findSecretReferences(json).map((ref) => ref.raw)).toEqual([
      "{{secret:API/key}}",
      "{{secret:Other}}",
    ]);
  });

  test("fast path", () => {
    expect(containsSecretReference("nothing here")).toBe(false);
    expect(containsSecretReference("x {{secretfile:y}}")).toBe(true);
    expect(tokenizeSecretText("")).toEqual([]);
  });
});

describe("format, keys and deep helpers", () => {
  test.each([
    [{ item: "GitHub" }, "{{secret:GitHub}}"],
    [{ item: "GitHub", field: "token" }, "{{secret:GitHub/token}}"],
    [{ vault: "Team", item: "GitHub", field: "token" }, "{{secret:Team/GitHub/token}}"],
    [{ vault: "Team", item: "GitHub" }, "{{secret:Team/GitHub}}"],
    [{ item: "GitHub", otp: true }, "{{secret:GitHub/otp}}"],
    [{ item: "GitHub", previous: true }, "{{secret:GitHub#previous}}"],
    [{ kind: "secretfile" as const, item: "Cert" }, "{{secretfile:Cert}}"],
    [{ itemId: UUID }, `{{secret:id:${UUID}}}`],
    [{ itemId: UUID, field: "password" }, `{{secret:id:${UUID}/password}}`],
    [{ itemId: UUID.toUpperCase(), otp: true }, `{{secret:id:${UUID}/otp}}`],
  ])("formats %p", (input, expected) => {
    const formatted = formatSecretReference(input);
    expect(formatted).toBe(expected);
    expect(parseSecretReference(formatted).raw).toBe(expected);
  });

  test.each([
    { item: "a/b" },
    { item: "" },
    { item: " x" },
    { item: "x", field: "y}" },
    { itemId: "nope" },
  ])("refuses to format %p", (input) => {
    expect(() => formatSecretReference(input)).toThrow(SecretReferenceSyntaxError);
  });

  test("referenceKey dedupes case and normalization, but not modifiers or kind", () => {
    const key = (raw: string) => referenceKey(parseSecretReference(raw));
    expect(key("{{secret:GitHub/Token}}")).toBe(key("{{secret:github/token}}"));
    expect(key("{{secret:Cafe\u0301}}")).toBe(key("{{secret:Café}}"));
    expect(key("{{secret:GitHub}}")).not.toBe(key("{{secret:GitHub/otp}}"));
    expect(key("{{secret:GitHub}}")).not.toBe(key("{{secret:GitHub#previous}}"));
    expect(key("{{secret:GitHub}}")).not.toBe(key("{{secretfile:GitHub}}"));
    expect(key(`{{secret:id:${UUID}}}`)).toBe(key(`{{secret:id:${UUID.toUpperCase()}}}`));
  });

  test("secretNameKey", () => {
    expect(secretNameKey("  GitHub ")).toBe("github");
    expect(secretNameKey("Cafe\u0301")).toBe("café");
  });

  test("collect and replace deep", () => {
    const input = {
      url: "https://x.test/{{secret:A}}",
      headers: [{ name: "Authorization", value: "Bearer {{secret:B/token}}" }],
      literal: "\\{{secret:Kept}}",
      count: 3,
      flag: true,
      nothing: null,
    };
    expect(collectReferencesDeep(input).map((ref) => ref.raw)).toEqual([
      "{{secret:A}}",
      "{{secret:B/token}}",
    ]);
    const replaced = replaceReferencesDeep(input, (ref) => `<${ref.raw.length}>`);
    expect(replaced).toEqual({
      url: "https://x.test/<12>",
      headers: [{ name: "Authorization", value: "Bearer <18>" }],
      literal: "{{secret:Kept}}",
      count: 3,
      flag: true,
      nothing: null,
    });
    expect(input.url).toBe("https://x.test/{{secret:A}}");
    expect(collectInvalidReferencesDeep({ a: ["{{secret:}}"] })).toHaveLength(1);
  });

  test("deep helpers tolerate cycles", () => {
    const cyclic: Record<string, unknown> = { a: "{{secret:x}}" };
    cyclic.self = cyclic;
    expect(collectReferencesDeep(cyclic)).toHaveLength(1);
  });
});

describe("fuzz", () => {
  const alphabet = [
    "{",
    "}",
    "{{",
    "}}",
    "secret",
    "secretfile",
    ":",
    "/",
    "#",
    "previous",
    "otp",
    "id:",
    "\\",
    " ",
    "a",
    "Ø",
    "\n",
    UUID,
  ];
  function seeded(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }

  test("10k random strings: never throws, round-trips and offsets hold", () => {
    const random = seeded(42);
    for (let iteration = 0; iteration < 10_000; iteration += 1) {
      const parts: string[] = [];
      const count = Math.floor(random() * 12);
      for (let index = 0; index < count; index += 1) {
        if (random() < 0.15) parts.push("{{secret:");
        else parts.push(alphabet[Math.floor(random() * alphabet.length)]!);
      }
      const text = parts.join("");
      const tokens = tokenizeSecretText(text);
      // Without escapes, concatenating the tokens restores the text exactly.
      if (!text.includes("\\")) {
        const rebuilt = tokens
          .map((token) =>
            token.type === "text"
              ? token.value
              : token.type === "reference"
                ? token.reference.raw
                : token.raw,
          )
          .join("");
        expect(rebuilt).toBe(text);
      }
      for (const token of tokens) {
        if (token.type === "reference") {
          expect(text.slice(token.reference.start, token.reference.end)).toBe(token.reference.raw);
          // format(parse(x)) parses back to the same key.
          const ref = token.reference;
          const formatted =
            ref.target.form === "id"
              ? formatSecretReference({
                  kind: ref.kind,
                  itemId: ref.target.itemId,
                  ...(ref.target.field === null ? {} : { field: ref.target.field }),
                  otp: ref.otp,
                  previous: ref.previous,
                })
              : formatSecretReference({
                  kind: ref.kind,
                  ...(ref.target.segments.length === 3 ? { vault: ref.target.segments[0] } : {}),
                  item:
                    ref.target.segments.length === 3
                      ? ref.target.segments[1]
                      : ref.target.segments[0],
                  ...(ref.target.segments.length === 1
                    ? {}
                    : { field: ref.target.segments[ref.target.segments.length - 1]! }),
                  otp: ref.otp,
                  previous: ref.previous,
                });
          expect(referenceKey(parseSecretReference(formatted))).toBe(referenceKey(ref));
        }
        if (token.type === "invalid") {
          expect(text.slice(token.start, token.end)).toBe(token.raw);
        }
      }
    }
  });
});
