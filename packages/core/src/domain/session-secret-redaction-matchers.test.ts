import { describe, expect, test } from "bun:test";
import { formatSecretReference, parseSecretReference } from "@opengeni/contracts";
import {
  jsonObjectMembers,
  LOSSLESS_TEXT_PREFIX,
  redactJsonRowText,
  redactJsonText,
  redactSecretText,
  secretRedactionMarker,
} from "@opengeni/db";
import {
  maskInPatternWindows,
  secretRedactionMatcherForValue,
  secretRedactionMatchersForPatterns,
  secretRedactionReferenceLabel,
} from "./session-secret-redaction-matchers";

// Values are obviously fake.
const VALUE = "fake-Secret/Value+with=chars&more";

describe("secret history scrub matchers", () => {
  const label = secretRedactionReferenceLabel(
    parseSecretReference(
      formatSecretReference({ vault: "Team vault", item: "Deploy token", field: "value" }),
    ),
  );
  const matcher = secretRedactionMatcherForValue(VALUE, label)!;

  test("the marker names the reference without braces, so it never resolves", () => {
    expect(label).toBe("secret:Team vault/Deploy token/value");
    expect(matcher.marker).toBe("[redacted: secret:Team vault/Deploy token/value]");
    expect(matcher.marker).not.toContain("{{");
  });

  test("every form masking recognizes is replaced, and only those", () => {
    const text = [
      `plain ${VALUE}`,
      `json ${JSON.stringify(VALUE).slice(1, -1)}`,
      `url ${encodeURIComponent(VALUE)}`,
      `base64 ${Buffer.from(VALUE).toString("base64")}`,
      "untouched fake-Secret",
    ].join("\n");
    const result = redactSecretText(text, [matcher]);
    expect(result.text).not.toContain(VALUE);
    expect(result.text).not.toContain(encodeURIComponent(VALUE));
    expect(result.text).not.toContain(Buffer.from(VALUE).toString("base64"));
    expect(result.text).toContain("untouched fake-Secret");
    expect(result.matches).toBe(4);
  });

  test("a second pass changes nothing", () => {
    const once = redactSecretText(`a ${VALUE} b ${VALUE}`, [matcher]);
    expect(once.matches).toBe(2);
    const twice = redactSecretText(once.text, [matcher]);
    expect(twice).toEqual({ text: once.text, matches: 0 });
  });

  test("stored JSON stays valid and keeps its structure", () => {
    const json = JSON.stringify({ output: `token=${VALUE}`, nested: [{ v: VALUE }], n: 1 });
    const result = redactJsonText(json, null, [matcher]);
    expect(result.matches).toBe(2);
    const parsed = JSON.parse(result.text) as { output: string; nested: Array<{ v: string }> };
    expect(parsed.output).toBe(`token=${matcher.marker}`);
    expect(parsed.nested[0]!.v).toBe(matcher.marker);
  });

  test("a value too short to search safely gives no matcher", () => {
    expect(secretRedactionMatcherForValue("abc", "secret:x/y")).toBeNull();
    // Blank padding does not count: eight spaces would rewrite every indent.
    expect(secretRedactionMatcherForValue(" ".repeat(12), "secret:x/y")).toBeNull();
    expect(secretRedactionMatcherForValue("  ab\t\n  ", "secret:x/y")).toBeNull();
  });

  test("a later run never rewrites a marker an earlier run wrote", () => {
    const password = secretRedactionMatcherForValue(
      "fake-Passw0rd-value",
      "secret:Prod/deploybot/password",
    )!;
    const username = secretRedactionMatcherForValue("deploybot", "secret:Prod/deploybot/username")!;
    const first = redactSecretText("login deploybot / fake-Passw0rd-value", [password]);
    expect(first.text).toBe("login deploybot / [redacted: secret:Prod/deploybot/password]");
    const second = redactSecretText(first.text, [username]);
    expect(second).toEqual({
      text: "login [redacted: secret:Prod/deploybot/username] / [redacted: secret:Prod/deploybot/password]",
      matches: 1,
    });
    expect(redactSecretText(second.text, [password, username]).matches).toBe(0);
    // A pattern marker's label is kept too.
    const kind = secretRedactionMatcherForValue("url_password", "secret:V/I/f")!;
    expect(redactSecretText("x:[redacted: url_password]@h", [kind]).matches).toBe(0);
  });

  test("text shaped like a marker that the scrub never writes is searched like any text", () => {
    for (const text of [
      `note [redacted: ${VALUE}] end`,
      `[redacted: was ${VALUE}]`,
      `[redacted: see https://u:${VALUE}@db.example.test/x]`,
    ]) {
      const result = redactSecretText(text, [matcher]);
      expect(result.matches).toBe(1);
      expect(result.text).not.toContain(VALUE);
    }
  });

  test("a value holding marker-shaped text gives no matcher", () => {
    expect(secretRedactionMatcherForValue("pre[redacted: x]post-0123", "secret:x/y/z")).toBeNull();
  });

  test("a marker typed around a kept marker does not unprotect it", () => {
    const name = secretRedactionMatcherForValue("alice.admin.user", "secret:V/users/name")!;
    const text = "[redacted: note [redacted: secret:V/alice.admin.user/pw] tail]";
    expect(redactSecretText(text, [name])).toEqual({ text, matches: 0 });
  });

  test("a clipped value at the end of a long text is found past a long kept marker", () => {
    const value = "fakeClipValue-0123456789-abcdefgh";
    const long = secretRedactionMatcherForValue(value, "secret:x/y/z")!;
    const marker = secretRedactionMarker(
      `secret:${"v".repeat(90)}/${"i".repeat(90)}/${"f".repeat(90)}`,
    );
    expect(marker.length).toBeGreaterThan(250);
    const clipped = value.slice(0, 24);
    const filler = (size: number) => "word ".repeat(Math.ceil(size / 5)).slice(0, size);
    const before = `${filler(300)} ${marker} `;
    const text = `${before}${filler(1060 - before.length - clipped.length)}${clipped}`;
    expect(text.length).toBe(1060);
    // The same text without the marker is the baseline: masking cuts it there.
    const plain = `${filler(before.length)}${text.slice(before.length)}`;
    expect(redactSecretText(plain, [long]).matches).toBe(1);
    const result = redactSecretText(text, [long]);
    expect(result.matches).toBe(1);
    expect(result.text).not.toContain(clipped);
    expect(result.text).toContain(marker);
  });

  test("an archived row keeps its exact numbers and keys and decodes its lossless columns", () => {
    // The lossless text codec writes a NUL as a tag between spaces.
    const nul = ` ${LOSSLESS_TEXT_PREFIX}0000; `;
    const prompt = `nul${nul}then ${VALUE}`;
    const row =
      `{"id":"r1","position":1.50000000000000000001,"prompt":${JSON.stringify(prompt)},` +
      `"prompt_codec_version":1,"payload":{"${VALUE}":"x ${VALUE}"},"payload_codec_version":null}`;
    const members = jsonObjectMembers(row).map((member) => member.key);
    expect(members).toEqual([
      "id",
      "position",
      "prompt",
      "prompt_codec_version",
      "payload",
      "payload_codec_version",
    ]);
    const result = redactJsonRowText(row, new Set(["prompt"]), [matcher]);
    expect(result.matches).toBe(2);
    expect(result.text).toContain('"position":1.50000000000000000001');
    // Keys are never rewritten.
    expect(result.text).toContain(`{"${VALUE}":"x ${matcher.marker}"}`);
    const parsed = JSON.parse(result.text) as { prompt: string };
    expect(parsed.prompt).toBe(`nul${nul}then ${matcher.marker}`);
    expect(redactJsonRowText(result.text, new Set(["prompt"]), [matcher]).matches).toBe(0);
  });
});

describe("secret history scrub pattern matchers", () => {
  const PASSWORD = "fakePa55-word";
  const TOKEN = `ghp_${"F4KE".repeat(9)}`;

  test("a URL password limited to one host is replaced there and nowhere else", () => {
    const [matcher] = secretRedactionMatchersForPatterns([
      { kind: "url_password", hosts: ["db-one.example.test"] },
    ]);
    const text = [
      `OPENGENI_DATABASE_URL=postgres://app:${PASSWORD}@DB-One.example.test:5432/app?sslmode=require`,
      `OTHER_URL=postgres://app:${PASSWORD}@db-two.example.test:5432/app`,
      "plain words: fakePa55-word without a URL",
    ].join("\n");
    const result = redactSecretText(text, [matcher!]);
    expect(result.matches).toBe(1);
    expect(result.text).toContain(
      "postgres://app:[redacted: url_password]@DB-One.example.test:5432/app?sslmode=require",
    );
    expect(result.text).toContain(`postgres://app:${PASSWORD}@db-two.example.test`);
    expect(result.text).toContain("plain words: fakePa55-word without a URL");
    expect(redactSecretText(result.text, [matcher!])).toEqual({ text: result.text, matches: 0 });
  });

  test("a URL password without hosts is replaced for every host, inside stored JSON too", () => {
    const [matcher] = secretRedactionMatchersForPatterns([{ kind: "url_password" }]);
    const json = JSON.stringify({
      output: `a=postgres://app:${PASSWORD}@db-one.example.test/x b=redis://:${PASSWORD}@cache:6379`,
    });
    const result = redactJsonText(json, null, [matcher!]);
    expect(result.matches).toBe(2);
    expect(result.text).not.toContain(PASSWORD);
    expect(JSON.parse(result.text)).toEqual({
      output:
        "a=postgres://app:[redacted: url_password]@db-one.example.test/x b=redis://:[redacted: url_password]@cache:6379",
    });
  });

  test("GitHub tokens are replaced on their own and as URL passwords; other text is kept", () => {
    const [matcher] = secretRedactionMatchersForPatterns([{ kind: "github_token" }]);
    const text = `push ${TOKEN} then https://x-access-token:${TOKEN}@github.com/o/r.git and https://u:${PASSWORD}@h.example.test`;
    const result = redactSecretText(text, [matcher!]);
    expect(result.matches).toBe(2);
    expect(result.text).not.toContain(TOKEN);
    expect(result.text).toContain(`https://u:${PASSWORD}@h.example.test`);
    expect(redactSecretText(result.text, [matcher!]).matches).toBe(0);
  });

  test("a GitHub token inside a longer URL password is replaced, and only the token", () => {
    const [matcher] = secretRedactionMatchersForPatterns([{ kind: "github_token" }]);
    for (const url of [
      `https://user:${TOKEN}:x@github.com/o/r`,
      `https://user:${TOKEN}%0A@github.com/o/r`,
    ]) {
      const result = redactSecretText(url, [matcher!]);
      expect(result.matches).toBe(1);
      expect(result.text).not.toContain(TOKEN);
      expect(result.text).toContain("https://user:[redacted: github_token]");
      expect(result.text).toContain("@github.com/o/r");
      expect(redactSecretText(result.text, [matcher!]).matches).toBe(0);
    }
    // Like the detector, a token-shaped run without a digit is not a token.
    const letters = `ghp_${"a".repeat(36)}`;
    expect(redactSecretText(`https://user:${letters}:x@github.com/o/r`, [matcher!]).matches).toBe(
      0,
    );
    expect(redactSecretText(`https://user:${letters}@github.com/o/r`, [matcher!]).matches).toBe(0);
  });

  test("a URL password right before an earlier marker's host is still found", () => {
    const [matcher] = secretRedactionMatchersForPatterns([{ kind: "url_password" }]);
    const text = `postgres://app:${PASSWORD}@[redacted: secret:V/db/host]:5432/app`;
    const result = redactSecretText(text, [matcher!]);
    expect(result).toEqual({
      text: "postgres://app:[redacted: url_password]@[redacted: secret:V/db/host]:5432/app",
      matches: 1,
    });
  });

  test("a kept marker is hidden behind protected placeholders of its exact length", () => {
    // Both masking modules skip exactly this shape.
    const protectedPiece = /^\[masked [a-z0-9 _-]{1,40}\]$/u;
    const seen: string[] = [];
    const spy = {
      marker: "[redacted: spy]",
      redact: (text: string) => {
        seen.push(text);
        return text;
      },
    };
    const labels = ["secret", "url_password", "github_token"];
    // Every marker length a reference can give, spread over its three
    // segments (each has its own length limit).
    for (let size = 3; size <= 287; size += 1) {
      const vault = Math.floor(size / 3);
      const item = Math.floor((size - vault) / 2);
      labels.push(
        `secret:${"v".repeat(vault)}/${"i".repeat(item)}/${"f".repeat(size - vault - item)}`,
      );
    }
    for (const label of labels) {
      const marker = secretRedactionMarker(label);
      seen.length = 0;
      const text = `a ${marker} b`;
      expect(redactSecretText(text, [spy])).toEqual({ text, matches: 0 });
      const run = seen[0]!.slice(2, -2);
      expect(run).not.toContain("[redacted: ");
      const pieces = run.split(/(?<=\])(?=\[)/u);
      for (const piece of pieces) expect(piece).toMatch(protectedPiece);
      if (marker.length >= 21) expect(run.length).toBe(marker.length);
    }
  });

  test("a cell larger than one scan window is scanned whole, with no match cut in two", () => {
    const [matcher] = secretRedactionMatchersForPatterns([{ kind: "github_token" }]);
    const filler = "x".repeat(70);
    const text = Array.from({ length: 40 }, () => `${filler} ${TOKEN}`).join(" ");
    const seen: number[] = [];
    const masked = maskInPatternWindows(
      text,
      (window) => {
        seen.push(window.length);
        return matcher!.redact(window);
      },
      500,
    );
    expect(seen.length).toBeGreaterThan(5);
    expect(masked).not.toContain(TOKEN);
    expect(masked.split("[redacted: github_token]").length - 1).toBe(40);
    // Past the 4,000,000-character bound of one shape scan, too.
    const huge = `${"y ".repeat(2_100_000)}${TOKEN}`;
    expect(matcher!.redact(huge)).not.toContain(TOKEN);
  });
});

describe("secret history scrub markers", () => {
  // The cell writer's marker shape (1091, session_secret_redaction_shape_v1),
  // plus the 300-code-point cap the contract documents.
  const markerShape = /^\[redacted: [^\]\r\n"\\]{1,300}\]$/u;

  test("control characters, quotes, backslashes, brackets and lone surrogates are dropped", () => {
    const marker = secretRedactionMarker('se\tcr\u0000et]"\\\ud800:\u001fname');
    expect(marker).toBe("[redacted: secret:name]");
    expect(markerShape.test(marker)).toBe(true);
    // It reads the same inside JSON text, so a JSON cell passes the shape check.
    expect(JSON.stringify(marker)).toBe(`"${marker}"`);
  });

  test("a long label is cut at 300 code points without splitting a character", () => {
    const marker = secretRedactionMarker("\u{1F510}".repeat(400));
    const label = marker.slice("[redacted: ".length, -1);
    expect(Array.from(label)).toHaveLength(300);
    expect(label).toBe("\u{1F510}".repeat(300));
    expect(markerShape.test(marker)).toBe(true);
    expect(JSON.stringify(marker)).toBe(`"${marker}"`);
  });

  test("an empty or unusable label falls back to a generic one", () => {
    expect(secretRedactionMarker("")).toBe("[redacted: secret]");
    expect(secretRedactionMarker("\n\r]")).toBe("[redacted: secret]");
  });
});
