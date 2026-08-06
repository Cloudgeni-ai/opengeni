import { describe, expect, test } from "bun:test";
import { durableUserHistoryItem, memoryTextForStorage } from "../src";

function syntheticExactText(): string {
  const tokenLike = ["sk", "-", "synthetic_", "Z".repeat(24)].join("");
  const urlLike = [
    "https://example.test/?",
    "sig",
    "=synthetic-signed-value&",
    "token",
    "=synthetic-query-value",
  ].join("");
  const pemLike = [
    "-----BEGIN ",
    "PRIVATE ",
    "KEY-----\nsynthetic\n-----END ",
    "PRIVATE ",
    "KEY-----\n",
  ].join("");
  return [
    "\n  const header = ",
    JSON.stringify(["Bear", "er ", tokenLike].join("")),
    ";\n",
    `TOKEN=${tokenLike}\n`,
    `${urlLike}\n`,
    pemLike,
    "tabs\tand  repeated spaces 👩🏽‍💻",
  ].join("");
}

describe("exact DB-bound content", () => {
  test("durable user history preserves accepted prompt text exactly", () => {
    const text = syntheticExactText();
    expect(durableUserHistoryItem(text, [])).toEqual({
      type: "message",
      role: "user",
      content: text,
    });
  });

  test("workspace memory preserves arbitrary accepted text exactly", () => {
    const text = syntheticExactText();
    expect(memoryTextForStorage(text)).toBe(text);
  });
});
