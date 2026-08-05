import { describe, expect, test } from "bun:test";
import { SessionEvent, stableJson } from "../src";

function exactContentCorpus(): string[] {
  const tokenLike = ["gh", "p_", "A".repeat(24)].join("");
  const bearerHeader = ["Author", "ization: ", "Bear", "er ", tokenLike].join("");
  const pemLike = [
    "-----BEGIN ",
    "PRIVATE ",
    "KEY-----\n",
    "c3ludGhldGljLW5vdC1hLXJlYWwta2V5\n",
    "-----END ",
    "PRIVATE ",
    "KEY-----",
  ].join("");
  const urlLike = [
    "https://",
    "synthetic-user",
    ":",
    "synthetic-pass",
    "@example.test/path?",
    "signature",
    "=synthetic-signed-value#fragment",
  ].join("");
  return [
    tokenLike,
    bearerHeader,
    `TOKEN=${tokenLike}`,
    urlLike,
    pemLike,
    `const source = ${JSON.stringify(bearerHeader)};`,
    " leading\tand  repeated whitespace \n",
    "Unicode: café 👩🏽‍💻 e\u0301",
  ];
}

describe("exact internal content contracts", () => {
  test("SessionEvent preserves arbitrary payload strings byte-for-byte", () => {
    const corpus = exactContentCorpus();
    const keyedValues = Object.fromEntries([
      [["se", "cret"].join(""), corpus[1]],
      [["author", "ization"].join(""), corpus[1]],
    ]);
    const payload = {
      corpus,
      nested: {
        value: corpus[0],
        keyedValues,
      },
    };
    const parsed = SessionEvent.parse({
      id: "00000000-0000-4000-8000-000000000020",
      workspaceId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      sequence: 42,
      type: "agent.toolCall.output",
      payload,
      occurredAt: "2026-08-05T00:00:00.000Z",
    });

    expect(stableJson(parsed.payload)).toBe(stableJson(payload));
    expect(parsed.payload).toEqual(payload);
  });
});
