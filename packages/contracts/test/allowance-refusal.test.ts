import { describe, expect, test } from "bun:test";
import { AllowanceExhaustedRefusal } from "../src/usage-allowances";
import {
  allowanceExhaustedMessage,
  parseAllowanceExhaustedRefusal,
} from "../src/allowance-refusal";

const refusal = {
  code: "allowance_exhausted" as const,
  scope: "member" as const,
  subjectId: "user:member",
  resetsAt: "2026-10-01T02:30:00+02:00",
  message: "Member allowance exhausted.",
};

describe("bounded allowance refusal presentation", () => {
  test("pure presentation parser matches the canonical bounded timestamp and member contract", () => {
    for (const resetsAt of [
      null,
      "2026-10-01T00:00Z",
      "2026-10-01T00:00:00.123456Z",
      "2026-10-01T02:30:00+02:30",
      "2026-10-01T02:30-02:30",
      "2000-02-29T00:00Z",
      "1900-02-29T00:00Z",
      "2024-02-29T00:00Z",
      "2026-02-29T00:00Z",
      "2026-04-31T00:00Z",
      "2026-12-31T23:59:59Z",
      "2026-10-01T24:00:00Z",
      "2026-10-01T00:60:00Z",
      "2026-10-01T00:00:60Z",
      "2026-10-01T00:00:00+24:00",
      "2026-10-01T00:00:00+01:60",
      "2026-10-01T00:00:00+0200",
      "2026-10-01T00:00:00",
      "2026-10-01",
    ]) {
      for (const subjectId of [
        undefined,
        "member",
        "",
        "\0",
        "x".repeat(1_024),
        "x".repeat(1_025),
      ]) {
        const input = { ...refusal, resetsAt, subjectId };
        expect(parseAllowanceExhaustedRefusal(input) !== null).toBe(
          AllowanceExhaustedRefusal.safeParse(input).success,
        );
      }
    }
  });
  test("accepts LimitDecision and API details without publishing wrappers or diagnostics", () => {
    const parsed = parseAllowanceExhaustedRefusal({
      ...refusal,
      allowed: false,
      sql: "PRIVATE_SQL",
      wrapper: { token: "PRIVATE_TOKEN" },
    });
    expect(parsed).toEqual(refusal);
    expect(
      parseAllowanceExhaustedRefusal({
        code: refusal.code,
        message: refusal.message,
        status: 402,
        details: { ...refusal, sql: "PRIVATE_SQL" },
      }),
    ).toEqual(refusal);
  });

  test("bounds Unicode message bytes and strips control characters", () => {
    const parsed = parseAllowanceExhaustedRefusal({
      ...refusal,
      message: `\0${"🧪".repeat(1_000)}`,
    })!;
    expect(new TextEncoder().encode(parsed.message).byteLength).toBeLessThanOrEqual(1_024);
    expect(parsed.message).not.toMatch(/[\0�]/u);
  });

  test("rejects malformed scope, subject and reset timestamps", () => {
    for (const fields of [
      { scope: "organization" },
      { resetsAt: "invalid" },
      { resetsAt: "2026-10-01" },
      { resetsAt: "2026-99-99T00:00:00Z" },
      { resetsAt: "x".repeat(10_000) },
      { subjectId: "x".repeat(1_025) },
      { subjectId: "user:\0" },
      { message: null },
    ])
      expect(parseAllowanceExhaustedRefusal({ ...refusal, ...fields })).toBeNull();
    expect(parseAllowanceExhaustedRefusal({ ...refusal, code: "insufficient_credits" })).toBeNull();
  });

  test("normalizes reset to UTC and names the right administrator for each scope", () => {
    const member = allowanceExhaustedMessage(parseAllowanceExhaustedRefusal(refusal)!);
    expect(member).toContain("workspace administrator");
    expect(member).toContain("2026-10-01 00:30 UTC");
    expect(member).not.toContain("user:member");
    const workspace = allowanceExhaustedMessage(
      parseAllowanceExhaustedRefusal({
        ...refusal,
        scope: "workspace",
        resetsAt: null,
      })!,
    );
    expect(workspace).toContain("organization administrator");
    expect(workspace).toContain("full-access organization API key");
    expect(workspace).toContain("no automatic reset");
    for (const text of [member, workspace]) expect(text).not.toMatch(/buy credits|subscription/i);
  });
});
