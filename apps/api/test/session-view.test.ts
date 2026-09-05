import { describe, expect, test } from "bun:test";
import { projectSessionForRelatedAccess } from "@opengeni/db";
import { sessionWithEffectiveToolPolicy } from "@opengeni/core";
import {
  compactSessionEventResult,
  type Rig,
  type Session,
  type SessionEvent,
} from "@opengeni/contracts";
import {
  boundRigDetailMcp,
  boundSessionEventCompactResult,
  boundSessionDetailMcp,
  boundSessionEventMcpPage,
  capPayloadValue,
  capSessionDetail,
  DEFAULT_SESSION_DETAIL_CHARS,
} from "../src/mcp/session-view";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const SESSION = "00000000-0000-4000-8000-000000000002";

function event(sequence: number, payload: unknown = { status: "ok" }): SessionEvent {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    sequence,
    type: "agent.toolCall.output",
    payload,
    occurredAt: "2026-07-19T00:00:00.000Z",
    clientEventId: null,
    turnId: null,
  };
}

describe("model monitoring value bounds", () => {
  test("passes through small values and clamps pathological strings/containers", () => {
    const small = { status: "ok" };
    expect(capPayloadValue(small, 2_000)).toBe(small);
    const value = capPayloadValue(`HEAD-${"界🙂".repeat(5_000)}-TAIL`, 2_000) as string;
    expect(value).toStartWith("HEAD-");
    expect(value).toEndWith("-TAIL");
    expect(value).toContain("model monitoring projection");

    const fields = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, index) => [`k${index}`, "v"]),
    );
    expect(typeof capPayloadValue(fields, 2_000)).toBe("string");
  });

  test("depth guard handles cycles without recursing forever", () => {
    const cyclic: Record<string, unknown> = { name: "cycle" };
    cyclic.self = cyclic;
    expect(() => capPayloadValue(cyclic, 2_000)).not.toThrow();
  });
});

describe("boundSessionEventMcpPage", () => {
  test("reports exact pretty-JSON bytes and newest-tail coverage", () => {
    const page = boundSessionEventMcpPage({
      events: [event(98), event(99), event(100)],
      mode: "monitoring",
      payloadMode: "summary",
      direction: "before",
      sourceHasMore: false,
      sourceTruncatedBy: null,
      after: 0,
      before: null,
    });
    expect(page.coveredSequence).toEqual({ first: 98, last: 100 });
    expect(page.nextBefore).toBe(98);
    expect(page.nextAfter).toBeNull();
    expect(page.truncated).toBeFalse();
    expect(page.bytes).toBe(Buffer.byteLength(JSON.stringify(page, null, 2), "utf8"));
    expect(page.bytes).toBeLessThanOrEqual(page.maxBytes);
  });

  test("keeps the newest suffix for a capped backward page without fake events", () => {
    const page = boundSessionEventMcpPage({
      events: Array.from({ length: 100 }, (_, index) =>
        event(1_000 + index, {
          output: `HEAD-${"界🙂".repeat(20_000)}-${index}-TAIL`,
        }),
      ),
      mode: "forensic",
      payloadMode: "full",
      direction: "before",
      sourceHasMore: false,
      sourceTruncatedBy: null,
      after: 0,
      before: 1_100,
      maxBytes: 16 * 1024,
    });
    expect(page.bytes).toBeLessThanOrEqual(16 * 1024);
    expect(page.bytes).toBe(Buffer.byteLength(JSON.stringify(page, null, 2), "utf8"));
    expect(page.truncated).toBeTrue();
    expect(page.truncation?.reasons).toContain("model_payload");
    expect(page.truncation?.reasons).toContain("model_bytes");
    expect(page.events.at(-1)?.sequence).toBe(1_099);
    expect(page.nextBefore).toBe(page.events[0]?.sequence);
    expect(
      page.events.every((item) => item.id !== "00000000-0000-0000-0000-000000000000"),
    ).toBeTrue();
  });

  test("keeps the oldest prefix and exact nextAfter for forward pagination", () => {
    const page = boundSessionEventMcpPage({
      events: Array.from({ length: 20 }, (_, index) =>
        event(201 + index, { output: "x".repeat(20_000) }),
      ),
      mode: "forensic",
      payloadMode: "full",
      direction: "after",
      sourceHasMore: true,
      sourceTruncatedBy: "count",
      after: 200,
      before: null,
      maxBytes: 12 * 1024,
    });
    expect(page.events[0]?.sequence).toBe(201);
    expect(page.nextAfter).toBe(page.events.at(-1)?.sequence);
    expect(page.nextBefore).toBeNull();
    expect(page.truncation?.reasons).toContain("source_count");
    expect(page.hasMore).toBeTrue();
  });

  test("an empty caught-up forward page preserves the caller cursor", () => {
    const page = boundSessionEventMcpPage({
      events: [],
      mode: "forensic",
      payloadMode: "full",
      direction: "after",
      sourceHasMore: false,
      sourceTruncatedBy: null,
      after: 42,
      before: null,
    });
    expect(page.coveredSequence).toBeNull();
    expect(page.nextAfter).toBe(42);
    expect(page.events).toEqual([]);
  });
});

describe("boundSessionEventCompactResult", () => {
  test("keeps identity and exact pretty-JSON envelope bounds for pathological results", () => {
    const compact = compactSessionEventResult(
      {
        ...event(77, {
          text: "\u0000".repeat(20_000),
          output: "x".repeat(20_000),
          result: { value: "y".repeat(20_000) },
          checkpoint: { detail: "z".repeat(20_000) },
          receipt: { detail: "r".repeat(20_000) },
        }),
        type: "turn.completed",
        turnGeneration: 3,
      },
      "terminal",
    );
    const bounded = boundSessionEventCompactResult(compact);
    const bytes = Buffer.byteLength(JSON.stringify(bounded, null, 2), "utf8");
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
    expect(bounded.id).toBe(compact.id);
    expect(bounded.sequence).toBe(77);
    expect(bounded.truncation.truncated).toBeTrue();
    expect(bounded.truncation.fields).toContain("mcp_envelope");
  });
});

describe("capSessionDetail", () => {
  test("preserves small values and clamps unbounded metadata/message fields", () => {
    const small = {
      metadata: { k: "v" },
      initialMessage: "hi",
      status: "running",
    };
    expect(capSessionDetail(small)).toBe(small);

    const large = {
      metadata: { note: "M".repeat(50_000) },
      initialMessage: "I".repeat(DEFAULT_SESSION_DETAIL_CHARS + 5_000),
    };
    const capped = capSessionDetail(large);
    expect(capped).not.toBe(large);
    expect(JSON.stringify(capped).length).toBeLessThan(JSON.stringify(large).length);
    expect(capped.initialMessage).toContain("model monitoring projection");
  });
});

function sessionFixture(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION,
    workspaceId: WORKSPACE,
    accountId: "00000000-0000-4000-8000-000000000003",
    status: "running",
    initialMessage: "initial",
    title: "worker",
    titleSource: "agent",
    instructions: null,
    resources: [],
    tools: [],
    metadata: {},
    model: "gpt-5-codex",
    sandboxBackend: "none",
    sandboxOs: "linux",
    sandboxGroupId: SESSION,
    activeSandboxId: null,
    activeEpoch: 0,
    workingDir: null,
    variableSetIds: [],
    variableSetId: null,
    environmentId: null,
    rigId: null,
    rigVersionId: null,
    firstPartyMcpPermissions: null,
    mcpServers: [],
    parentSessionId: null,
    createIdempotencyKey: null,
    temporalWorkflowId: `session-${SESSION}`,
    activeTurnId: null,
    lastInputTokens: null,
    queueVersion: 0,
    queueHeadPosition: 0,
    queueTailPosition: 0,
    effectiveControl: {
      state: "active",
      blockers: [],
      resumeOptions: [],
    } as never,
    lastSequence: 7,
    codexPinnedCredentialId: null,
    codexLastCredentialId: null,
    codexCompactionMode: "portable",
    pinned: false,
    pinnedAt: null,
    pinVersion: 0,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:01:00.000Z",
    ...overrides,
  };
}

describe("boundSessionDetailMcp", () => {
  test("target-only full detail cannot restore hidden policy lineage during effective-policy assembly", () => {
    const ancestorId = "00000000-0000-4000-8000-000000000091";
    for (const mode of ["workspace_default", "explicit", "inherited"] as const) {
      const session = sessionFixture({
        parentSessionId: ancestorId,
        toolPolicy: { mode, inheritedFromSessionId: ancestorId },
        tools: [
          { kind: "mcp", id: "docs", optional: true },
          { kind: "mcp", id: "removed", optional: true },
        ],
      });
      const assemble = (value: Session) =>
        sessionWithEffectiveToolPolicy(value, ["docs", "files", "opengeni"], ["files"]);
      const original = assemble(session);
      const expectedPolicy = { ...original.effectiveToolPolicy!, inheritedFromSessionId: null };
      // MCP and REST can assemble effective policy after target authorization;
      // another adapter may already carry a computed policy. Both orders must
      // produce the same exact policy apart from unauthorized provenance.
      const projectedFirst = projectSessionForRelatedAccess(session, "target");
      expect(projectedFirst).not.toHaveProperty("effectiveToolPolicy");
      for (const projected of [
        assemble(projectedFirst),
        projectSessionForRelatedAccess(original, "target"),
      ]) {
        expect(projected.toolPolicy).toEqual({ mode, inheritedFromSessionId: null });
        expect(projected.effectiveToolPolicy).toEqual(expectedPolicy);
        const full = boundSessionDetailMcp(projected);
        expect(full.effectiveToolPolicy).toEqual(expectedPolicy);
        expect(JSON.stringify(full)).not.toContain(ancestorId);
      }
      expect(session.toolPolicy.inheritedFromSessionId).toBe(ancestorId);
      expect(original.effectiveToolPolicy!.inheritedFromSessionId).toBe(ancestorId);
    }
  });

  test("root-authorized and exact-target policy identities remain available", () => {
    const ancestorId = "00000000-0000-4000-8000-000000000092";
    const session = sessionWithEffectiveToolPolicy(
      sessionFixture({
        parentSessionId: ancestorId,
        toolPolicy: { mode: "inherited", inheritedFromSessionId: ancestorId },
      }),
      ["opengeni"],
    );
    expect(projectSessionForRelatedAccess(session, "root")).toBe(session);
    expect(
      boundSessionDetailMcp(projectSessionForRelatedAccess(session, "root")).effectiveToolPolicy,
    ).toEqual(session.effectiveToolPolicy);
    for (const inheritedFromSessionId of [null, SESSION]) {
      const target = sessionWithEffectiveToolPolicy(
        sessionFixture({
          toolPolicy: { mode: "explicit", inheritedFromSessionId },
        }),
        ["opengeni"],
      );
      const projected = projectSessionForRelatedAccess(target, "target");
      expect(projected.toolPolicy).toBe(target.toolPolicy);
      expect(projected.effectiveToolPolicy).toBe(target.effectiveToolPolicy);
    }
  });

  test("precomputed policy provenance is checked independently of persisted policy provenance", () => {
    const hiddenId = "00000000-0000-4000-8000-000000000093";
    const session = sessionWithEffectiveToolPolicy(
      sessionFixture({
        toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
      }),
      ["opengeni"],
    );
    session.effectiveToolPolicy!.inheritedFromSessionId = hiddenId;
    const projected = projectSessionForRelatedAccess(session, "target");
    expect(projected.toolPolicy).toBe(session.toolPolicy);
    expect(projected.effectiveToolPolicy).toEqual({
      ...session.effectiveToolPolicy!,
      inheritedFromSessionId: null,
    });
    expect(session.effectiveToolPolicy!.inheritedFromSessionId).toBe(hiddenId);
    expect(JSON.stringify(boundSessionDetailMcp(projected))).not.toContain(hiddenId);
  });

  test("preserves the complete ordered Variable Set selection and derives legacy aliases", () => {
    const variableSetIds = [
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
    ];
    const result = boundSessionDetailMcp(
      sessionFixture({
        variableSetIds,
        // Deliberately inconsistent input proves the model-facing legacy fields
        // are derived from the canonical ordered selection.
        variableSetId: variableSetIds[0]!,
        environmentId: variableSetIds[0]!,
      }),
    );

    expect(result.variableSetIds).toEqual(variableSetIds);
    expect(result.variableSetId).toBe(variableSetIds[1]);
    expect(result.environmentId).toBe(variableSetIds[1]);
  });

  test("reports selected, mandatory, and effective tool policy separately", () => {
    const effectiveToolPolicy = {
      mode: "workspace_default" as const,
      inheritedFromSessionId: null,
      selectedIds: [],
      effectiveIds: ["docs", "files", "opengeni"],
      mandatoryIds: ["opengeni"],
      lazyRouter: {
        state: "required" as const,
        deferredIds: ["docs", "files", "opengeni"],
      },
      configuredIds: ["docs", "files", "opengeni"],
      droppedIds: [],
      counts: {
        selected: 0,
        effective: 3,
        mandatory: 1,
        deferred: 3,
        configured: 3,
        dropped: 0,
      },
      idsTruncated: false,
    };
    const result = boundSessionDetailMcp(sessionFixture({ effectiveToolPolicy }));

    expect(result.effectiveToolPolicy).toEqual(effectiveToolPolicy);
    expect(result.projection.fields.effectiveToolPolicy).toMatchObject({ truncated: false });
  });

  test("marks effective tool ids truncated when the MCP envelope samples them further", () => {
    const ids = Array.from({ length: 40 }, (_, index) => `tool-${String(index).padStart(2, "0")}`);
    const result = boundSessionDetailMcp(
      sessionFixture({
        effectiveToolPolicy: {
          mode: "explicit",
          inheritedFromSessionId: null,
          selectedIds: ids,
          effectiveIds: ids,
          mandatoryIds: ["opengeni"],
          lazyRouter: { state: "required", deferredIds: ids },
          configuredIds: ids,
          droppedIds: [],
          counts: {
            selected: 40,
            effective: 40,
            mandatory: 1,
            deferred: 40,
            configured: 40,
            dropped: 0,
          },
          idsTruncated: false,
        },
      }),
    );
    const policy = result.effectiveToolPolicy as {
      selectedIds: string[];
      effectiveIds: string[];
      lazyRouter: { deferredIds: string[] };
      configuredIds: string[];
      counts: { effective: number };
      idsTruncated: boolean;
    };
    expect(policy.selectedIds).toHaveLength(12);
    expect(policy.effectiveIds).toHaveLength(12);
    expect(policy.lazyRouter.deferredIds).toHaveLength(12);
    expect(policy.configuredIds).toHaveLength(12);
    expect(policy.counts.effective).toBe(40);
    expect(policy.idsTruncated).toBeTrue();
    expect(result.projection.fields.effectiveToolPolicy).toMatchObject({ truncated: true });
    expect(result.projection.details).toContain(
      "effectiveToolPolicy: ids sampled at 12 per set; counts remain exact",
    );
  });

  test("bounds every aggregate and reports exact final bytes", () => {
    const huge = "界🙂".repeat(50_000);
    const session = sessionFixture({
      title: huge,
      initialMessage: huge,
      instructions: huge,
      metadata: Object.fromEntries(
        Array.from({ length: 500 }, (_, index) => [`metadata-${index}-${huge}`, huge]),
      ),
      resources: Array.from({ length: 200 }, (_, index) => ({
        kind: "repository",
        uri: `https://example.com/${index}`,
        ref: huge,
      })) as never,
      tools: Array.from({ length: 200 }, (_, index) => ({
        kind: "mcp",
        id: `tool-${index}`,
        description: huge,
      })) as never,
      mcpServers: Array.from({ length: 100 }, (_, index) => ({
        id: `server-${index}`,
        name: huge,
        url: `https://mcp-${index}.example.com`,
        headerNames: [huge],
        credentialVersion: 1,
        requireApproval: false,
        connectionRef: null,
      })),
      firstPartyMcpPermissions: Array.from({ length: 200 }, () => "sessions:read") as never,
    });
    const result = boundSessionDetailMcp(session, {
      state: "paused",
      blockers: Array.from({ length: 200 }, () => ({ reason: huge })),
    });
    expect(result.projection.bytes).toBe(
      Buffer.byteLength(JSON.stringify(result, null, 2), "utf8"),
    );
    expect(result.projection.bytes).toBeLessThanOrEqual(result.projection.maxBytes);
    expect(result.projection.truncated).toBeTrue();
    expect(result.projection.fields.resources.originalCount).toBe(200);
    expect(result.projection.fields.resources.deliveredCount).toBe(24);
    expect(result.projection.fields.tools.originalCount).toBe(200);
    expect(result.projection.fields.tools.deliveredCount).toBe(24);
    expect(result.initialMessage).toContain("model monitoring projection");
    expect(JSON.stringify(result)).not.toContain(huge);
  });
});

describe("boundRigDetailMcp", () => {
  test("keeps one bounded active definition and summary-only history", () => {
    const huge = "setup-界🙂".repeat(40_000);
    const rig: Rig = {
      id: "00000000-0000-4000-8000-000000000010",
      accountId: "00000000-0000-4000-8000-000000000003",
      workspaceId: WORKSPACE,
      name: huge,
      description: huge,
      createdBy: "session:test",
      activeVersion: {
        id: "00000000-0000-4000-8000-000000000011",
        rigId: "00000000-0000-4000-8000-000000000010",
        version: 99,
        image: huge,
        setupScript: huge,
        checks: Array.from({ length: 100 }, (_, index) => ({
          name: `check-${index}`,
          command: huge,
        })),
        credentialHooks: Array.from({ length: 100 }, () => huge),
        defaultVariableSetIds: Array.from(
          { length: 100 },
          (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        ),
        changelog: huge,
        createdBy: "session:test",
        active: true,
        createdAt: "2026-07-19T00:00:00.000Z",
      },
      activeVersionHealth: { checkHealth: "passing", lastVerifiedAt: null },
      versionCount: 500,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:01:00.000Z",
    };
    const result = boundRigDetailMcp(
      rig,
      {
        versions: Array.from({ length: 100 }, (_, index) => ({
          id: `version-${index}`,
          changelog: huge,
          setupScriptBytes: 5_000_000,
        })),
        total: 500,
        hasMore: true,
      },
      {
        changes: Array.from({ length: 100 }, (_, index) => ({
          id: `change-${index}`,
          commandPreview: huge,
          verificationBytes: 8_000_000,
        })),
        total: 400,
        hasMore: true,
      },
    );
    expect(result.projection.bytes).toBe(
      Buffer.byteLength(JSON.stringify(result, null, 2), "utf8"),
    );
    expect(result.projection.bytes).toBeLessThanOrEqual(result.projection.maxBytes);
    expect(result.versionsTruncated).toBeTrue();
    expect(result.changesTruncated).toBeTrue();
    expect(result.rig.activeVersion?.setupScript).toContain("model monitoring projection");
    expect(JSON.stringify(result)).not.toContain(huge);
  });
});
