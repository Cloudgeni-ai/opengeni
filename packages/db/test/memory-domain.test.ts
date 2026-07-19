import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  calculateMemoryTextScore,
  explainMemoryApplicability,
  estimateMemoryTokens,
  hashMemoryText,
  isMemoryTextTooLong,
  isMemoryApplicable,
  isMemoryScopeApplicable,
  MEMORY_BLOCK_RECORD_LIMIT,
  MEMORY_CONFLICT_PENALTY,
  MEMORY_FRESHNESS_MAX_AGE_MS,
  MEMORY_LABEL_MAX_COUNT,
  MEMORY_LABEL_MAX_CHARS,
  MEMORY_ROLE_KEY_MAX_CHARS,
  MEMORY_TEXT_MAX_CHARS,
  memoryFreshnessScore,
  normalizeMemoryLabel,
  normalizeMemoryLabels,
  normalizeMemoryText,
  normalizeMemoryRoleKey,
  rankMemoryRetrievalCandidates,
  renderWorkspaceMemoryBlock,
  sanitizeMemoryText,
  selectWorkspaceMemoryRecords,
  scoreMemoryRetrievalCandidate,
  shortMemoryId,
  WORKSPACE_MEMORY_BLOCK_HEADER_POPULATED,
  WORKSPACE_MEMORY_BLOCK_TOKEN_BUDGET,
  type MemoryBlockRecord,
  type MemoryRetrievalCandidate,
  type MemoryScopeSpec,
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
    for (const sample of [
      "  A  b\tC  ",
      "already normal",
      "MixedCase\nLines",
      "\n\ttrailing\t\n",
    ]) {
      expect(normalizeMemoryText(sample)).toBe(sqlEquivalent(sample));
    }
  });
});

describe("hierarchical labels and role keys", () => {
  test("normalizes labels to bounded, sorted, unique slugs", () => {
    expect(
      normalizeMemoryLabels([" Deploy ", "OPS_team", "task one", "deploy", "bad.label"]),
    ).toEqual(["deploy", "ops_team", "task-one"]);
    expect(normalizeMemoryLabel("x".repeat(MEMORY_LABEL_MAX_CHARS))).toHaveLength(
      MEMORY_LABEL_MAX_CHARS,
    );
    expect(normalizeMemoryLabel("x".repeat(MEMORY_LABEL_MAX_CHARS + 1))).toBeNull();
    expect(normalizeMemoryLabel("unsafe.label")).toBeNull();
  });

  test("bounds label count and normalizes role keys with the same fail-closed alphabet", () => {
    const labels = normalizeMemoryLabels(
      Array.from({ length: MEMORY_LABEL_MAX_COUNT + 4 }, (_, index) => `label-${index}`),
    );
    expect(labels).toHaveLength(MEMORY_LABEL_MAX_COUNT);
    expect(labels.every((label) => label.length <= MEMORY_LABEL_MAX_CHARS)).toBe(true);
    expect(normalizeMemoryRoleKey("  Incident Commander ")).toBe("incident-commander");
    expect(normalizeMemoryRoleKey("role/ops")).toBeNull();
    expect(normalizeMemoryRoleKey("r".repeat(MEMORY_ROLE_KEY_MAX_CHARS + 1))).toBeNull();
    expect(normalizeMemoryRoleKey(null)).toBeNull();
  });
});

describe("hierarchical scope applicability", () => {
  const now = "2026-07-18T12:00:00.000Z";
  const sessionId = "session-a";
  const userId = "subject-a";
  const context = {
    now,
    trustedUserSubjectId: userId,
    roleKey: "Build Operator",
    sessionId,
  } as const;

  const scopes: Array<[string, MemoryScopeSpec, boolean]> = [
    ["workspace", { scopeType: "workspace" }, true],
    ["matching user", { scopeType: "user", scopeSubjectId: userId }, true],
    ["missing user", { scopeType: "user", scopeSubjectId: userId }, false],
    ["matching role", { scopeType: "role", scopeRoleKey: "build-operator" }, true],
    ["matching session", { scopeType: "session", scopeSessionId: sessionId }, true],
    [
      "matching ephemeral",
      { scopeType: "ephemeral", scopeSessionId: sessionId, validUntil: "2026-07-18T13:00:00.000Z" },
      true,
    ],
    ["legacy", { scopeType: "legacy", legacyScope: "old-convention" }, false],
  ];

  test("evaluates typed scope matrix and fails closed for absent trusted user", () => {
    for (const [name, scope, expected] of scopes) {
      const actual = isMemoryScopeApplicable(
        scope,
        name === "missing user" ? { roleKey: context.roleKey, sessionId } : context,
      );
      expect(actual, name).toBe(expected);
    }
    expect(
      isMemoryScopeApplicable(
        { scopeType: "user", scopeSubjectId: userId },
        { roleKey: context.roleKey, sessionId },
      ),
    ).toBe(false);
  });

  test("uses the caller's one reference time for validity and ephemeral expiry", () => {
    const ephemeral = {
      scopeSpec: {
        scopeType: "ephemeral" as const,
        scopeSessionId: sessionId,
        validUntil: "2026-07-18T13:00:00.000Z",
      },
      validFrom: "2026-07-18T11:00:00.000Z",
    };
    expect(isMemoryApplicable(ephemeral, { ...context, now })).toBe(true);
    expect(isMemoryApplicable(ephemeral, { ...context, now: "2026-07-18T13:00:00.000Z" })).toBe(
      false,
    );
    expect(
      explainMemoryApplicability(ephemeral, {
        ...context,
        now: "2026-07-18T13:00:00.000Z",
      }).reasonCodes,
    ).toContain("scope.ephemeral_expired");
  });

  test("legacy workspace rows preserve V1 applicability while other legacy scopes do not", () => {
    expect(isMemoryApplicable({ scope: "workspace" }, context)).toBe(true);
    expect(isMemoryApplicable({ scope: "historical-role" }, context)).toBe(false);
  });

  test("workspace labels are admission hints for standing context, not search isolation", () => {
    const labeled = { scopeSpec: { scopeType: "workspace" as const }, labels: ["infra"] };
    expect(
      isMemoryApplicable(labeled, { ...context, mode: "standing", memoryLabels: ["infra"] }),
    ).toBe(true);
    expect(
      isMemoryApplicable(labeled, { ...context, mode: "standing", memoryLabels: ["product"] }),
    ).toBe(false);
    expect(
      isMemoryApplicable(labeled, { ...context, mode: "search", memoryLabels: ["product"] }),
    ).toBe(true);
  });
});

describe("hashMemoryText", () => {
  test("hashes the normalized text with sha256 hex (migration parity)", () => {
    const text = "  Staging  deploys FROM main  ";
    const expected = createHash("sha256").update(normalizeMemoryText(text), "utf8").digest("hex");
    expect(hashMemoryText(text)).toBe(expected);
  });

  test("differently-formatted equivalents collide (dedup key)", () => {
    expect(hashMemoryText("Deploy from main only")).toBe(
      hashMemoryText("  deploy   from\tmain   only "),
    );
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
    const pem =
      "note -----BEGIN RSA PRIVATE KEY-----\nMIIabc123\n-----END RSA PRIVATE KEY----- end";
    const { text, redactionCount } = sanitizeMemoryText(pem);
    expect(text).not.toContain("MIIabc123");
    expect(redactionCount).toBe(1);
  });

  test("leaves clean text unchanged with zero redactions", () => {
    const { text, redactionCount } = sanitizeMemoryText(
      "Prefer Terraform over Pulumi for new infra.",
    );
    expect(text).toBe("Prefer Terraform over Pulumi for new infra.");
    expect(redactionCount).toBe(0);
  });
});

describe("retrieval components and deterministic ranking", () => {
  const now = "2026-07-18T12:00:00.000Z";
  const baseCandidate = (
    over: Partial<MemoryRetrievalCandidate> = {},
  ): MemoryRetrievalCandidate => ({
    id: "aaaaaaaa-0000-4000-8000-000000000000",
    scopeSpec: { scopeType: "workspace" },
    vectorScore: 0.8,
    keywordScore: 0.4,
    updatedAt: now,
    confidence: 0.8,
    sourceRefs: [{ kind: "session_event" }],
    ...over,
  });

  test("preserves the V1 text score formula for each search mode", () => {
    expect(calculateMemoryTextScore(0.8, 0.4, "vector")).toBe(0.8);
    expect(calculateMemoryTextScore(0.8, 0.4, "keyword")).toBe(0.4);
    expect(calculateMemoryTextScore(0.8, 0.4, "hybrid")).toBeCloseTo(0.76);
    expect(calculateMemoryTextScore(0.8, null, "hybrid")).toBeCloseTo(0.52);
  });

  test("returns bounded documented components, reason codes, and the conflict penalty", () => {
    const clear = scoreMemoryRetrievalCandidate(
      baseCandidate({ labels: ["infra"], unresolvedConflict: false }),
      { now, queryLabels: ["infra"] },
    );
    const conflicted = scoreMemoryRetrievalCandidate(
      baseCandidate({ labels: ["infra"], unresolvedConflict: true }),
      { now, queryLabels: ["infra"] },
    );
    expect(clear).not.toBeNull();
    expect(conflicted).not.toBeNull();
    expect(conflicted!.conflict).toBe(MEMORY_CONFLICT_PENALTY);
    expect(conflicted!.score).toBeCloseTo(clear!.score * MEMORY_CONFLICT_PENALTY, 5);
    expect(conflicted!.reasonCodes).toContain("conflict.unresolved");
    for (const component of [
      conflicted!.score,
      conflicted!.text,
      conflicted!.scope,
      conflicted!.labels,
      conflicted!.freshness,
      conflicted!.confidence,
      conflicted!.provenance,
      conflicted!.conflict,
    ]) {
      expect(component).toBeGreaterThanOrEqual(0);
      expect(component).toBeLessThanOrEqual(1);
    }
  });

  test("freshness is monotonic, bounded, and pinned records stay fresh", () => {
    const fresh = memoryFreshnessScore(now, now);
    const old = memoryFreshnessScore(
      new Date(Date.parse(now) - MEMORY_FRESHNESS_MAX_AGE_MS / 2),
      now,
    );
    const stale = memoryFreshnessScore(
      new Date(Date.parse(now) - MEMORY_FRESHNESS_MAX_AGE_MS * 2),
      now,
    );
    expect(fresh).toBe(1);
    expect(fresh).toBeGreaterThan(old);
    expect(old).toBeGreaterThan(stale);
    expect(stale).toBe(0);
    expect(memoryFreshnessScore("not-a-date", now)).toBe(0);
    expect(memoryFreshnessScore("not-a-date", now, true)).toBe(1);
  });

  test("filters inapplicable candidates and uses UUID as the final total-order tie-break", () => {
    const sameScore = {
      scopeSpec: { scopeType: "workspace" as const },
      vectorScore: 0.5,
      keywordScore: 0.5,
      updatedAt: now,
      confidence: 0.5,
    };
    const ranked = rankMemoryRetrievalCandidates(
      [
        { ...sameScore, id: "bbbbbbbb-0000-4000-8000-000000000000" },
        { ...sameScore, id: "aaaaaaaa-0000-4000-8000-000000000000" },
        {
          ...sameScore,
          id: "cccccccc-0000-4000-8000-000000000000",
          scopeSpec: { scopeType: "user", scopeSubjectId: "other-subject" },
        },
      ],
      { now },
    );
    expect(ranked.map(({ candidate }) => candidate.id)).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000000",
      "bbbbbbbb-0000-4000-8000-000000000000",
    ]);
    expect(scoreMemoryRetrievalCandidate(ranked[0]!.candidate, { now })!.reasonCodes).toContain(
      "scope.workspace",
    );
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
  const record = (
    over: Partial<MemoryBlockRecord> & Pick<MemoryBlockRecord, "id" | "kind" | "text">,
  ): MemoryBlockRecord => ({
    pinned: false,
    ...over,
  });

  test("returns null when only episodic records exist (episodic is excluded)", () => {
    expect(
      renderWorkspaceMemoryBlock([
        record({
          id: "aaaaaaaa-0000-4000-8000-000000000000",
          kind: "episodic",
          text: "happened once",
        }),
      ]),
    ).toBeNull();
  });

  test("sections by kind, renders short ids, and carries the standing header", () => {
    const block = renderWorkspaceMemoryBlock([
      record({
        id: "11111111-0000-4000-8000-000000000000",
        kind: "preference",
        text: "Prefer Terraform.",
      }),
      record({
        id: "22222222-0000-4000-8000-000000000000",
        kind: "semantic",
        text: "Staging deploys from main.",
      }),
      record({
        id: "33333333-0000-4000-8000-000000000000",
        kind: "procedural",
        text: "Run bun run typecheck before pushing.",
      }),
      record({
        id: "44444444-0000-4000-8000-000000000000",
        kind: "decision",
        text: "Chose Azure gpt-5.6-sol.",
      }),
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
    expect(block.indexOf("### Facts & environment")).toBeLessThan(
      block.indexOf("### How we do things"),
    );
    expect(block.indexOf("### How we do things")).toBeLessThan(block.indexOf("### Decisions"));
  });

  test("drops whole entries once the token budget is exhausted (never truncates mid-entry)", () => {
    // Each entry ~200 chars (~50 tokens); many entries overflow the ~2500-token budget.
    const many: MemoryBlockRecord[] = Array.from({ length: 400 }, (_, index) =>
      record({
        id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
        kind: "semantic",
        text: `Fact number ${index}: ${"detail ".repeat(30)}`.trim(),
      }),
    );
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

  test("an oversized entry is skipped, not a stopping point — later entries still fill the budget", () => {
    const block = renderWorkspaceMemoryBlock([
      record({
        id: "aaaaaaaa-0000-4000-8000-000000000000",
        kind: "semantic",
        text: "Small fact before.",
      }),
      record({
        id: "99999999-0000-4000-8000-000000000000",
        kind: "semantic",
        text: "oversized ".repeat(WORKSPACE_MEMORY_BLOCK_TOKEN_BUDGET * 2),
      }),
      record({
        id: "bbbbbbbb-0000-4000-8000-000000000000",
        kind: "semantic",
        text: "Small fact after.",
      }),
    ])!;
    expect(block).toContain("[aaaaaaaa]");
    expect(block).not.toContain("[99999999]");
    expect(block).toContain("[bbbbbbbb]");
    expect(estimateMemoryTokens(block)).toBeLessThanOrEqual(WORKSPACE_MEMORY_BLOCK_TOKEN_BUDGET);
  });

  test("pinned-first input order is preserved within its section", () => {
    const block = renderWorkspaceMemoryBlock([
      record({
        id: "aaaaaaaa-0000-4000-8000-000000000000",
        kind: "preference",
        text: "Pinned pref.",
        pinned: true,
      }),
      record({
        id: "bbbbbbbb-0000-4000-8000-000000000000",
        kind: "preference",
        text: "Unpinned pref.",
      }),
    ])!;
    expect(block.indexOf("[aaaaaaaa]")).toBeLessThan(block.indexOf("[bbbbbbbb]"));
  });

  test("admits matching labeled workspace records and prioritizes narrower scopes", () => {
    const context = {
      now: "2026-07-18T12:00:00.000Z",
      sessionId: "session-a",
      trustedUserSubjectId: "subject-a",
      roleKey: "builder",
      memoryLabels: ["infra"],
    } as const;
    const workspaceRecords: MemoryBlockRecord[] = Array.from({ length: 55 }, (_, index) =>
      record({
        id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
        kind: "semantic",
        text: `Workspace fact ${index}.`,
        scopeSpec: { scopeType: "workspace" },
        updatedAt: "2026-07-18T11:00:00.000Z",
      }),
    );
    const selected = selectWorkspaceMemoryRecords(
      [
        ...workspaceRecords,
        record({
          id: "eeeeeeee-0000-4000-8000-000000000000",
          kind: "decision",
          text: "Session fact.",
          scopeSpec: { scopeType: "session", scopeSessionId: "session-a" },
        }),
        record({
          id: "dddddddd-0000-4000-8000-000000000000",
          kind: "decision",
          text: "Role fact.",
          scopeSpec: { scopeType: "role", scopeRoleKey: "builder" },
        }),
        record({
          id: "ffffffff-0000-4000-8000-000000000000",
          kind: "decision",
          text: "Unmatched label.",
          scopeSpec: { scopeType: "workspace" },
          labels: ["product"],
        }),
      ],
      context,
    );
    expect(selected).toHaveLength(MEMORY_BLOCK_RECORD_LIMIT);
    expect(selected[0]!.id).toBe("eeeeeeee-0000-4000-8000-000000000000");
    expect(selected[1]!.id).toBe("dddddddd-0000-4000-8000-000000000000");
    expect(selected.some(({ id }) => id.startsWith("ffffffff"))).toBe(false);
    expect(selected.slice(2).every(({ id }) => !id.startsWith("eeeeeeee"))).toBe(true);
  });

  test("renders additive scope, label, and conflict hints without weakening bounds", () => {
    const block = renderWorkspaceMemoryBlock(
      [
        record({
          id: "11111111-0000-4000-8000-000000000000",
          kind: "semantic",
          text: "Builder-only fact.",
          scopeSpec: { scopeType: "role", scopeRoleKey: "builder" },
          labels: ["Infra", "Deploy"],
          unresolvedConflict: true,
        }),
        record({
          id: "22222222-0000-4000-8000-000000000000",
          kind: "semantic",
          text: "Broad fact.",
          scopeSpec: { scopeType: "workspace" },
        }),
        record({
          id: "33333333-0000-4000-8000-000000000000",
          kind: "episodic",
          text: "Must stay excluded.",
          scopeSpec: { scopeType: "workspace" },
          labels: ["infra"],
        }),
      ],
      {
        now: "2026-07-18T12:00:00.000Z",
        roleKey: "builder",
        memoryLabels: ["infra"],
      },
    )!;
    expect(block).toContain("[scope: role] [labels: deploy,infra] [conflict] Builder-only fact.");
    expect(block).toContain("- [22222222] Broad fact.");
    expect(block).not.toContain("Must stay excluded");
    expect(estimateMemoryTokens(block)).toBeLessThanOrEqual(WORKSPACE_MEMORY_BLOCK_TOKEN_BUDGET);
  });

  test("does not inject legacy or targeted records through the V1 one-argument renderer", () => {
    const block = renderWorkspaceMemoryBlock([
      record({
        id: "aaaaaaaa-0000-4000-8000-000000000000",
        kind: "semantic",
        text: "Legacy convention.",
        scope: "old-role-convention",
      }),
      record({
        id: "bbbbbbbb-0000-4000-8000-000000000000",
        kind: "semantic",
        text: "Labeled workspace fact.",
        scopeSpec: { scopeType: "workspace" },
        labels: ["infra"],
      }),
      record({
        id: "cccccccc-0000-4000-8000-000000000000",
        kind: "semantic",
        text: "V1 workspace fact.",
        scope: "workspace",
      }),
    ]);
    expect(block).toContain("V1 workspace fact.");
    expect(block).not.toContain("Legacy convention.");
    expect(block).not.toContain("Labeled workspace fact.");
  });
});
