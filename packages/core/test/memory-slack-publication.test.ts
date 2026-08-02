import { describe, expect, test } from "bun:test";
import { redactSensitiveText } from "@opengeni/contracts";
import {
  DEFAULT_MEMORY_SLACK_PUBLICATION_POLICY,
  MEMORY_SLACK_PROJECTION_MAX_UTF8_BYTES,
  MEMORY_SLACK_SUMMARY_MAX_UTF8_BYTES,
  evaluateMemorySlackPublication,
  type MemorySlackPublicationInput,
} from "../src";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const memoryId = "33333333-3333-4333-8333-333333333333";
const relatedMemoryId = "44444444-4444-4444-8444-444444444444";
const replacementMemoryId = "55555555-5555-4555-8555-555555555555";
const now = "2026-08-02T20:00:00.000Z";

type CandidateOverrides = {
  context?: Partial<MemorySlackPublicationInput["context"]>;
  policy?: MemorySlackPublicationInput["policy"];
  memory?: Partial<MemorySlackPublicationInput["memory"]>;
  change?: Partial<MemorySlackPublicationInput["change"]>;
  distribution?: Partial<MemorySlackPublicationInput["distribution"]>;
};

const enabledPolicy = {
  ...DEFAULT_MEMORY_SLACK_PUBLICATION_POLICY,
  enabled: true,
};

function candidate(overrides: CandidateOverrides = {}): MemorySlackPublicationInput {
  const base: MemorySlackPublicationInput = {
    context: { accountId, workspaceId, now },
    policy: enabledPolicy,
    memory: {
      sourceType: "workspace_memory",
      accountId,
      workspaceId,
      id: memoryId,
      version: 3,
      status: "active",
      kind: "decision",
      scopeType: "workspace",
      namespace: "company/product",
      labels: ["customer-commitment", "architecture"],
      validFrom: "2026-08-01T00:00:00.000Z",
      validUntil: null,
      supersedesId: null,
      supersededById: null,
    },
    change: {
      kind: "created",
      relatedMemoryId: null,
      occurredAt: "2026-08-02T19:59:00.000Z",
      origin: "native",
      ownerLabel: "Architecture council",
    },
    distribution: {
      importance: "major",
      audience: "workspace",
      slackMode: "auto",
      shareSummary: "Adopt the bounded workspace publication policy.",
    },
  };
  return {
    context: { ...base.context, ...overrides.context },
    policy: Object.hasOwn(overrides, "policy") ? overrides.policy : base.policy,
    memory: { ...base.memory, ...overrides.memory },
    change: { ...base.change, ...overrides.change },
    distribution: { ...base.distribution, ...overrides.distribution },
  };
}

describe("Memory Slack publication security contract", () => {
  test("publishes nothing unless a workspace admin explicitly enables the policy", () => {
    expect(evaluateMemorySlackPublication(candidate({ policy: undefined }))).toEqual({
      eligible: false,
      reason: "disabled",
    });
    expect(
      evaluateMemorySlackPublication(
        candidate({ policy: DEFAULT_MEMORY_SLACK_PUBLICATION_POLICY }),
      ),
    ).toEqual({ eligible: false, reason: "disabled" });
  });

  test("returns a redacted, UTF-8-bounded allowlist projection and ignores raw source fields", () => {
    const syntheticValue = "A".repeat(24);
    const input = candidate({
      memory: {
        labels: [
          "zeta",
          "alpha",
          "beta",
          "gamma",
          "delta",
          "epsilon",
          "eta",
          "theta",
          "iota",
          "alpha",
        ],
      },
      change: { ownerLabel: ["pass", "word=", syntheticValue].join("") },
      distribution: {
        shareSummary: ["Decision summary api", "_key=", syntheticValue, " ", "😀".repeat(300)].join(
          "",
        ),
      },
    });
    Object.assign(input.memory as object, {
      text: `raw memory body ${syntheticValue}`,
      metadata: { hiddenPrompt: `never publish ${syntheticValue}` },
      sourceRefs: [{ kind: "session_event", id: "raw-source" }],
      embedding: [0.1, 0.2],
    });

    const decision = evaluateMemorySlackPublication(input);
    expect(decision.eligible).toBe(true);
    if (!decision.eligible) return;

    expect(decision.deliveryMode).toBe("auto");
    expect(decision.idempotencyKey).toMatch(/^memory-slack:v1:[0-9a-f]{64}$/);
    expect(decision.projection.summary).toContain("[redacted]");
    expect(decision.projection.summary).not.toContain(syntheticValue);
    expect(decision.projection.summaryRedacted).toBe(true);
    expect(decision.projection.summaryTruncated).toBe(true);
    expect(new TextEncoder().encode(decision.projection.summary).byteLength).toBeLessThanOrEqual(
      MEMORY_SLACK_SUMMARY_MAX_UTF8_BYTES,
    );
    expect(decision.projection.ownerLabel).toContain("[redacted]");
    expect(decision.projection.ownerLabelRedacted).toBe(true);
    expect(decision.projection.labels).toEqual([
      "alpha",
      "beta",
      "delta",
      "epsilon",
      "eta",
      "gamma",
      "iota",
      "theta",
    ]);
    expect(decision.projection.labelsTruncated).toBe(true);

    const serialized = JSON.stringify(decision.projection);
    expect(serialized).not.toContain(syntheticValue);
    expect(serialized).not.toContain("raw memory body");
    expect(serialized).not.toContain("hiddenPrompt");
    expect(serialized).not.toContain("raw-source");
    expect(serialized).not.toContain("embedding");
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
      MEMORY_SLACK_PROJECTION_MAX_UTF8_BYTES,
    );
    expect(Object.keys(decision.projection).sort()).toEqual(
      [
        "authoritativeRecord",
        "changeKind",
        "deliveryMode",
        "importance",
        "labels",
        "labelsTruncated",
        "memoryId",
        "memoryVersion",
        "namespace",
        "occurredAt",
        "ownerLabel",
        "ownerLabelRedacted",
        "ownerLabelTruncated",
        "relatedMemoryId",
        "summary",
        "summaryRedacted",
        "summaryTruncated",
        "version",
        "workspaceId",
      ].sort(),
    );
  });

  test("fails closed when namespace or labels contain recognized credential material", () => {
    const credential = `github_pat_${"a".repeat(32)}`;
    const caseSensitiveCredential = ["AI", "za", "b".repeat(35)].join("");
    expect(redactSensitiveText(credential)).toBe("[redacted]");
    expect(redactSensitiveText(caseSensitiveCredential)).toBe("[redacted]");

    expect(
      evaluateMemorySlackPublication(candidate({ memory: { namespace: credential } })),
    ).toEqual({ eligible: false, reason: "invalid_input" });
    expect(
      evaluateMemorySlackPublication(candidate({ memory: { namespace: caseSensitiveCredential } })),
    ).toEqual({ eligible: false, reason: "invalid_input" });
    expect(
      evaluateMemorySlackPublication(
        candidate({ memory: { labels: ["architecture", credential] } }),
      ),
    ).toEqual({ eligible: false, reason: "invalid_input" });
    expect(
      evaluateMemorySlackPublication(
        candidate({ memory: { labels: ["architecture", caseSensitiveCredential] } }),
      ),
    ).toEqual({ eligible: false, reason: "invalid_input" });
  });

  test("fails closed across account and workspace boundaries", () => {
    expect(
      evaluateMemorySlackPublication(
        candidate({ memory: { accountId: "66666666-6666-4666-8666-666666666666" } }),
      ),
    ).toEqual({ eligible: false, reason: "tenant_mismatch" });
    expect(
      evaluateMemorySlackPublication(
        candidate({ memory: { workspaceId: "77777777-7777-4777-8777-777777777777" } }),
      ),
    ).toEqual({ eligible: false, reason: "tenant_mismatch" });
  });

  test("never treats personal, role, session, ephemeral, legacy, document, or restricted data as workspace-safe", () => {
    for (const scopeType of ["user", "role", "session", "ephemeral", "legacy"] as const) {
      expect(evaluateMemorySlackPublication(candidate({ memory: { scopeType } }))).toEqual({
        eligible: false,
        reason: "restricted_scope",
      });
    }
    expect(
      evaluateMemorySlackPublication(candidate({ distribution: { audience: "restricted" } })),
    ).toEqual({ eligible: false, reason: "restricted_audience" });
    expect(
      evaluateMemorySlackPublication(
        candidate({ memory: { sourceType: "document" as "workspace_memory" } }),
      ),
    ).toEqual({ eligible: false, reason: "unsupported_source" });
  });

  test("publishes only active or approved decisions for ordinary create/correct events", () => {
    expect(evaluateMemorySlackPublication(candidate({ memory: { kind: "procedural" } }))).toEqual({
      eligible: false,
      reason: "not_decision",
    });
    for (const status of ["proposed", "rejected", "superseded", "archived"] as const) {
      expect(evaluateMemorySlackPublication(candidate({ memory: { status } }))).toEqual({
        eligible: false,
        reason: "status_ineligible",
      });
    }
    expect(
      evaluateMemorySlackPublication(candidate({ memory: { status: "approved" } })).eligible,
    ).toBe(true);
  });

  test("applies the safe default noise policy and respects explicit review/never modes", () => {
    const normalAuto = evaluateMemorySlackPublication(
      candidate({ distribution: { importance: "normal", slackMode: "auto" } }),
    );
    expect(normalAuto.eligible && normalAuto.deliveryMode).toBe("review");

    const majorReview = evaluateMemorySlackPublication(
      candidate({ distribution: { importance: "major", slackMode: "review" } }),
    );
    expect(majorReview.eligible && majorReview.deliveryMode).toBe("review");

    expect(
      evaluateMemorySlackPublication(
        candidate({ distribution: { importance: "minor", slackMode: "auto" } }),
      ),
    ).toEqual({ eligible: false, reason: "below_noise_policy" });
    expect(
      evaluateMemorySlackPublication(candidate({ distribution: { slackMode: "never" } })),
    ).toEqual({ eligible: false, reason: "mode_never" });
  });

  test("blocks Slack-derived publication loops and invalid or inactive time windows", () => {
    expect(
      evaluateMemorySlackPublication(candidate({ change: { origin: "slack_derived" } })),
    ).toEqual({ eligible: false, reason: "slack_origin_loop" });
    expect(
      evaluateMemorySlackPublication(
        candidate({ memory: { validFrom: "2026-08-03T00:00:00.000Z" } }),
      ),
    ).toEqual({ eligible: false, reason: "not_yet_valid" });
    expect(
      evaluateMemorySlackPublication(
        candidate({ memory: { validUntil: "2026-08-02T20:00:00.000Z" } }),
      ),
    ).toEqual({ eligible: false, reason: "expired" });
    expect(evaluateMemorySlackPublication(candidate({ context: { now: "not-a-date" } }))).toEqual({
      eligible: false,
      reason: "invalid_input",
    });
  });

  test("requires explicit correction and supersession lineage while preserving distinct history keys", () => {
    const corrected = evaluateMemorySlackPublication(
      candidate({
        memory: { id: replacementMemoryId, version: 1, supersedesId: relatedMemoryId },
        change: { kind: "corrected", relatedMemoryId },
      }),
    );
    expect(corrected.eligible).toBe(true);
    if (!corrected.eligible) return;
    expect(corrected.projection).toMatchObject({
      memoryId: replacementMemoryId,
      changeKind: "corrected",
      relatedMemoryId,
    });

    expect(
      evaluateMemorySlackPublication(candidate({ change: { kind: "corrected", relatedMemoryId } })),
    ).toEqual({ eligible: false, reason: "invalid_change_lineage" });

    const superseded = evaluateMemorySlackPublication(
      candidate({
        memory: {
          status: "superseded",
          supersededById: replacementMemoryId,
        },
        change: { kind: "superseded", relatedMemoryId: replacementMemoryId },
      }),
    );
    expect(superseded.eligible).toBe(true);
    if (!superseded.eligible) return;
    expect(superseded.projection.changeKind).toBe("superseded");
    expect(superseded.idempotencyKey).not.toBe(corrected.idempotencyKey);

    expect(
      evaluateMemorySlackPublication(
        candidate({
          memory: { supersedesId: memoryId },
          change: { kind: "corrected", relatedMemoryId: memoryId },
        }),
      ),
    ).toEqual({ eligible: false, reason: "invalid_change_lineage" });
    expect(
      evaluateMemorySlackPublication(
        candidate({
          memory: { status: "superseded", supersededById: memoryId },
          change: { kind: "superseded", relatedMemoryId: memoryId },
        }),
      ),
    ).toEqual({ eligible: false, reason: "invalid_change_lineage" });
  });

  test("produces stable idempotency for canonical equivalent inputs and changes it for new truth", () => {
    const first = evaluateMemorySlackPublication(
      candidate({ memory: { labels: ["beta", "alpha", "alpha"] } }),
    );
    const reordered = evaluateMemorySlackPublication(
      candidate({ memory: { labels: ["alpha", "beta"] } }),
    );
    const newVersion = evaluateMemorySlackPublication(
      candidate({ memory: { labels: ["alpha", "beta"], version: 4 } }),
    );
    expect(first.eligible && reordered.eligible && first.idempotencyKey).toBe(
      reordered.eligible ? reordered.idempotencyKey : null,
    );
    expect(first.eligible && newVersion.eligible && first.idempotencyKey).not.toBe(
      newVersion.eligible ? newVersion.idempotencyKey : null,
    );
  });

  test("fails closed on malformed runtime values and missing summaries", () => {
    expect(
      evaluateMemorySlackPublication(candidate({ context: { workspaceId: "not-a-uuid" } })),
    ).toEqual({ eligible: false, reason: "invalid_input" });
    expect(
      evaluateMemorySlackPublication(
        candidate({ distribution: { slackMode: "always" as "auto" } }),
      ),
    ).toEqual({ eligible: false, reason: "invalid_input" });
    expect(
      evaluateMemorySlackPublication(candidate({ distribution: { shareSummary: " \n\t " } })),
    ).toEqual({ eligible: false, reason: "missing_summary" });
    expect(
      evaluateMemorySlackPublication(candidate({ memory: { namespace: "../private" } })),
    ).toEqual({ eligible: false, reason: "invalid_input" });
    expect(
      evaluateMemorySlackPublication(
        candidate({ distribution: { shareSummary: 42 as unknown as string } }),
      ),
    ).toEqual({ eligible: false, reason: "invalid_input" });
    expect(
      evaluateMemorySlackPublication(
        candidate({ memory: { namespace: null as unknown as string } }),
      ),
    ).toEqual({ eligible: false, reason: "invalid_input" });
    expect(
      evaluateMemorySlackPublication(
        candidate({ memory: { labels: { unsafe: true } as unknown as readonly string[] } }),
      ),
    ).toEqual({ eligible: false, reason: "invalid_input" });
  });
});
