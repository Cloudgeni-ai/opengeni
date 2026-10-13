import { describe, expect, test } from "bun:test";

import {
  boundClientErrorText,
  CLIENT_ERROR_DETAIL_FIELDS,
  CLIENT_ERROR_DETAIL_MAX_BYTES,
  CLIENT_ERROR_REPORT_MAX_BYTES,
  isProjectedClientErrorText,
  projectClientErrorDetail,
  scrubClientErrorText,
} from "../src/client-error-report";

const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;

describe("client error text scrubbing", () => {
  test("keeps the parts of an error that explain it", () => {
    const kept = [
      "Minified React error #130; visit https://react.dev/errors/130?args[]=undefined&args[]= for the full message",
      "TypeError: Cannot read properties of undefined (reading 'artifactId')",
      "    at ArtifactPageChrome (https://app.example.test/assets/artifact-page-chrome-DkF3x9aB.js:1:2345)",
      "    at https://app.example.test/assets/management-ui-primitives-entries-aware-merge-Bq7dC2xZ.js:12:9",
      "Session 7c9e6679-7425-40de-944b-e07fc1f90ae7 was not found",
      "Failed to fetch dynamically imported module: https://app.example.test/assets/session-route-AbC12345.js",
      "Basic authentication failed\n\tat login (auth.ts:4:2)",
      "Expected token but got end of input",
    ];
    for (const text of kept) expect(scrubClientErrorText(text)).toBe(text);
  });

  test("redacts credentials and drops query strings", () => {
    const cases: Array<[string, string]> = [
      [
        "GET https://api.example.test/v1/files?token=abc123&sig=zz#frag failed",
        "GET https://api.example.test/v1/files failed",
      ],
      [
        "at load (https://app.example.test/assets/a.js?v=3:10:20)",
        "at load (https://app.example.test/assets/a.js:10:20)",
      ],
      ["Authorization: Bearer abc.DEF-123_456", "Authorization: [redacted] [redacted]"],
      ["header Bearer abc.DEF-123_456 rejected", "header Bearer [redacted] rejected"],
      [
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U bad",
        "jwt [redacted] bad",
      ],
      ["key sk-proj-abcDEF1234567890xyz leaked", "key [redacted] leaked"],
      ["ghp_0123456789abcdefABCDEF0123", "[redacted]"],
      ["AKIAIOSFODNN7EXAMPLE", "[redacted]"],
      ['{"password":"hunter2","user":"a"}', '{"password":"[redacted]","user":"a"}'],
      ["api_key=s3cr3t; next", "api_key=[redacted]; next"],
      ["client_secret: abc", "client_secret: [redacted]"],
      ["opaque Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg== end", "opaque [redacted] end"],
      ["bell\u0007and\r\nnewline", "bell and\nnewline"],
      ["lone \uD800 surrogate", "lone \uFFFD surrogate"],
    ];
    for (const [input, expected] of cases) expect(scrubClientErrorText(input)).toBe(expected);
  });

  test("is idempotent, including on truncated output", () => {
    const samples = [
      "token=abc then Authorization: Bearer x1y2z3w4v5 and https://a.test/p?q=1",
      `password: ${"a1".repeat(40)} ${"x".repeat(200)}`,
      `api_key=${"q".repeat(CLIENT_ERROR_DETAIL_MAX_BYTES.message)}`,
    ];
    for (const sample of samples) {
      const once = scrubClientErrorText(sample);
      expect(scrubClientErrorText(once)).toBe(once);
      for (const max of [16, 24, 40, 64]) {
        const bounded = boundClientErrorText(once, max);
        expect(scrubClientErrorText(bounded)).toBe(bounded);
      }
    }
  });
});

describe("client error detail projection", () => {
  test("bounds each field in UTF-8 bytes on a character boundary", () => {
    const bounded = boundClientErrorText("é".repeat(100), 51);
    expect(utf8(bounded)).toBeLessThanOrEqual(51);
    expect(bounded.endsWith("…[truncated]")).toBe(true);
    expect(bounded.startsWith("é")).toBe(true);
    expect(boundClientErrorText("short", 51)).toBe("short");
  });

  test("scrubs, bounds and drops empty or non-string fields", () => {
    const detail = projectClientErrorDetail({
      name: "TypeError",
      message: "token=abc failed",
      stack: `TypeError\n${"    at frame (https://app.example.test/assets/a.js:1:1)\n".repeat(200)}`,
      componentStack: 42 as unknown as string,
    });
    expect(detail?.name).toBe("TypeError");
    expect(detail?.message).toBe("token=[redacted] failed");
    expect(utf8(detail!.stack!)).toBeLessThanOrEqual(CLIENT_ERROR_DETAIL_MAX_BYTES.stack);
    expect(detail?.stack?.startsWith("TypeError\n    at frame")).toBe(true);
    expect(detail).not.toHaveProperty("componentStack");
    expect(projectClientErrorDetail({ name: "  ", message: undefined })).toBeUndefined();
    expect(projectClientErrorDetail(null)).toBeUndefined();
    for (const field of CLIENT_ERROR_DETAIL_FIELDS) {
      const value = detail?.[field];
      if (value) expect(isProjectedClientErrorText(value, field)).toBe(true);
    }
    expect(isProjectedClientErrorText("token=abc", "message")).toBe(false);
    expect(isProjectedClientErrorText("x".repeat(129), "name")).toBe(false);
  });

  test("a report with every field at its worst-case JSON size fits the body limit", () => {
    // Quotes and backslashes double under JSON escaping.
    const error = Object.fromEntries(
      CLIENT_ERROR_DETAIL_FIELDS.map((field) => [
        field,
        '"'.repeat(CLIENT_ERROR_DETAIL_MAX_BYTES[field]),
      ]),
    );
    const body = JSON.stringify({
      kind: "unhandled_rejection",
      route: `/${"a".repeat(158)}`,
      revision: "r".repeat(64),
      error,
    });
    expect(utf8(body)).toBeLessThanOrEqual(CLIENT_ERROR_REPORT_MAX_BYTES);
  });
});
