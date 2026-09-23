import { expect, test } from "bun:test";
import { readSkillCatalogContext, skillCatalogContextItem } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { inspectPersistentAgentInstructions } from "../src/index";
import { formatSkillCatalog } from "../src/skill-catalog";
import { projectHistoryForProvider } from "../src/provider-history-adapter";
import {
  buildCompactionReplacementHistory,
  buildRemoteV2ReplacementHistory,
  compactionReplacementFingerprint,
  latestCompactionReplacementFingerprint,
} from "../src/context-compaction";
import { reasoningConfigurationItem, readReasoningConfiguration } from "@opengeni/codex";

test("worker instructions remain byte-identical when catalog descriptors change", () => {
  const options = {
    skillCatalogInHistory: true,
    skillCatalog: [{ id: "test", name: "test", description: "old" }],
  };
  const initial = inspectPersistentAgentInstructions(testSettings(), options);
  const changed = inspectPersistentAgentInstructions(testSettings(), {
    ...options,
    skillCatalog: [{ id: "new", name: "new", description: "changed" }],
  });
  expect(changed.composed).toBe(initial.composed);
  expect(changed.layers.some((layer) => layer.id === "skill_catalog")).toBe(false);
});

test("catalog markers survive SDK text parts and chat provider projection", () => {
  const item = skillCatalogContextItem(formatSkillCatalog([]));
  const projected = projectHistoryForProvider([item], "chat");
  expect(projected[0]!.role).toBe("system");
  expect(item.role).toBe("developer");
  expect(readSkillCatalogContext(projected[0]!)).toBe(formatSkillCatalog([]));
  expect(
    readSkillCatalogContext({ ...item, content: [{ type: "input_text", text: item.content }] }),
  ).toBe(formatSkillCatalog([]));
  expect(readSkillCatalogContext({ ...item, role: "user" })).toBeNull();
});

test("both compaction strategies restore only the latest complete catalog and keep reasoning controls", () => {
  const control = reasoningConfigurationItem({
    version: 1,
    baselineEffort: "low",
    effort: "high",
    turnId: "turn",
  });
  const history = [
    skillCatalogContextItem("old"),
    { type: "message", role: "user", content: "work" },
    skillCatalogContextItem("current"),
    { type: "message", role: "user", content: "more work" },
    control,
  ];
  const replacements = [
    buildCompactionReplacementHistory(history, "summary"),
    buildRemoteV2ReplacementHistory(history, { type: "compaction", encrypted_content: "test" }),
  ];
  for (const replacement of replacements) {
    expect(replacement.filter((item) => readSkillCatalogContext(item) !== null)).toEqual([
      skillCatalogContextItem("current"),
    ]);
    expect(readSkillCatalogContext(replacement[0]!)).toBe("current");
    expect(readReasoningConfiguration(replacement.at(-1)!)?.effort).toBe("high");
    const twice = buildCompactionReplacementHistory(replacement, "summary");
    expect(twice.filter((item) => readSkillCatalogContext(item) !== null)).toHaveLength(1);
  }
  expect(latestCompactionReplacementFingerprint(replacements[0]!)).toBe(
    compactionReplacementFingerprint(replacements[0]!),
  );
  expect(history[0]).toEqual(skillCatalogContextItem("old"));
});

test("actual Responses SDK keeps earlier wire input unchanged when an updated catalog is appended", async () => {
  const { OpenAIResponsesModel } = await import("@openai/agents");
  class Probe extends OpenAIResponsesModel {
    send(request: any) {
      return this._fetchResponse(request, false);
    }
  }
  const bodies: any[] = [];
  const client = {
    responses: {
      create: async (body: any) => {
        bodies.push(body);
        return { id: "test", output: [], usage: {} };
      },
    },
  };
  const model = new Probe(client as any, "gpt-6-astra");
  const prior = [
    skillCatalogContextItem("original"),
    { type: "message", role: "user", content: "work" },
  ];
  const send = (input: any[]) =>
    model.send({
      systemInstructions: "stable instructions",
      input: projectHistoryForProvider(input, "responses"),
      modelSettings: {},
      tools: [],
      outputType: "text",
      handoffs: [],
      tracing: false,
    });
  await send(prior);
  await send([
    ...prior,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    skillCatalogContextItem("updated"),
    { type: "message", role: "user", content: "next" },
  ]);
  expect(bodies[1].input.slice(0, bodies[0].input.length)).toEqual(bodies[0].input);
  expect(bodies[1].input.at(-2).role).toBe("developer");
  expect(JSON.stringify(bodies[1].input.at(-2))).toContain("updated");
});

test("catalog survives an actual interrupted SDK RunState round-trip", async () => {
  const { Agent, Runner, RunState, tool } = await import("@openai/agents");
  const { ScriptedModel, functionCall } = await import("@opengeni/testing");
  const { z } = await import("zod");
  const agent = new Agent({
    name: "catalog restore",
    model: new ScriptedModel([{ output: [functionCall("confirm", {}, "confirm-call")] }]),
    tools: [
      tool({
        name: "confirm",
        description: "test",
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => "OK",
      }),
    ],
  });
  const wire = projectHistoryForProvider(
    [
      skillCatalogContextItem("frozen catalog"),
      { type: "message", role: "user", content: "proceed" },
    ],
    "responses",
  );
  const result = await new Runner({ tracingDisabled: true }).run(agent, wire as any);
  expect(result.interruptions).toHaveLength(1);
  const resumed = await RunState.fromString(agent, result.state.toString());
  expect(resumed.history[0]).toEqual(wire[0]);
  expect(readSkillCatalogContext(resumed.history[0] as any)).toBe("frozen catalog");
});
