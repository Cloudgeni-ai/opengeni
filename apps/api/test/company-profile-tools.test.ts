import { describe, expect, test } from "bun:test";
import { COMPANY_PROFILE_STABLE_KEY_MAX_CHARS } from "@opengeni/contracts";
import { CompanyProfileOperationReuseError, type Database } from "@opengeni/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  COMPANY_PROFILE_PROPOSE_NEXT_ACTION,
  deriveCompanyProfileStableKey,
  registerCompanyProfileTools,
  resolveCompanyProfileEntries,
  type CompanyProfileProposeInput,
} from "../src/mcp/company-profile";

const ATTEMPT = {
  accountId: "00000000-0000-4000-8000-000000000101",
  workspaceId: "00000000-0000-4000-8000-000000000102",
  sessionId: "00000000-0000-4000-8000-000000000103",
  turnId: "00000000-0000-4000-8000-000000000104",
  attemptId: "00000000-0000-4000-8000-000000000105",
  executionGeneration: 2,
};
const OPERATION_ID = "00000000-0000-4000-8000-000000000109";
const REVISION_ID = "00000000-0000-4000-8000-000000000110";

type Handler = (input: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[];
}>;

function harness(options: { reuse?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, { description?: string }>();
  const proposals: CompanyProfileProposeInput[] = [];
  let authorizations = 0;
  const server = {
    registerTool(name: string, config: { description?: string }, handler: Handler) {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  } as unknown as McpServer;
  registerCompanyProfileTools({
    server,
    db: {} as Database,
    attempt: ATTEMPT,
    actorSubjectId: "worker:agent-attempt",
    async authorize() {
      authorizations += 1;
    },
    json: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] }),
    async propose(input) {
      proposals.push(input);
      if (options.reuse) throw new CompanyProfileOperationReuseError();
      return {
        outcome: "proposed",
        revision: {
          id: REVISION_ID,
          operationId: input.operationId,
          accountId: input.accountId,
          revision: 4,
          intent: "proposal",
          profile: input.profile,
          contentHash: "a".repeat(64),
          provenance: { source: "durable_learning", sourceId: input.sourceId },
          supersedesRevisionId: null,
          createdBySubjectId: input.actorSubjectId,
          createdAt: "2026-08-20T10:00:00.000Z",
        },
      };
    },
  });
  const call = (request: Record<string, unknown>) =>
    handlers.get("company_profile_propose")!(request).then(
      (result) => JSON.parse(result.content[0]!.text) as Record<string, unknown>,
    );
  return { handlers, configs, proposals, call, authorizations: () => authorizations };
}

const fullProfile = {
  operationId: OPERATION_ID,
  identity: "CloudGeni builds OpenGeni.",
  mission: "Make durable autonomous work dependable.",
  products: [{ content: "OpenGeni, the autonomous work platform." }],
  customers: [{ key: "Platform Teams", content: "Platform teams running agents for days." }],
  goals: [
    { content: "Make the agent brain simple and useful." },
    { content: "Make the agent brain simple and useful, again." },
  ],
  constraints: [],
  reason: "The user confirmed the proposed profile.",
};

describe("company_profile_propose MCP tool", () => {
  test("describes a proposal-only write that an organization admin activates", () => {
    const h = harness();
    expect([...h.handlers.keys()]).toEqual(["company_profile_propose"]);
    const description = h.configs.get("company_profile_propose")?.description ?? "";
    expect(description).toContain("inactive proposal");
    expect(description).toContain("never activates itself");
    expect(description).toContain("Company Brain → Company profile & goals");
    expect(description).toContain("only after the user confirmed");
  });

  test("authorizes, derives and de-duplicates keys, binds the attempt, and reports the next action", async () => {
    const h = harness();
    const result = await h.call(fullProfile);
    expect(h.authorizations()).toBe(1);
    expect(h.proposals).toEqual([
      {
        operationId: OPERATION_ID,
        accountId: ATTEMPT.accountId,
        workspaceId: ATTEMPT.workspaceId,
        actorSubjectId: "worker:agent-attempt",
        sourceId: `agent-attempt:${ATTEMPT.attemptId}`,
        profile: {
          identity: "CloudGeni builds OpenGeni.",
          mission: "Make durable autonomous work dependable.",
          products: [
            {
              key: "opengeni-the-autonomous-work-platform",
              content: "OpenGeni, the autonomous work platform.",
            },
          ],
          customers: [
            { key: "platform-teams", content: "Platform teams running agents for days." },
          ],
          goals: [
            {
              key: "make-the-agent-brain-simple-and",
              content: "Make the agent brain simple and useful.",
            },
            {
              key: "make-the-agent-brain-simple-and-2",
              content: "Make the agent brain simple and useful, again.",
            },
          ],
          constraints: [],
        },
      },
    ]);
    expect(result).toEqual({
      status: "proposed",
      operationId: OPERATION_ID,
      revisionId: REVISION_ID,
      revision: 4,
      nextAction: COMPANY_PROFILE_PROPOSE_NEXT_ACTION,
    });
  });

  test("rejects an empty profile without writing", async () => {
    const h = harness();
    const result = await h.call({
      operationId: OPERATION_ID,
      identity: null,
      mission: null,
      products: [],
      customers: [],
      goals: [],
      constraints: [],
      reason: "Nothing to record.",
    });
    expect(h.authorizations()).toBe(1);
    expect(h.proposals).toEqual([]);
    expect(result).toMatchObject({ status: "not_proposed", code: "invalid_profile" });
    expect(String(result["message"])).toContain("at least one field");
  });

  test("reports operation reuse as a typed non-proposal", async () => {
    const h = harness({ reuse: true });
    const result = await h.call(fullProfile);
    expect(h.proposals).toHaveLength(1);
    expect(result).toEqual({
      status: "not_proposed",
      code: "operation_reused",
      message: "The company-profile operation id was already used for another request",
    });
  });

  test("derived keys stay inside the stable-key alphabet and bound", () => {
    expect(deriveCompanyProfileStableKey("  Ship  the Agent Brain: simple & useful, fast!  ")).toBe(
      "ship-the-agent-brain-simple-useful",
    );
    expect(deriveCompanyProfileStableKey("!!! ???")).toBe("entry");
    const long = deriveCompanyProfileStableKey(`${"a".repeat(200)} b`);
    expect(long.length).toBeLessThanOrEqual(COMPANY_PROFILE_STABLE_KEY_MAX_CHARS);
    expect(
      resolveCompanyProfileEntries([
        { key: "Core", content: "one" },
        { content: "Core" },
        { content: "core" },
      ]).map((entry) => entry.key),
    ).toEqual(["core", "core-2", "core-3"]);
  });
});
