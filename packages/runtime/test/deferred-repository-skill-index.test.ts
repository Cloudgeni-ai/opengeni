// A chat with a repository attached on a lazily provisioned box must reach the
// model without preparing the workspace: creating the box, running its
// environment setup and cloning the repository happen at the first tool call.
// This runs the Agents SDK's own preparation over every capability the agent
// has, against a provided session that records any use.
import { describe, expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import type { Manifest } from "@openai/agents/sandbox";
import {
  allAgentCapabilities,
  type ResolvedAgentConfig,
  type ResourceRef,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import { buildOpenGeniAgent, repositoryWorkspaceSkillPathsOption } from "../src/index";

const REPOSITORY: ResourceRef = { kind: "repository", uri: "https://github.com/acme/app" };

const agentConfig: ResolvedAgentConfig = {
  version: 1,
  from: "all",
  capabilities: allAgentCapabilities(),
  unavailable: [],
  identity: null,
  renderer: "opengeni",
  source: "request",
};

const settings = testSettings({ sandboxBackend: "docker" });

type PreparedSandboxAgent = {
  instructions: (context: RunContext, agent: unknown) => Promise<string>;
};

const { prepareSandboxAgent } = (await import(
  new URL(
    "../node_modules/@openai/agents-core/dist/sandbox/runtime/agentPreparation.mjs",
    import.meta.url,
  ).href
)) as {
  prepareSandboxAgent: (input: { agent: unknown; session: unknown }) => PreparedSandboxAgent;
};

/** Every call on this object is a use of the workspace. */
function recordingOperations(prefix: string, uses: string[]): object {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then" || typeof property === "symbol") return undefined;
        return (..._args: unknown[]) => {
          uses.push(`${prefix}${String(property)}`);
          throw new Error(`the workspace was used before the model: ${String(property)}`);
        };
      },
    },
  );
}

/** A provided session whose every operation is recorded. Binding the file
 * editor is not an operation; using it is. */
function recordingSession(manifest: Manifest): { session: unknown; uses: string[] } {
  const uses: string[] = [];
  const operations = recordingOperations("", uses) as Record<string | symbol, unknown>;
  const editor = recordingOperations("editor.", uses);
  const session = new Proxy(
    { state: { manifest } },
    {
      get(target, property) {
        if (property === "state") return target.state;
        if (property === "createEditor") return () => editor;
        // What the provider supports, answered without the box.
        if (property === "supportsPty") return () => false;
        return operations[property];
      },
    },
  );
  return { session, uses };
}

async function firstRequestInstructions(
  deferRepositorySkillIndex: boolean,
): Promise<{ text: string; uses: string[] }> {
  const agent = buildOpenGeniAgent(settings, [REPOSITORY], {
    agentConfig,
    ...repositoryWorkspaceSkillPathsOption([REPOSITORY]),
    ...(deferRepositorySkillIndex ? { deferRepositorySkillIndex: true } : {}),
  }) as unknown as { defaultManifest: Manifest };
  const { session, uses } = recordingSession(agent.defaultManifest);
  // The agent's own capabilities, cloned and bound to the session per run.
  const prepared = prepareSandboxAgent({ agent, session });
  try {
    return { text: await prepared.instructions(new RunContext({}), prepared), uses };
  } catch {
    return { text: "", uses };
  }
}

describe("a repository chat on a lazily provisioned box", () => {
  test("the first model request needs nothing from the workspace", async () => {
    const { text, uses } = await firstRequestInstructions(true);
    expect(uses).toEqual([]);
    expect(text).toContain("## Repository skills");
    expect(text).toContain("look in those folders yourself");
  });

  test("the live index is what used the workspace before", async () => {
    const { uses } = await firstRequestInstructions(false);
    expect(uses.length).toBeGreaterThan(0);
  });
});
