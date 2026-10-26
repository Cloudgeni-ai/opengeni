// A turn with a file attached must send the same system instructions as a turn
// without one, so it shares the provider's cached prompt prefix. The file is
// still delivered: only the rendered instructions omit it.
import { describe, expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import { Manifest, dir } from "@openai/agents/sandbox";
import {
  allAgentCapabilities,
  type ResolvedAgentConfig,
  type ResourceRef,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";
import {
  agentPromptResourcesFor,
  buildOpenGeniAgent,
  manifestWithoutFileResourceEntries,
} from "../src/index";

const FILE_ID = "00000000-0000-4000-8000-0000000000f1";
const EARLIER_FILE_ID = "00000000-0000-4000-8000-0000000000f2";
const REPOSITORY: ResourceRef = { kind: "repository", uri: "https://github.com/acme/app" };
const FILE: ResourceRef = { kind: "file", fileId: FILE_ID };

const agentConfig: ResolvedAgentConfig = {
  version: 1,
  from: "all",
  capabilities: allAgentCapabilities(),
  unavailable: [],
  identity: null,
  renderer: "opengeni",
  source: "request",
};

const settings = testSettings({
  sandboxBackend: "docker",
  objectStorageEndpoint: "http://127.0.0.1:9000",
  objectStorageSandboxEndpoint: "http://host.docker.internal:9000",
  objectStorageAccessKeyId: "minioadmin",
  objectStorageSecretAccessKey: "minioadmin",
});

type PreparedSandboxAgent = {
  instructions: (context: RunContext, agent: unknown) => Promise<string>;
  runtimeManifest: Manifest;
};

// The SDK's own preparation step (patched): it renders the remote mount policy
// and filesystem layout sections from the agent's instruction manifest.
const { prepareSandboxAgent } = (await import(
  new URL(
    "../node_modules/@openai/agents-core/dist/sandbox/runtime/agentPreparation.mjs",
    import.meta.url,
  ).href
)) as {
  prepareSandboxAgent: (input: {
    agent: unknown;
    session: unknown;
    capabilities: unknown[];
  }) => PreparedSandboxAgent;
};

async function sentInstructions(
  resources: ResourceRef[],
  sessionManifest?: Manifest,
): Promise<{ text: string; runtimeManifest: Manifest }> {
  const agent = buildOpenGeniAgent(settings, resources, { agentConfig }) as unknown as {
    defaultManifest: Manifest;
  };
  const prepared = prepareSandboxAgent({
    agent,
    session: { state: { manifest: sessionManifest ?? agent.defaultManifest } },
    capabilities: [],
  });
  return {
    text: await prepared.instructions(new RunContext({}), prepared),
    runtimeManifest: prepared.runtimeManifest,
  };
}

describe("file attachments and the cached instruction prefix", () => {
  test("a turn with a file sends the instructions of a turn without one", async () => {
    const withoutFile = await sentInstructions([REPOSITORY]);
    const withFile = await sentInstructions([REPOSITORY, FILE]);
    expect(withFile.text).toBe(withoutFile.text);
    expect(withFile.text).not.toContain(FILE_ID);
    expect(withFile.text).not.toContain("# Sandbox remote mount policy");
    expect(withFile.text).not.toContain("# Attached files");
    // Session-level entries are still described.
    expect(withFile.text).toContain("# Filesystem");
    expect(withFile.text).toContain("repos/");
    // The file is still delivered through the manifest the session applies.
    expect(Object.keys(withFile.runtimeManifest.entries)).toContain(`.opengeni/files/${FILE_ID}`);
  });

  test("files from earlier turns in a resumed sandbox's manifest stay out too", async () => {
    const withoutFile = await sentInstructions([REPOSITORY]);
    const agent = buildOpenGeniAgent(settings, [REPOSITORY], { agentConfig }) as unknown as {
      defaultManifest: Manifest;
    };
    const resumed = new Manifest({
      ...agent.defaultManifest,
      entries: {
        ...agent.defaultManifest.entries,
        [`.opengeni/files/${EARLIER_FILE_ID}`]: dir(),
      },
    });
    expect((await sentInstructions([REPOSITORY], resumed)).text).toBe(withoutFile.text);
  });

  test("prompt resources ignore per-turn files", () => {
    expect(agentPromptResourcesFor(settings, [REPOSITORY, FILE], {})).toEqual(
      agentPromptResourcesFor(settings, [REPOSITORY], {}),
    );
  });

  test("the instruction manifest drops only file resource entries", () => {
    const custom: ResourceRef = { kind: "file", fileId: FILE_ID, mountPath: "inputs/report" };
    const manifest = new Manifest({
      entries: {
        "inputs/report": dir(),
        [`.opengeni/files/${EARLIER_FILE_ID}`]: dir(),
        "repos/github.com/acme/app": dir(),
      },
    });
    expect(
      Object.keys(manifestWithoutFileResourceEntries(manifest, [custom, REPOSITORY]).entries),
    ).toEqual(["repos/github.com/acme/app"]);
    const unchanged = new Manifest({ entries: { "repos/github.com/acme/app": dir() } });
    expect(manifestWithoutFileResourceEntries(unchanged, [REPOSITORY])).toBe(unchanged);
  });
});
