import { expect, test } from "bun:test";
import { normalizedCredentialHeaders } from "../src/connection-token-resolver";

test("native credential headers are copied and empty credentials require explicit permission", () => {
  const input = { Authorization: "Bearer synthetic", "X-Api-Key": "synthetic" };
  const result = normalizedCredentialHeaders(input);
  expect(result).toEqual(input);
  expect(result).not.toBe(input);
  input.Authorization = "changed";
  expect(result.Authorization).toBe("Bearer synthetic");
  expect(() => normalizedCredentialHeaders({})).toThrow("invalid header count");
  expect(normalizedCredentialHeaders({}, true)).toEqual({});
});

const unsafeHeaders: Array<{ headers: Record<string, string> }> = [
  { headers: { Host: "other.example" } },
  { headers: { "Content-Length": "5" } },
  { headers: { "Proxy-Authorization": "synthetic" } },
  { headers: { "Sec-Fetch-Site": "same-origin" } },
  { headers: { "bad header": "synthetic" } },
  { headers: { Authorization: "injected\r\nX-Other: value" } },
  { headers: { Authorization: "injected\0value" } },
  { headers: { Authorization: "" } },
  { headers: { Authorization: "a".repeat(16_385) } },
  { headers: { ["a".repeat(257)]: "synthetic" } },
];
test.each(unsafeHeaders)(
  "native credential validation rejects unsafe header delivery (%#)",
  ({ headers }) => {
    expect(() => normalizedCredentialHeaders(headers)).toThrow("invalid header");
  },
);

test("native credential headers reject case-insensitive duplicates and excessive headers", () => {
  expect(() => normalizedCredentialHeaders({ Authorization: "one", authorization: "two" })).toThrow(
    "duplicate headers",
  );
  const excessive = Object.fromEntries(
    Array.from({ length: 33 }, (_, i) => [`X-Key-${i}`, "synthetic"]),
  );
  expect(() => normalizedCredentialHeaders(excessive)).toThrow("invalid header count");
});
