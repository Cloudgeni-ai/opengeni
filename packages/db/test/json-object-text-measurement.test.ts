import { describe, expect, test } from "bun:test";
import { measureJsonObjectText } from "../src/json-object-text-measurement";

function expectedCounts(value: unknown): { nodes: number; properties: number } {
  let nodes = 0;
  let properties = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (Array.isArray(current)) {
      pending.push(...current);
    } else if (current !== null && typeof current === "object") {
      const entries = Object.values(current);
      properties += entries.length;
      pending.push(...entries);
    }
  }
  return { nodes, properties };
}

describe("measureJsonObjectText", () => {
  test("counts every value and every member of a valid object", () => {
    const text =
      ' \n{"a":[1,-0.5e+10,2E-3,true,false,null,"x\\n\\"\\u00e9\\ud83d\\ude00/"],"b":{},"c":[],"d":{"e":0}}\t';
    expect(measureJsonObjectText(text)).toEqual({
      validJsonObject: true,
      ...expectedCounts(JSON.parse(text)),
    });
    expect(measureJsonObjectText("{}")).toEqual({ validJsonObject: true, nodes: 1, properties: 0 });
  });

  test("matches a decoded walk for serialized values", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const build = (depth: number): unknown => {
      const pick = random();
      if (depth > 4 || pick < 0.3) {
        return [0, -1.25e-7, "text \u0001 \u2028", true, false, null][Math.floor(random() * 6)];
      }
      if (pick < 0.65)
        return Array.from({ length: Math.floor(random() * 5) }, () => build(depth + 1));
      return Object.fromEntries(
        Array.from({ length: Math.floor(random() * 5) }, (_, index) => [
          `key ${index} "\\`,
          build(depth + 1),
        ]),
      );
    };
    for (let index = 0; index < 500; index += 1) {
      const value = { root: build(0) };
      const text = JSON.stringify(value, null, index % 2 === 0 ? undefined : 2);
      expect(measureJsonObjectText(text)).toEqual({
        validJsonObject: true,
        ...expectedCounts(value),
      });
    }
  });

  test("counts duplicate keys each time they appear", () => {
    expect(measureJsonObjectText('{"a":{"b":1},"a":2}')).toEqual({
      validJsonObject: true,
      nodes: 4,
      properties: 3,
    });
  });

  test.each([
    "",
    "  ",
    "[]",
    '"text"',
    "1",
    "null",
    "{",
    "{}}",
    "{} {}",
    '{"a":1}x',
    '{"a":}',
    '{"a":1,}',
    '{"a":[1,]}',
    '{"a":[1 2]}',
    '{"a" 1}',
    "{a:1}",
    "{'a':1}",
    '{"a":01}',
    '{"a":-}',
    '{"a":1.}',
    '{"a":.5}',
    '{"a":1e}',
    '{"a":+1}',
    '{"a":tru}',
    '{"a":truex}',
    '{"a":nul}',
    '{"a":"unterminated}',
    '{"a":"raw\u0001control"}',
    '{"a":"\\x"}',
    '{"a":"\\u12"}',
    '{"a":"\\u12G4"}',
    '{"a":"\\u0000"}',
    '{"a":"\\ud800"}',
    '{"a":"\\udc00"}',
    '{"a":"\\ud800\\u0041"}',
    '{"a":"\\ud800\\n"}',
    '{"\\u0000":1}',
  ])("rejects %p", (text) => {
    expect(measureJsonObjectText(text)).toEqual({
      validJsonObject: false,
      nodes: 0,
      properties: 0,
    });
  });

  test("measures deep nesting and large documents in one pass without recursion", () => {
    const depth = 200_000;
    expect(measureJsonObjectText(`{"a":${"[".repeat(depth)}${"]".repeat(depth)}}`)).toEqual({
      validJsonObject: true,
      nodes: depth + 1,
      properties: 1,
    });
    const elements = 1_500_000;
    expect(measureJsonObjectText(`{"history":[${"0,".repeat(elements - 1)}0]}`)).toEqual({
      validJsonObject: true,
      nodes: elements + 2,
      properties: 1,
    });
  });
});
