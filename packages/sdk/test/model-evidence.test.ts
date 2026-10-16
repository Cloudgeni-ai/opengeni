import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import {
  assessSessionModelEvidencePages,
  type SessionModelEvidencePage,
  type ModelRequestEvidence,
} from "../src";

const page: SessionModelEvidencePage = {
  sessionId: "session",
  scope: "session_only",
  availability: "live",
  events: [],
  afterSequence: 0,
  throughSequence: 42,
  nextAfterSequence: 0,
  hasMore: false,
  attemptInventory: { ids: ["attempt"], truncated: false },
  completeness: "requires_all_pages_and_scope_check",
};
describe("model evidence public client", () => {
  test("complete pages pass; deleting, reordering or changing required attribution denies", () => {
    const common = {
      version: 1 as const,
      scopeId: "scope",
      purpose: "main" as const,
      status: "captured" as const,
      content: null,
    };
    const physical = {
      requestId: "physical",
      transportAttempt: 1,
      identitySource: "codex_custody" as const,
    };
    const records: ModelRequestEvidence[] = [
      { ...common, ordinal: 1, kind: "scope_open" },
      {
        ...common,
        ordinal: 2,
        kind: "request",
        physical,
        sourceSha256: "a".repeat(64),
        content: { body: "{}" },
      },
      {
        ...common,
        ordinal: 3,
        kind: "response",
        physical,
        responseId: "response",
        sourceSha256: "b".repeat(64),
        content: { response: {} },
        details: { terminal: "completed", transport: "http" },
      },
      {
        ...common,
        ordinal: 4,
        kind: "usage",
        responseId: "response",
        content: { sourceKey: "response", purpose: "main", inputTokens: 1, outputTokens: 1 },
        details: { usageEventId: "usage-id", usageEventSequence: 7 },
      },
      { ...common, ordinal: 5, kind: "scope_close", details: { errors: 0, physicalRequests: 1 } },
    ];
    const events = records.map((record, index) => ({
      id: `event-${index}`,
      sequence: (index + 1) * 2,
      turnId: "turn",
      attemptId: "attempt",
      record,
    }));
    const pages = [
      {
        ...page,
        events: events.slice(0, 2),
        throughSequence: 10,
        nextAfterSequence: 4,
        hasMore: true,
      },
      {
        ...page,
        events: events.slice(2),
        throughSequence: 10,
        afterSequence: 4,
        nextAfterSequence: 10,
      },
    ];
    expect(assessSessionModelEvidencePages(pages)).toEqual({ complete: true, issues: [] });
    expect(
      assessSessionModelEvidencePages([{ ...pages[0]!, events: events.slice(0, 1) }, pages[1]!])
        .complete,
    ).toBe(false);
    const reordered = [...events];
    [reordered[1], reordered[2]] = [reordered[2]!, reordered[1]!];
    expect(
      assessSessionModelEvidencePages([
        { ...page, events: reordered, throughSequence: 10, nextAfterSequence: 10 },
      ]).complete,
    ).toBe(false);
    const changed = structuredClone(events);
    (changed[3]!.record.content as any).inputTokens = null;
    expect(
      assessSessionModelEvidencePages([
        { ...page, events: changed, throughSequence: 10, nextAfterSequence: 10 },
      ]).complete,
    ).toBe(false);
  });
  test("encodes pagination with fixed watermark through the existing authorized client", async () => {
    let url = "";
    let authorization: string | null = null;
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      apiKey: "fixture-key",
      fetch: (async (input, init) => {
        url = String(input);
        authorization = new Headers(init?.headers).get("authorization");
        return Response.json(page);
      }) as typeof fetch,
    });
    expect(
      await client.getSessionModelEvidence("workspace", "session", {
        afterSequence: 10,
        throughSequence: 42,
        limit: 2,
      }),
    ).toEqual(page);
    expect(url).toBe(
      "https://api.example.test/v1/workspaces/workspace/sessions/session/model-evidence?afterSequence=10&throughSequence=42&limit=2",
    );
    expect(String(authorization)).toBe("Bearer fixture-key");
  });
  test("empty, incomplete, archived, inconsistent and unrecorded attempts deny completeness", () => {
    expect(assessSessionModelEvidencePages([]).complete).toBe(false);
    expect(assessSessionModelEvidencePages([page]).issues).toContain(
      "attempt:entire_attempt_evidence_missing",
    );
    expect(
      assessSessionModelEvidencePages([{ ...page, availability: "archived" }]).issues,
    ).toContain("retrieve_and_verify_archived_bundle");
    expect(assessSessionModelEvidencePages([{ ...page, hasMore: true }]).issues).toContain(
      "missing_pages",
    );
    expect(
      assessSessionModelEvidencePages([page, { ...page, throughSequence: 43 }]).issues,
    ).toContain("inconsistent_page_snapshot");
    expect(
      assessSessionModelEvidencePages([{ ...page, attemptInventory: { ids: [], truncated: true } }])
        .issues,
    ).toContain("attempt_inventory_truncated");
  });
});
