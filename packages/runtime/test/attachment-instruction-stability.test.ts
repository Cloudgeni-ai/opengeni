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
  buildManifest,
  workspaceFilesystemLayout,
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
// and filesystem layout sections from the manifest unless the agent turns
// them off (`manifestInstructions: false`), as Opengeni's agent does.
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
  placement: { activeSandboxBackend?: "selfhosted"; sandboxWorkspaceRoot?: string } = {},
  kind: "configured agent" | "plain chat" = "configured agent",
): Promise<{ text: string; runtimeManifest: Manifest }> {
  const agent = buildOpenGeniAgent(settings, resources, {
    ...(kind === "configured agent" ? { agentConfig } : {}),
    ...placement,
  }) as unknown as {
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
    // Session-level entries are still described, in the layout history item.
    expect(workspaceFilesystemLayout(settings, [REPOSITORY, FILE])).toBe(
      workspaceFilesystemLayout(settings, [REPOSITORY]),
    );
    expect(workspaceFilesystemLayout(settings, [REPOSITORY, FILE])).toContain("repos/");
    expect(workspaceFilesystemLayout(settings, [REPOSITORY, FILE])).not.toContain(FILE_ID);
    // The file is still delivered through the manifest the session applies.
    expect(Object.keys(withFile.runtimeManifest.entries)).toContain(`.opengeni/files/${FILE_ID}`);
  });

  test("the layout of a turn with a file needs no file entry where storage cannot be mounted", () => {
    // Azure Blob on a native bucket-mount backend, and AWS S3 or GCS anywhere,
    // reach the sandbox only by the turn's pre-signed download. The layout
    // lists no files, so a turn with an attachment still gets its layout.
    for (const storage of [
      testSettings({
        sandboxBackend: "modal",
        objectStorageBackend: "azure-blob",
        objectStorageAzureConnectionString:
          "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=secret;BlobEndpoint=https://acct.blob.core.windows.net/",
      }),
      testSettings({ sandboxBackend: "docker", objectStorageBackend: "aws-s3" }),
      testSettings({ sandboxBackend: "modal", objectStorageBackend: "gcs" }),
    ]) {
      const withoutFile = workspaceFilesystemLayout(storage, [REPOSITORY]);
      expect(withoutFile).toContain("repos/");
      expect(workspaceFilesystemLayout(storage, [REPOSITORY, FILE])).toBe(withoutFile);
    }
  });

  for (const kind of ["configured agent", "plain chat"] as const) {
    test(`${kind}: moving the session between machines keeps the instructions byte-identical`, async () => {
      const managed = await sentInstructions([REPOSITORY], undefined, {}, kind);
      const linux = await sentInstructions(
        [REPOSITORY],
        undefined,
        { activeSandboxBackend: "selfhosted", sandboxWorkspaceRoot: "/home/user" },
        kind,
      );
      const mac = await sentInstructions(
        [REPOSITORY],
        undefined,
        { activeSandboxBackend: "selfhosted", sandboxWorkspaceRoot: "/Users/user" },
        kind,
      );
      // Managed sandbox, one machine and another: one system prompt.
      expect(linux.text).toBe(managed.text);
      expect(mac.text).toBe(managed.text);
      for (const sent of [managed, linux, mac]) {
        expect(sent.text).not.toContain("The filesystem layout is");
        expect(sent.text).not.toContain("/home/user");
        expect(sent.text).not.toContain("/Users/user");
        expect(sent.text).toContain("<opengeni_workspace_filesystem>");
      }
      // The box still applies each machine's own root.
      expect(managed.runtimeManifest.root).toBe("/workspace");
      expect(linux.runtimeManifest.root).toBe("/home/user");
      expect(mac.runtimeManifest.root).toBe("/Users/user");
    });
  }

  test("the layout describes the workspace the turn's box applies", () => {
    // Managed sandbox: /workspace with its repositories.
    const managed = workspaceFilesystemLayout(settings, [REPOSITORY]);
    expect(managed).toStartWith("/workspace\n");
    expect(managed).toContain("repos/");
    // The system prompt describes the deployment's managed sandboxes, so the
    // layout of a Connected Machine says what working there means.
    const onMachine = workspaceFilesystemLayout(settings, [REPOSITORY], {
      activeSandboxBackend: "selfhosted",
      sandboxWorkspaceRoot: "/home/user",
    });
    expect(onMachine).toStartWith("/home/user\n\n# Connected Machine\n\n");
    // Opengeni puts nothing on the person's own machine: the layout is its root.
    expect(onMachine!.split("\n\n")[0]).toBe("/home/user");
    expect(onMachine).toContain("Guidance about managed sandboxes does not apply on this machine");
    expect(onMachine).not.toContain("sandbox:/home/u/proj");
    expect(
      workspaceFilesystemLayout(settings, [REPOSITORY], {
        activeSandboxBackend: "selfhosted",
        sandboxWorkspaceRoot: "/home/user",
        renderer: "opengeni",
      }),
    ).toContain("sandbox:/home/u/proj/app.py:12");
    // A deployment whose own compute is Connected Machines says it in the prompt.
    expect(
      workspaceFilesystemLayout({ ...settings, sandboxBackend: "selfhosted" }, [REPOSITORY], {
        activeSandboxBackend: "selfhosted",
        sandboxWorkspaceRoot: "/home/user",
      }),
    ).toBe("/home/user");
    // A Connected Machine that reported no root has no workspace to describe;
    // the agent build refuses it the same way.
    expect(() =>
      workspaceFilesystemLayout(settings, [REPOSITORY], { activeSandboxBackend: "selfhosted" }),
    ).toThrow("reported workspace root");
    expect(() =>
      buildOpenGeniAgent(settings, [REPOSITORY], {
        agentConfig,
        activeSandboxBackend: "selfhosted",
      }),
    ).toThrow("reported workspace root");
    // No sandbox: no layout.
    expect(workspaceFilesystemLayout({ ...settings, sandboxBackend: "none" }, [REPOSITORY])).toBe(
      null,
    );
    expect(
      workspaceFilesystemLayout({ ...settings, sandboxBackend: "none" }, [REPOSITORY], {
        activeSandboxBackend: "selfhosted",
        sandboxWorkspaceRoot: "/home/user",
      }),
    ).toBeNull();
  });

  test("files from earlier turns in a resumed sandbox's manifest stay out too", async () => {
    const withoutFile = await sentInstructions([REPOSITORY]);
    const agent = buildOpenGeniAgent(settings, [REPOSITORY], { agentConfig }) as unknown as {
      defaultManifest: Manifest;
    };
    // A file mounted from object storage at its own path on an earlier turn.
    const earlierMount = buildManifest(settings, [
      { kind: "file", fileId: EARLIER_FILE_ID, mountPath: "inputs/report" },
    ]).entries["inputs/report"];
    expect((earlierMount as { type: string }).type).toMatch(/_mount$/);
    const resumed = new Manifest({
      ...agent.defaultManifest,
      entries: {
        ...agent.defaultManifest.entries,
        [`.opengeni/files/${EARLIER_FILE_ID}`]: dir(),
        "inputs/report": earlierMount,
      },
    });
    const sent = await sentInstructions([REPOSITORY], resumed);
    expect(sent.text).toBe(withoutFile.text);
    expect(sent.text).not.toContain("# Sandbox remote mount policy");
    expect(sent.text).not.toContain("inputs/report");
  });

  test("prompt resources ignore per-turn files", () => {
    expect(agentPromptResourcesFor(settings, [REPOSITORY, FILE], {})).toEqual(
      agentPromptResourcesFor(settings, [REPOSITORY], {}),
    );
  });
});
