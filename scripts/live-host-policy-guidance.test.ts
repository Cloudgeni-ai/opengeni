import { describe, expect, test } from "bun:test";
import { markdownLanguage } from "@codemirror/lang-markdown";

import { OpenGeniClient } from "../packages/sdk/src/index";
import type { SessionEvent, SessionEventPage } from "../packages/sdk/src/types";

const root = new URL("../", import.meta.url);
const readGuide = (name: string) =>
  Bun.file(new URL(`.agents/skills/opengeni-client/references/${name}.md`, root)).text();

// Run the exact host-owned examples; do not hand-copy their implementations.
async function examples<T>(source: string, names: string[]): Promise<T> {
  const blocks: string[] = [];
  markdownLanguage.parser.parse(source).iterate({
    enter(node) {
      if (node.name !== "FencedCode") return;
      const text = node.node.getChild("CodeText");
      if (!text) return;
      const code = source.slice(text.from, text.to);
      if (names.some((name) => code.includes(`function ${name}(`))) blocks.push(code);
    },
  });
  for (const name of names) {
    expect(blocks.filter((code) => code.includes(`function ${name}(`))).toHaveLength(1);
  }
  const code = `${blocks.join("\n")}\nexport { ${names.join(", ")} };`;
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as T;
}

const dataGuide = await readGuide("data-tools-and-credentials");
const workflows = await readGuide("api-workflows");
const policy = await examples<{
  requireLiveToolAuthority(
    claims: unknown,
    user: unknown,
    grant: unknown,
    operation: string,
  ): {
    subjectId: string;
    tenantId: string;
  };
  websiteShareMayReadReport(share: unknown, report: unknown): boolean;
  requireAuthorizedWindow(
    requested: { start: number; end: number },
    allowed: { start: number; end: number },
  ): { start: number; end: number };
}>(dataGuide, ["requireLiveToolAuthority", "websiteShareMayReadReport", "requireAuthorizedWindow"]);

type Result = {
  state: "completed" | "failed" | "cancelled" | "settled_without_result";
  text: string | null;
};
const results = await examples<{
  readOriginalResultPage(
    client: OpenGeniClient,
    workspaceId: string,
    sessionId: string,
    after: number,
  ): Promise<SessionEventPage>;
  settledTurnResult(event: SessionEvent, expectedTurnId: string): Result | null;
}>(workflows, ["readOriginalResultPage", "settledTurnResult"]);

const claims = {
  subjectId: "immutable-user-A",
  tenantId: "tenant-A",
  operations: ["bookmarks:read", "reports:write", "sessions:control"],
};
const user = { id: claims.subjectId, enabled: true, username: "editable-name" };
const grant = {
  subjectId: user.id,
  tenantId: claims.tenantId,
  active: true,
  operations: [...claims.operations],
};

describe("live host-policy examples", () => {
  test("enabled owner with current scope can read; rename retains immutable authority", () => {
    const context = policy.requireLiveToolAuthority(claims, user, grant, "bookmarks:read");
    expect(context).toEqual({ subjectId: user.id, tenantId: claims.tenantId });
    expect(
      policy.requireLiveToolAuthority(
        claims,
        { ...user, username: "renamed" },
        grant,
        "bookmarks:read",
      ),
    ).toEqual(context);
    expect(() =>
      policy.requireLiveToolAuthority(
        claims,
        { ...user, id: "new-owner-same-name" },
        grant,
        "bookmarks:read",
      ),
    ).toThrow("not authorized");
  });

  test.each([
    [{ ...user, enabled: false }, grant],
    [user, { ...grant, active: false }],
    [user, { ...grant, operations: ["bookmarks:read"] }],
    [user, { ...grant, tenantId: "foreign-tenant" }],
    [user, { ...grant, subjectId: "foreign-owner" }],
  ])(
    "current disable/revoke/downgrade/foreign policy overrides a still-valid token",
    (currentUser, currentGrant) => {
      expect(() =>
        policy.requireLiveToolAuthority(claims, currentUser, currentGrant, "sessions:control"),
      ).toThrow("not authorized");
    },
  );

  test("token ceiling and missing identity fail closed even with a broad current grant", () => {
    expect(() =>
      policy.requireLiveToolAuthority(
        { ...claims, operations: ["bookmarks:read"] },
        user,
        grant,
        "reports:write",
      ),
    ).toThrow("not authorized");
    expect(() => policy.requireLiveToolAuthority({}, user, grant, "bookmarks:read")).toThrow(
      "not authorized",
    );
  });

  test("website-share authority does not expose team reports or foreign website summaries", () => {
    const share = { kind: "website-share", websiteId: "website-A" };
    expect(
      policy.websiteShareMayReadReport(share, {
        scope: { kind: "website", websiteId: "website-A" },
      }),
    ).toBe(true);
    expect(
      policy.websiteShareMayReadReport(share, { scope: { kind: "team", websiteId: "website-A" } }),
    ).toBe(false);
    expect(
      policy.websiteShareMayReadReport(share, {
        scope: { kind: "website", websiteId: "website-B" },
      }),
    ).toBe(false);
    expect(
      policy.websiteShareMayReadReport(
        { ...share, websiteId: "" },
        { scope: { kind: "website", websiteId: "" } },
      ),
    ).toBe(false);
    expect(policy.websiteShareMayReadReport(share, null)).toBe(false);
  });

  test("server window permits only a valid contained UTC range", () => {
    const allowed = { start: 1000, end: 2000 };
    expect(policy.requireAuthorizedWindow({ start: 1200, end: 1900 }, allowed)).toEqual({
      start: 1200,
      end: 1900,
    });
    for (const requested of [
      { start: 999, end: 1500 },
      { start: 1200, end: 2001 },
      { start: 1500, end: 1500 },
      { start: 2000, end: 1500 },
      { start: NaN, end: 1500 },
    ]) {
      expect(() => policy.requireAuthorizedWindow(requested, allowed)).toThrow("not authorized");
    }
  });
});

function event(
  type: SessionEvent["type"],
  payload: unknown,
  turnId = "expected-turn",
): SessionEvent {
  return {
    id: "original-event",
    workspaceId: "workspace-A",
    sessionId: "session-A",
    sequence: 22,
    occurredAt: "2026-10-02T00:00:00.000Z",
    turnId,
    type,
    payload,
  };
}

describe("canonical original-result examples", () => {
  test("commentary and pre-settlement final message cannot complete or enter a result cache", () => {
    for (const phase of ["commentary", "final_answer"]) {
      expect(
        results.settledTurnResult(
          event("agent.message.completed", { phase, text: "Do not cache early" }),
          "expected-turn",
        ),
      ).toBeNull();
    }
  });

  test("wrong-turn and rejected/duplicate evidence cannot settle the current turn", () => {
    expect(
      results.settledTurnResult(
        event("turn.completed", { output: "another answer" }, "another-turn"),
        "expected-turn",
      ),
    ).toBeNull();
    for (const turnAssociation of ["late_rejected", "duplicate"] as const) {
      expect(
        results.settledTurnResult(
          { ...event("turn.completed", { output: "not canonical" }), turnAssociation },
          "expected-turn",
        ),
      ).toBeNull();
    }
  });

  test("full canonical output is retained exactly; empty/wait reply is not a report", () => {
    const text = "A full final answer\n" + "🧭".repeat(20000);
    expect(
      results.settledTurnResult(event("turn.completed", { output: text }), "expected-turn"),
    ).toEqual({ state: "completed", text });
    for (const payload of [
      { output: "", reply: "Still waiting" },
      { output: "", emptyFinalReply: true },
      { output: { text: "not a string result" } },
    ]) {
      expect(results.settledTurnResult(event("turn.completed", payload), "expected-turn")).toEqual({
        state: "settled_without_result",
        text: null,
      });
    }
    expect(
      results.settledTurnResult(
        event("turn.failed", { error: "private diagnostic" }),
        "expected-turn",
      ),
    ).toEqual({ state: "failed", text: null });
    expect(results.settledTurnResult(event("turn.cancelled", {}), "expected-turn")).toEqual({
      state: "cancelled",
      text: null,
    });
  });

  test("real SDK requests one bounded forensic/full page and retains long output/cursor", async () => {
    const output = "🧭".repeat(20000);
    const original = event("turn.completed", { output });
    const requests: Request[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      apiKey: "og_test_key",
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json([original], {
          headers: {
            "X-OpenGeni-Event-Mode": "forensic",
            "X-OpenGeni-Payload-Mode": "full",
            "X-OpenGeni-Event-Direction": "after",
            "X-OpenGeni-Forensic-Exact": "true",
            "X-OpenGeni-Has-More": "true",
            "X-OpenGeni-Page-Truncated": "true",
            "X-OpenGeni-Next-After": "22",
            "X-OpenGeni-Covered-First": "22",
            "X-OpenGeni-Covered-Last": "22",
          },
        });
      },
    });
    const page = await results.readOriginalResultPage(client, "workspace-A", "session-A", 20);
    expect(requests).toHaveLength(1); // a bounded tick, not a blocking wait loop
    const query = new URL(requests[0]!.url).searchParams;
    expect(query.get("mode")).toBe("forensic");
    expect(query.get("payloadMode")).toBe("full");
    expect(query.get("direction")).toBe("after");
    expect(query.get("after")).toBe("20");
    expect(query.get("limit")).toBe("50");
    expect(query.get("includeTypes")).toContain("turn.completed");
    expect(page.nextAfter).toBe(22);
    expect(page.hasMore).toBe(true);
    expect(page.truncated).toBe(true); // pagination is not payload truncation
    expect(results.settledTurnResult(page.events[0]!, "expected-turn")?.text).toBe(output);
  });

  test("summary-only or nonadvancing cursor pages fail closed instead of caching snippets", async () => {
    for (const metadata of [
      { forensicExact: false, hasMore: false, nextAfter: null },
      { forensicExact: true, hasMore: true, nextAfter: 20 },
    ]) {
      const client = { listEventPage: async () => metadata } as unknown as OpenGeniClient;
      await expect(
        results.readOriginalResultPage(client, "workspace-A", "session-A", 20),
      ).rejects.toThrow("exact result page");
    }
  });
});

test("guide retains trusted report provenance, callback capacity and DOM fallback boundaries", async () => {
  expect(dataGuide).toContain("trusted backend from verified");
  expect(dataGuide).toContain("editor's submitted body");
  expect(dataGuide).toContain("stored report's actual scope");
  expect(workflows).toContain("deployment-dependent risk");
  expect(workflows).toContain("retain callback capacity");
  expect(workflows).toContain("native form/POST fallback");
  const users = await readGuide("external-users-and-connect");
  expect(users).toContain("immutable database/auth subject ID");
  expect(users).toContain("conditional on the host allowing reuse");
  expect(users).toContain("Per-user workspaces and deliberate team/site sharing");
  const errors = await readGuide("compatibility-and-troubleshooting");
  expect(errors).toContain("legitimate source quotations");
  expect(errors).toContain("does not change a package's default error behavior");
});
