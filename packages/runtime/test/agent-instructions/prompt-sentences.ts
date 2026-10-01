import { DEFAULT_AGENT_INSTRUCTIONS } from "@opengeni/config";
import { allAgentCapabilities } from "@opengeni/contracts";
import { composeAgentInstructions } from "../../src/index";
import {
  composeModularAgentInstructions,
  DEFAULT_AGENT_IDENTITY,
  type AgentPromptResources,
} from "../../src/agent-instructions";
import { OPENGENI_OPERATIONAL_INSTRUCTIONS } from "../../src/operational-instructions";

/**
 * Sentence-level view of a prompt: headings are structure, not sentences;
 * list markers and whitespace are layout. Two prompts with the same sentence
 * set say the same things.
 */
export function promptSentences(text: string): Set<string> {
  const sentences = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^(?:[-*]|\d+\.)\s+/u, "");
    if (!line || raw.trim().startsWith("#")) continue;
    for (const sentence of line.split(/(?<=[.!?])\s+/u)) {
      const trimmed = sentence.trim();
      if (trimmed) sentences.add(trimmed);
    }
  }
  return sentences;
}

export const ALL_RESOURCES: AgentPromptResources = {
  managedSandbox: true,
  connectedMachine: true,
  repositories: true,
  gitCredentials: true,
  attachments: true,
  workspaceEnvironment: {
    name: "prod",
    description: "Use DEPLOY_KEY for deploys.",
    variableNames: ["DEPLOY_KEY", "API_URL"],
  },
  rig: { name: "python", version: 3 },
};

/** The legacy contract + default template + CORE, with every conditional block present. */
export function legacyAllText(): string {
  return `${OPENGENI_OPERATIONAL_INSTRUCTIONS}\n\n${composeAgentInstructions(
    DEFAULT_AGENT_INSTRUCTIONS,
    ALL_RESOURCES.workspaceEnvironment,
    ALL_RESOURCES.rig,
  )}`;
}

/** Modular `"all"` + `opengeni` renderer + every resource, with the default identity. */
export function modularAllText(): string {
  return composeModularAgentInstructions({
    capabilities: allAgentCapabilities(),
    renderer: "opengeni",
    identity: DEFAULT_AGENT_IDENTITY,
    resources: ALL_RESOURCES,
  }).composed;
}

/** `- ` / `+ ` lines of every ```diff block in the changelog. */
export function changelogDiff(markdown: string): { removed: Set<string>; added: Set<string> } {
  const removed = new Set<string>();
  const added = new Set<string>();
  for (const block of markdown.matchAll(/```diff\n([\s\S]*?)```/gu)) {
    for (const line of block[1]!.split("\n")) {
      if (line.startsWith("- ")) removed.add(line.slice(2).trim());
      else if (line.startsWith("+ ")) added.add(line.slice(2).trim());
    }
  }
  return { removed, added };
}
