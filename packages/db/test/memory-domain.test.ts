import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  estimateMemoryTokens,
  hashMemoryText,
  isMemoryTextTooLong,
  MEMORY_TEXT_MAX_CHARS,
  normalizeMemoryText,
  renderWorkspaceMemoryBlock,
  sanitizeMemoryText,
  shortMemoryId,
  WORKSPACE_MEMORY_BLOCK_HEADER_POPULATED,
  WORKSPACE_MEMORY_BLOCK_TOKEN_BUDGET,
  type MemoryBlockRecord,
} from "../src/memory-domain";

describe("normalizeMemoryText", () => {
  test("collapses whitespace, trims, lowercases", () => {
    expect(normalizeMemoryText("  Deploy   from\tMAIN\nonly  ")).toBe("deploy from main only");
  });

  test("is idempotent", () => {
    const once = normalizeMemoryText("Foo\t Bar  BAZ");
    expect(normalizeMemoryText(once)).toBe(once);
  });

  test("matches the migration-0045 SQL normalization (collapse -> trim -> lower)", () => {
    // SQL: lower(btrim(regexp_replace(text, '\\s+', ' ', 'g'))). Replicated here as
    // the parity oracle; if the app and this diverge, exact-dedup silently misses.
    const sqlEquivalent = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
    for (const sample of ["  A  b\tC  ", "already normal", "MixedCase\nLines", "\n\ttrailing\t\n"]) {
      expect(normalizeMemoryText(sample)).toBe(sqlEquivalent(sample));
    }
  });
});

describe("hashMemoryText", () => {
  test("hashes the normalized text with sha256 hex (migration parity)", () => {
    const text = "  Staging  deploys FROM main  ";
    const expected = createHash("sha256").update(normalizeMemoryText(text), "utf8").digest("hex");
    expect(hashMemoryText(text)).toBe(expected);
  });

  test("differently-formatted equivalents collide (dedup key)", () => {
    expect(hashMemoryText("Deploy from main only")).toBe(hashMemoryText("  deploy   from\tmain   only "));
  });

  test("distinct facts do not collide", () => {
    expect(hashMemoryText("Deploy from main")).not.toBe(hashMemoryText("Deploy from staging"));
  });
});

describe("sanitizeMemoryText", () => {
  test("strips control characters and collapses to a single line", () => {
    const { text } = sanitizeMemoryText("line one\u0000\u0007\nline two\ttabbed");
    expect(text).toBe("line one line two tabbed");
  });

  test("redacts common secret shapes and counts them", () => {
    const cases: Array<[string, string]> = [
      ["key is AKIAIOSFODNN7EXAMPLE done", "AKIAIOSFODNN7EXAMPLE"],
      ["token sk-abcdefghijklmnopqrstuvwx", "sk-abcdefghijklmnopqrstuvwx"],
      ["gho_16charsatleastxxxxxxxxxx here", "gho_16charsatleastxxxxxxxxxx"],
      ["password=hunter2secret trailing", "hunter2secret"],
    ];
    for (const [input, secret] of cases) {
      const { text, redactionCount } = sanitizeMemoryText(input);
      expect(text).not.toContain(secret);
      expect(text).toContain("[REDACTED]");
      expect(redactionCount).toBeGreaterThanOrEqual(1);
    }
  });

  test("redacts a PEM private key block", () => {
    const pem = "note -----BEGIN RSA PRIVATE KEY-----\nMIIabc123\n-----END RSA PRIVATE KEY----- end";
    const { text, redactionCount } = sanitizeMemoryText(pem);
    expect(text).not.toContain("MIIabc123");
    expect(redactionCount).toBe(1);
  });

  test("leaves clean text unchanged with zero redactions", () => {
    const { text, redactionCount } = sanitizeMemoryText("Prefer Terraform over Pulumi for new infra.");
    expect(text).toBe("Prefer Terraform over Pulumi for new infra.");
    expect(redactionCount).toBe(0);
  });
});

describe("isMemoryTextTooLong / estimateMemoryTokens / shortMemoryId", () => {
  test("cap is exclusive at the max", () => {
    expect(isMemoryTextTooLong("x".repeat(MEMORY_TEXT_MAX_CHARS))).toBe(false);
    expect(isMemoryTextTooLong("x".repeat(MEMORY_TEXT_MAX_CHARS + 1))).toBe(true);
  });

  test("token estimate is char/4 rounded up", () => {
    expect(estimateMemoryTokens("")).toBe(0);
    expect(estimateMemoryTokens("abcd")).toBe(1);
    expect(estimateMemoryTokens("abcde")).toBe(2);
  });

  test("short id is the first 8 chars of the uuid", () => {
    expect(shortMemoryId("3f9a1b2c-1234-4abc-8def-0123456789ab")).toBe("3f9a1b2c");
  });
});

describe("renderWorkspaceMemoryBlock", () => {
  const record = (over: Partial<MemoryBlockRecord> & Pick<MemoryBlockRecord, "id" | "kind" | "text">): MemoryBlockRecord => ({
    pinned: false,
    ...over,
  });

  test("returns null when only episodic records exist (episodic is excluded)", () => {
    expect(renderWorkspaceMemoryBlock([record({ id: "aaaaaaaa-0000-4000-8000-000000000000", kind: "episodic", text: "happened once" })])).toBeNull();
  });

  test("sections by kind, renders short ids, and carries the standing header", () => {
    const block = renderWorkspaceMemoryBlock([
      record({ id: "11111111-0000-4000-8000-000000000000", kind: "preference", text: "Prefer Terraform." }),
      record({ id: "22222222-0000-4000-8000-000000000000", kind: "semantic", text: "Staging deploys from main." }),
      record({ id: "33333333-0000-4000-8000-000000000000", kind: "procedural", text: "Run bun run typecheck before pushing." }),
      record({ id: "44444444-0000-4000-8000-000000000000", kind: "decision", text: "Chose Azure gpt-5.5." }),
      record({ id: "55555555-0000-4000-8000-000000000000", kind: "episodic", text: "excluded" }),
    ])!;
    expect(block.startsWith(WORKSPACE_MEMORY_BLOCK_HEADER_POPULATED)).toBe(true);
    expect(block).toContain("### Preferences\n- [11111111] Prefer Terraform.");
    expect(block).toContain("### Facts & environment\n- [22222222] Staging deploys from main.");
    expect(block).toContain("### How we do things");
    expect(block).toContain("### Decisions");
    expect(block).not.toContain("excluded");
    // Sections appear in the fixed order preference -> semantic -> procedural -> decision.
    expect(block.indexOf("### Preferences")).toBeLessThan(block.indexOf("### Facts & environment"));
    expect(block.indexOf("### Facts & environment")).toBeLessThan(block.indexOf("### How we do things"));
    expect(block.indexOf("### How we do things")).toBeLessThan(block.indexOf("### Decisions"));
  });

  test("drops whole entries once the token budget is exhausted (never truncates mid-entry)", () => {
    // Each entry ~200 chars (~50 tokens); many entries overflow the ~2500-token budget.
    const many: MemoryBlockRecord[] = Array.from({ length: 400 }, (_, index) =>
      record({
        id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
        kind: "semantic",
        text: `Fact number ${index}: ${"detail ".repeat(30)}`.trim(),
      }));
    const block = renderWorkspaceMemoryBlock(many)!;
    expect(estimateMemoryTokens(block)).toBeLessThanOrEqual(WORKSPACE_MEMORY_BLOCK_TOKEN_BUDGET);
    // At least the first entries survived, and every rendered entry is intact
    // (no line ends mid-word without its full "detail" run being present).
    expect(block).toContain("- [00000000] Fact number 0:");
    for (const line of block.split("\n").filter((l) => l.startsWith("- ["))) {
      expect(line.endsWith("detail")).toBe(true);
    }
  });

  test("does not include the first entry when it alone would exceed the token budget", () => {
    const block = renderWorkspaceMemoryBlock([
      record({
        id: "99999999-0000-4000-8000-000000000000",
        kind: "semantic",
        text: "oversized ".repeat(WORKSPACE_MEMORY_BLOCK_TOKEN_BUDGET * 2),
      }),
    ])!;
    expect(block).toBe(WORKSPACE_MEMORY_BLOCK_HEADER_POPULATED);
    expect(block).not.toContain("### Facts & environment");
    expect(block).not.toContain("[99999999]");
  });

  test("pinned-first input order is preserved within its section", () => {
    const block = renderWorkspaceMemoryBlock([
      record({ id: "aaaaaaaa-0000-4000-8000-000000000000", kind: "preference", text: "Pinned pref.", pinned: true }),
      record({ id: "bbbbbbbb-0000-4000-8000-000000000000", kind: "preference", text: "Unpinned pref." }),
    ])!;
    expect(block.indexOf("[aaaaaaaa]")).toBeLessThan(block.indexOf("[bbbbbbbb]"));
  });
});
