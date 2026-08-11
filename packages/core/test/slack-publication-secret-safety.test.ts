import { describe, expect, test } from "bun:test";
import { SLACK_PUBLICATION_CREDENTIAL_OMISSION, sanitizeSlackPublicationText } from "../src";

describe("Slack publication sink-local credential safety", () => {
  test("omits the closed set of credential-shaped values deterministically", () => {
    const credentials = [
      `github_pat_${"A".repeat(32)}`,
      `ghp_${"B".repeat(36)}`,
      `glpat-${"C".repeat(24)}`,
      `sk-proj-${"D".repeat(32)}`,
      `sk_live_${"E".repeat(24)}`,
      `AKIA${"F".repeat(16)}`,
      `xoxb-${"G".repeat(32)}`,
      `AIza${"H".repeat(32)}`,
      `eyJ${"I".repeat(12)}.eyJ${"J".repeat(12)}.${"K".repeat(16)}`,
    ];
    const source = credentials.join(" | ");
    const first = sanitizeSlackPublicationText(source);

    expect(first).toBe(sanitizeSlackPublicationText(source));
    for (const credential of credentials) expect(first).not.toContain(credential);
    expect(first.match(/\[credential omitted\]/g)).toHaveLength(credentials.length);
  });

  test("omits labeled, bearer, URL, and private-key material without mutating source text", () => {
    const source = [
      `api_key=${"L".repeat(24)}`,
      `Bearer ${"M".repeat(24)}`,
      `postgres://owner:${"N".repeat(24)}@db.example.test/app`,
      "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
    ].join("\n");
    const sanitized = sanitizeSlackPublicationText(source);

    expect(source).toContain("private-material");
    expect(sanitized).not.toContain("private-material");
    expect(sanitized).not.toContain("L".repeat(24));
    expect(sanitized).not.toContain("M".repeat(24));
    expect(sanitized).not.toContain("N".repeat(24));
    expect(sanitized).toContain(SLACK_PUBLICATION_CREDENTIAL_OMISSION);
  });

  test("preserves ordinary publication language and non-rendered selector-like text", () => {
    const source = "Use token budgeting for company/product and sk_live_synthetic_123456.";
    expect(sanitizeSlackPublicationText(source)).toBe(source);
  });
});
