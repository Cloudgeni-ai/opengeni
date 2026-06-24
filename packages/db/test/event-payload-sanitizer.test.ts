import { describe, expect, test } from "bun:test";
import { sanitizeEventPayload, sanitizeEventString } from "../src/event-payload-sanitizer";

const NUL = String.fromCharCode(0);
const REPLACEMENT = "�";
const LONE_HIGH = "\uD800";
const LONE_LOW = "\uDFFF";
const VALID_PAIR = "\u{1F600}"; // grinning face emoji, a valid surrogate pair

/**
 * A value Postgres `jsonb` accepts must contain no NUL bytes and no lone UTF-16
 * surrogates. Mirror that check so the tests fail the same way the INSERT would.
 */
function isJsonbSafe(value: string): boolean {
  if (value.includes(NUL)) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return false; // lone low surrogate
    }
  }
  return true;
}

describe("sanitizeEventString", () => {
  test("strips NUL bytes", () => {
    expect(sanitizeEventString(`a${NUL}b${NUL}`)).toBe("ab");
  });

  test("replaces a lone high surrogate with the replacement char", () => {
    expect(sanitizeEventString(`x${LONE_HIGH}y`)).toBe(`x${REPLACEMENT}y`);
  });

  test("replaces a lone low surrogate with the replacement char", () => {
    expect(sanitizeEventString(`x${LONE_LOW}y`)).toBe(`x${REPLACEMENT}y`);
  });

  test("preserves a valid surrogate pair (emoji)", () => {
    expect(sanitizeEventString(`hi ${VALID_PAIR}!`)).toBe(`hi ${VALID_PAIR}!`);
  });

  test("returns the same reference when already clean (no allocation)", () => {
    const clean = "ordinary log line with pässwörd ✓ and emoji \u{1F600}";
    expect(sanitizeEventString(clean)).toBe(clean);
  });
});

describe("sanitizeEventPayload (deep walk)", () => {
  test("sanitizes nested strings in objects and arrays", () => {
    const payload = {
      type: "agent.toolCall.output",
      output: `chrome log${NUL}line\nrandom ${LONE_HIGH} bytes`,
      nested: {
        list: [`ok`, `binary${NUL}cat`, { deep: `${LONE_LOW}tail` }],
      },
      count: 42,
      flag: true,
    };

    const cleaned = sanitizeEventPayload(payload);

    expect(cleaned.output).toBe(`chrome logline\nrandom ${REPLACEMENT} bytes`);
    expect(cleaned.nested.list[1] as string).toBe("binarycat");
    expect((cleaned.nested.list[2] as { deep: string }).deep).toBe(`${REPLACEMENT}tail`);
    expect(cleaned.count).toBe(42);
    expect(cleaned.flag).toBe(true);
  });

  test("sanitizes object keys carrying NUL / surrogates", () => {
    const payload = { [`k${NUL}ey`]: "v", [`${LONE_HIGH}`]: "w" };
    const cleaned = sanitizeEventPayload(payload) as Record<string, string>;
    expect(Object.keys(cleaned)).toEqual(["key", REPLACEMENT]);
  });

  test("FAILURE-SENSITIVE: a payload that would crash the INSERT round-trips as valid jsonb", () => {
    // Reproduces the turn-killer: exec output with a NUL byte AND a lone
    // surrogate inside an agent.toolCall.output / sandbox.command.output event.
    const rawExecOutput = `crashpad ${NUL} dump ${LONE_HIGH} ${VALID_PAIR} end`;
    const eventPayload = {
      kind: "sandbox.command.output",
      command: `cat ${NUL} /bin/ls`,
      output: rawExecOutput,
      stream: "stdout",
    };

    // Before sanitization the raw string values are NOT jsonb-safe (the pg
    // driver ships the actual UTF-8 bytes, so a NUL byte / lone surrogate in the
    // value -- not a JSON-escaped form -- is what makes the INSERT throw).
    expect(isJsonbSafe(eventPayload.output)).toBe(false);
    expect(isJsonbSafe(eventPayload.command)).toBe(false);

    const cleaned = sanitizeEventPayload(eventPayload);

    // After sanitization every string value is jsonb-safe.
    expect(isJsonbSafe(cleaned.output)).toBe(true);
    expect(isJsonbSafe(cleaned.command)).toBe(true);

    // ...and the cleaned payload survives a JSON serialize/parse round-trip.
    const reparsed = JSON.parse(JSON.stringify(cleaned)) as typeof cleaned;
    expect(reparsed.output).toBe(`crashpad  dump ${REPLACEMENT} ${VALID_PAIR} end`);
    expect(reparsed.command).toBe("cat  /bin/ls");
    expect(reparsed.kind).toBe("sandbox.command.output");
    expect(reparsed.stream).toBe("stdout");
  });
});
