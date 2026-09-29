import { describe, expect, test } from "bun:test";
import { Runner } from "@openai/agents";
import type { Database } from "@opengeni/db";
import { buildOpenGeniAgent, normalizeSdkEvent, prepareAgentTools } from "@opengeni/runtime";
import { assistantMessage, functionCall, ScriptedModel, testSettings } from "@opengeni/testing";
import {
  createWorkspaceSkillTools,
  skillLifecycleToolsSelected,
} from "../src/activities/agent-turn/skill-tools";

// An embedded session created with `firstPartyMcpTools: []` must not receive
// the in-process Skill-management surface (public install, save, publish...).

const scope = {
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003",
  turnId: "00000000-0000-4000-8000-000000000004",
  attemptId: "00000000-0000-4000-8000-000000000005",
  executionGeneration: 1,
};

/** Any database access means a Skill tool got past registration. */
function recordingDb() {
  const touched: string[] = [];
  const db = new Proxy(
    {},
    {
      get(_target, property) {
        touched.push(String(property));
        throw new Error(`database reached through ${String(property)}`);
      },
    },
  ) as Database;
  return { db, touched };
}

function definitions(db: Database, includeLifecycleTools?: boolean) {
  return createWorkspaceSkillTools({
    db,
    settings: testSettings({}),
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    actor: { kind: "agent", ...scope },
    selected: [],
    filesystem: async () => {
      throw new Error("not used");
    },
    modelToolOutputTruncationTokens: () => 10_000,
    ...(includeLifecycleTools === undefined ? {} : { includeLifecycleTools }),
  });
}

async function attemptSkillSave(includeLifecycleTools: boolean) {
  const { db, touched } = recordingDb();
  const settings = testSettings({});
  const prepared = await prepareAgentTools(settings, [], {
    ...scope,
    attemptToolDefinitions: definitions(db, includeLifecycleTools),
  });
  const outputs: unknown[] = [];
  let failure: unknown = null;
  try {
    const agent = buildOpenGeniAgent(settings, [], {
      model: new ScriptedModel([
        {
          output: [
            functionCall(
              "skill_save",
              {
                operationId: "00000000-0000-4000-8000-000000000008",
                skillId: "00000000-0000-4000-8000-000000000009",
                expectedRevisionId: null,
                expectedScopeVersion: 1,
                files: [
                  {
                    path: "SKILL.md",
                    content: "---\nname: persisted\ndescription: Injected.\n---\n# Persisted\n",
                  },
                ],
                reason: "prompt asked to remember this",
              },
              "save-1",
            ),
          ],
        },
        { output: [assistantMessage("done", "final")] },
      ]),
      skillCatalog: [],
      mcpServers: prepared.mcpServers,
    });
    const result = await new Runner({ tracingDisabled: true }).run(agent, "remember this", {
      stream: true,
      maxTurns: 4,
    });
    for await (const event of result.toStream()) {
      for (const normalized of normalizeSdkEvent(event)) {
        if (normalized.type === "agent.toolCall.output") outputs.push(normalized.payload);
      }
    }
    await result.completed;
  } catch (error) {
    failure = error;
  } finally {
    await prepared.close();
  }
  return { touched, outputs, failure };
}

describe("Skill lifecycle tool selection", () => {
  test("an empty effective first-party selection withholds the lifecycle tools", () => {
    expect(skillLifecycleToolsSelected([])).toBe(false);
    expect(definitions(recordingDb().db, false).map((tool) => tool.modelName)).toEqual([
      "skill_read",
    ]);
  });

  test("any non-empty selection keeps the historical Skill tool set", () => {
    expect(skillLifecycleToolsSelected(["set_session_title"])).toBe(true);
    const names = definitions(recordingDb().db).map((tool) => tool.modelName);
    expect(names).toEqual(definitions(recordingDb().db, true).map((tool) => tool.modelName));
    expect([...names].sort()).toEqual([
      "skill_checkout",
      "skill_install",
      "skill_publish",
      "skill_read",
      "skill_remove",
      "skill_save",
      "skill_search",
    ]);
  });

  test("a model call to a withheld Skill writer is refused before any authority is consulted", async () => {
    const withheld = await attemptSkillSave(false);
    // Nothing named skill_save is registered, so the call never reaches the
    // attempt/Learning authorization or the Skill ledger.
    expect(withheld.touched).toEqual([]);
    expect(String(withheld.failure)).toContain("Tool skill_save not found");
    expect(withheld.outputs).toEqual([]);

    // Control: when registered, the same call does reach the Skill authority.
    const registered = await attemptSkillSave(true);
    expect(registered.touched.length).toBeGreaterThan(0);
  });
});
