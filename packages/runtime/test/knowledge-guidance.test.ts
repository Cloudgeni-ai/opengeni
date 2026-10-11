import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { testSettings } from "@opengeni/testing";
import { allAgentCapabilities, type FirstPartyMcpToolName } from "@opengeni/contracts";
import {
  DEFAULT_AGENT_IDENTITY,
  buildOpenGeniAgent,
  composeModularAgentInstructions,
  coreInstructions,
  inspectPersistentAgentInstructions,
} from "../src";
import {
  KNOWLEDGE_GUIDANCE,
  KNOWLEDGE_GUIDANCE_RETRIEVAL_EXPERIMENT,
  knowledgeGuidance,
} from "../src/agent-instructions/modules/knowledge";

test.each([undefined, "CUSTOM PERSONA", "CUSTOM {{core}} PERSONA"])(
  "behavior storage routing is present without existing governance (template=%s)",
  (instructionsTemplate) => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      instructionsTemplate,
    });
    const prompt = agent.instructions;
    expect(typeof prompt).toBe("string");
    for (const guidance of [
      "Knowledge for reusable facts",
      "instruction_policy_get",
      "instruction_policy_save",
      "Do not save behavioral preferences as Knowledge",
      "Skill description",
      "widen personal guidance",
      "pending review",
      "Do not bypass",
    ]) {
      expect(prompt).toContain(guidance);
    }
    expect((prompt as string).split("Choose durable storage by purpose")).toHaveLength(2);
  },
);

test("behavior routing precedes Knowledge retention and preserves instruction edit safety", () => {
  const core = coreInstructions().join(" ");
  expect(core.indexOf("Choose durable storage by purpose")).toBeGreaterThan(-1);
  expect(core.indexOf("Choose durable storage by purpose")).toBeLessThan(
    core.indexOf("Use knowledge_search"),
  );
  expect(core).toContain("preserve unrelated rules");
  expect(core).toContain("localized exact anchored edit");
  expect(core).toContain("Agents cannot replace the complete instruction");
  expect(core).toContain("Do not promise future behavior from a Knowledge save");
});

test("agent guidance teaches canonical authoring, proposal reuse, and publication boundaries", async () => {
  const core = coreInstructions().join(" ");
  for (const concept of [
    "knowledge_save",
    "knowledge_get",
    "view=needs_review",
    "unapproved",
    "current version",
    "operationId",
    "task_note_save",
    "source revision",
  ])
    expect(core).toContain(concept);
  expect(core).not.toMatch(/memory_(save|correct|search|propose)/);
  const skill = await readFile(
    new URL("../src/bundled_management_skills/opengeni-skills/SKILL.md", import.meta.url),
    "utf8",
  );
  expect(skill).toContain("knowledge_save");
  expect(skill).toContain("pending");
  expect(skill.replace(/\s+/g, " ")).toContain("behavioral preferences");
  expect(skill).toContain("Skill description");
  expect(skill).toContain("not Knowledge");
  expect(skill).not.toMatch(/memory_(save|correct|search|propose)/);
});

test("shipped knowledge and integration guidance never sends users to retired writers or toggles", async () => {
  const root = new URL("../../../", import.meta.url);
  for (const path of [
    "README.md",
    "AGENTS.md",
    ".agents/skills/opengeni/SKILL.md",
    ".agents/skills/opengeni-client/SKILL.md",
    "docs/knowledge.md",
    "docs/company-brain-write-routing.md",
    "docs/hierarchical-memory.md",
    "docs/workspace-learning-policy.md",
    "docs/mcp-surfaces.md",
    "docs/product-integration.md",
    "docs-site/concepts/memory-and-knowledge.mdx",
    "docs-site/embed-manually.mdx",
    "docs-site/integrate/users-and-tenants.mdx",
    "docs-site/reference/sdk.mdx",
  ]) {
    const text = await readFile(new URL(path, root), "utf8");
    expect(text, path).not.toMatch(/memory_(save|correct|search|propose)/);
    expect(text, path).not.toMatch(
      /memoryEnabled:\s*true|disables? Memory tools|Memory is enabled/,
    );
  }
});

test.each([false, true])(
  "both prompt paths support selective learning and user corrections (modular=%s)",
  (modular) => {
    const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "none" }), [], {
      ...(modular
        ? {
            agentConfig: {
              version: 1 as const,
              from: "all" as const,
              capabilities: allAgentCapabilities(),
              unavailable: [],
              identity: null,
              renderer: "opengeni" as const,
              source: "request" as const,
            },
          }
        : {}),
    });
    const prompt = String(agent.instructions);
    for (const concept of [
      "the user need not say remember",
      "adopted choices",
      "only for the current task",
      "not unaccepted assistant proposals as adopted decisions",
      "Respect requests not to remember",
      "one updated conclusion per experiment",
      "settled incident lessons",
      "live status and interim rounds",
      "before work that depends on prior decisions",
      "skip unrelated searches",
      "settings permission",
      "Off prevents authoring but allows retrieval",
    ])
      expect(prompt).toContain(concept);
    expect(prompt.split("Choose durable storage by purpose")).toHaveLength(2);
  },
);

test("standing Knowledge guidance stays within its reviewed prompt budget", () => {
  expect(KNOWLEDGE_GUIDANCE.join(" ").length).toBeLessThan(2600);
});

describe("knowledge retrieval guidance experiment", () => {
  const added = [
    "before answering about this workspace's own projects, systems, people, hosts, ports or policies",
    "before acting on a correction or forget request",
    "skip general-knowledge questions",
    "a forget request archives it with knowledge_archive, never blanks it",
    'A "from now on" or "always" request about how to respond is a standing preference: save it in the same turn with skill_save, or instruction_policy_save for a workspace rule, without asking first; Review first saves it as pending.',
  ];

  function modular(
    experiment: boolean,
    unavailable: FirstPartyMcpToolName[] = [],
    skills: "read" | "manage" = "manage",
  ) {
    return composeModularAgentInstructions({
      capabilities: { ...allAgentCapabilities(), skills },
      renderer: "opengeni",
      identity: DEFAULT_AGENT_IDENTITY,
      resources: {
        managedSandbox: false,
        connectedMachine: false,
        repositories: false,
        gitCredentials: false,
        attachments: false,
      },
      ...(unavailable.length
        ? { toolAvailability: { unavailable: unavailable as FirstPartyMcpToolName[] } }
        : {}),
      ...(experiment ? { experiments: { knowledgeRetrievalGuidance: true } } : {}),
    }).composed;
  }

  test("is off by default in both compositions", () => {
    const legacy = inspectPersistentAgentInstructions(
      testSettings({ sandboxBackend: "none" }),
      {},
    ).composed;
    for (const prompt of [legacy, modular(false)]) {
      expect(prompt).toContain(KNOWLEDGE_GUIDANCE[1]!);
      for (const text of added) expect(prompt).not.toContain(text);
    }
  });

  test("the deployment flag switches both compositions", () => {
    const settings = testSettings({
      sandboxBackend: "none",
      experimentKnowledgeRetrievalGuidance: true,
    });
    const legacy = inspectPersistentAgentInstructions(settings, {}).composed;
    const configured = inspectPersistentAgentInstructions(settings, {
      agentConfig: {
        version: 1,
        from: "all",
        capabilities: allAgentCapabilities(),
        unavailable: [],
        identity: null,
        renderer: "opengeni",
        source: "request",
      },
    }).composed;
    for (const prompt of [legacy, configured, modular(true)]) {
      for (const text of added) expect(prompt).toContain(text);
      expect(prompt).not.toContain("skip unrelated searches");
      expect(prompt.split("Choose durable storage by purpose")).toHaveLength(2);
    }
  });

  test("every-tool rendering equals the shared experiment constant", () => {
    expect(knowledgeGuidance(() => true, { retrievalExperiment: true, skillSave: true })).toEqual([
      ...KNOWLEDGE_GUIDANCE_RETRIEVAL_EXPERIMENT,
    ]);
    expect(coreInstructions(undefined, undefined, { knowledgeRetrievalGuidance: true })).toEqual(
      expect.arrayContaining([...KNOWLEDGE_GUIDANCE_RETRIEVAL_EXPERIMENT]),
    );
  });

  test("never names an unavailable tool", () => {
    const prompt = modular(true, ["knowledge_archive", "instruction_policy_save"], "read");
    expect(prompt).not.toContain("knowledge_archive");
    expect(prompt).not.toContain("instruction_policy_save");
    expect(prompt).not.toContain("skill_save");
    expect(prompt).not.toContain("standing preference");
    expect(prompt).toContain("A correction updates the matching entry.");
  });

  test("stays a small addition to the reviewed budget", () => {
    const base = KNOWLEDGE_GUIDANCE.join(" ").length;
    const variant = KNOWLEDGE_GUIDANCE_RETRIEVAL_EXPERIMENT.join(" ").length;
    expect(variant - base).toBeLessThan(600);
  });
});
