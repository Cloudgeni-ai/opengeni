/**
 * A turn with an attached file must start on every deployment shape: each
 * sandbox backend in CAPABILITY_DESCRIPTORS with each configurable object
 * storage backend. Each case runs what a turn runs for its attachment: the
 * worker's pre-signed download decision (sandboxFileDownloadsForRun), the
 * filesystem layout history item (workspaceFilesystemLayout), the agent build
 * (buildOpenGeniAgent, whose manifest gets those downloads) and the SDK's
 * instruction rendering. The matrix is derived from the descriptors and the
 * settings, so a new backend is covered without editing this file. No
 * combination is rejected by configuration today; each storage fixture
 * carries the credentials its backend requires.
 *
 * 2026-11-20: a layout built for Modal with Azure Blob threw because it had no
 * downloads to give, which failed every production turn with an attachment.
 */
import { describe, expect, mock, test } from "bun:test";
import * as realDb from "@opengeni/db";
import { RunContext } from "@openai/agents-core";
import type { Manifest } from "@openai/agents/sandbox";
import { OBJECT_STORAGE_BACKENDS, type Settings } from "@opengeni/config";
import {
  allAgentCapabilities,
  CAPABILITY_DESCRIPTORS,
  type ResolvedAgentConfig,
  type ResourceRef,
  type SandboxBackend,
} from "@opengeni/contracts";
import type { ObjectStorage } from "@opengeni/storage";
import { testSettings } from "@opengeni/testing/settings";

const FILE_ID = "00000000-0000-4000-8000-0000000000a1";
const FILE_PATH = `.opengeni/files/${FILE_ID}`;
const FILENAME = "report.txt";
const REPOSITORY: ResourceRef = { kind: "repository", uri: "https://github.com/acme/app" };
const FILE: ResourceRef = { kind: "file", fileId: FILE_ID };
const MACHINE_ROOT = "/home/user";

mock.module("@opengeni/db", () => ({
  ...realDb,
  requireFileForSubject: async (_db: unknown, input: { fileId: string }) => ({
    id: input.fileId,
    objectKey: `files/${input.fileId}/original`,
    safeFilename: FILENAME,
    sizeBytes: 12,
    sha256: "a".repeat(64),
  }),
}));

const { sandboxFileDownloadsForRun } = await import("../src/activities/agent-turn/file-resources");
const { buildOpenGeniAgent, workspaceFilesystemLayout } = await import("@opengeni/runtime");

// The SDK's own preparation step (patched): it renders the instructions from
// the agent's instruction manifest, as every turn does.
const { prepareSandboxAgent } = (await import(
  new URL("./sandbox/runtime/agentPreparation.mjs", import.meta.resolve("@openai/agents-core")).href
)) as {
  prepareSandboxAgent: (input: { agent: unknown; session: unknown; capabilities: unknown[] }) => {
    instructions: (context: RunContext, agent: unknown) => Promise<string>;
  };
};

const agentConfig: ResolvedAgentConfig = {
  version: 1,
  from: "all",
  capabilities: allAgentCapabilities(),
  unavailable: [],
  identity: null,
  renderer: "opengeni",
  source: "request",
};

const STORAGE_SETTINGS: Record<(typeof OBJECT_STORAGE_BACKENDS)[number], Partial<Settings>> = {
  "s3-compatible": {
    objectStorageEndpoint: "https://storage.example.test",
    objectStorageAccessKeyId: "fixture-access",
    objectStorageSecretAccessKey: "fixture-secret",
  },
  "aws-s3": {},
  "azure-blob": {
    objectStorageAzureConnectionString:
      "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=c2VjcmV0;BlobEndpoint=https://acct.blob.core.windows.net/",
  },
  gcs: { objectStorageGcsProjectId: "fixture-project" },
};

const SANDBOX_BACKENDS = Object.keys(CAPABILITY_DESCRIPTORS) as SandboxBackend[];

function settingsFor(
  sandboxBackend: SandboxBackend,
  objectStorageBackend: (typeof OBJECT_STORAGE_BACKENDS)[number],
): Settings {
  return testSettings({
    sandboxBackend,
    objectStorageBackend,
    ...STORAGE_SETTINGS[objectStorageBackend],
  });
}

function fakeObjectStorage(backend: Settings["objectStorageBackend"]): ObjectStorage {
  return {
    bucket: "opengeni-files",
    backend,
    createGetUrl: async ({ key }: { key: string }) => ({
      url: `https://storage.example.test/${key}?signature=fixture`,
      expiresAt: new Date(Date.now() + 60_000),
    }),
  } as unknown as ObjectStorage;
}

/** Where the turn runs, as the worker passes it: a Connected Machine reports its root. */
function placement(active: SandboxBackend | undefined) {
  return active === "selfhosted"
    ? { activeSandboxBackend: active, sandboxWorkspaceRoot: MACHINE_ROOT }
    : active
      ? { activeSandboxBackend: active }
      : {};
}

/**
 * Runs a turn's attachment path for a deployment configured with `settings`
 * whose turn runs on `active` (the deployment's own backend when undefined),
 * and checks the file reaches the box the way that box can receive it.
 */
async function startTurnWithAttachment(settings: Settings, active?: SandboxBackend) {
  const runsOn = active ?? settings.sandboxBackend;
  const resources = [REPOSITORY, FILE];
  const downloads = await sandboxFileDownloadsForRun(
    settings,
    {} as never,
    fakeObjectStorage(settings.objectStorageBackend),
    "account",
    "workspace",
    null,
    resources,
    runsOn,
  );
  const at = placement(active);
  const layout = workspaceFilesystemLayout(settings, resources, at);
  // The layout never depends on the attachment.
  expect(layout).toBe(workspaceFilesystemLayout(settings, [REPOSITORY], at));
  if (settings.sandboxBackend === "none") {
    expect(layout).toBeNull();
  } else {
    expect(layout).toStartWith(runsOn === "selfhosted" ? MACHINE_ROOT : "/");
    expect(layout).not.toContain(FILE_ID);
  }

  const agent = buildOpenGeniAgent(settings, resources, {
    agentConfig,
    fileResourceDownloads: downloads,
    ...at,
  }) as unknown as { defaultManifest?: Manifest };
  if (settings.sandboxBackend === "none") {
    expect(agent.defaultManifest).toBeUndefined();
    return;
  }
  const manifest = agent.defaultManifest!;
  const instructions = prepareSandboxAgent({
    agent,
    session: { state: { manifest } },
    capabilities: [],
  });
  expect(await instructions.instructions(new RunContext({}), instructions)).not.toContain(FILE_ID);

  const downloaded = downloads.some((download) => download.fileId === FILE_ID);
  const entry = manifest.entries[FILE_PATH] as
    | { type: string; mountStrategy?: unknown }
    | undefined;
  const bucketMount = CAPABILITY_DESCRIPTORS[runsOn].bucketMount;
  if (runsOn === "selfhosted") {
    // A Connected Machine gets no resource entries; the download delivers it.
    expect(entry).toBeUndefined();
    expect(downloaded).toBe(true);
  } else if (downloaded) {
    expect(entry?.type).toBe("dir");
  } else {
    // Mounted: only a box that can mount object storage, with its own strategy.
    expect(bucketMount).not.toBe("none");
    expect(entry?.type).toMatch(/_mount$/);
    expect((entry!.mountStrategy as { type?: string }).type).toBe(
      bucketMount === "native" ? "modal_cloud_bucket" : "in_container",
    );
  }
  return { downloaded, entry };
}

describe("a turn with an attached file", () => {
  for (const sandboxBackend of SANDBOX_BACKENDS) {
    for (const objectStorageBackend of OBJECT_STORAGE_BACKENDS) {
      test(`starts on ${sandboxBackend} with ${objectStorageBackend} storage`, async () => {
        const settings = settingsFor(sandboxBackend, objectStorageBackend);
        await startTurnWithAttachment(
          settings,
          // The worker passes a Connected Machine as the active backend.
          sandboxBackend === "selfhosted" ? "selfhosted" : undefined,
        );
      });
    }
  }

  test("covers the deployment shape of the 2026-11-20 incident", async () => {
    const result = await startTurnWithAttachment(settingsFor("modal", "azure-blob"));
    expect(result?.downloaded).toBe(true);
  });

  // The active box can differ from the deployment's default backend (a
  // session on another provider, or moved to a Connected Machine). Its file
  // mounts must follow the box it runs on, as its downloads do.
  for (const deploymentBackend of SANDBOX_BACKENDS.filter((backend) => backend !== "none")) {
    for (const objectStorageBackend of OBJECT_STORAGE_BACKENDS) {
      test(`a ${deploymentBackend} deployment with ${objectStorageBackend} starts it on every other backend`, async () => {
        const settings = settingsFor(deploymentBackend, objectStorageBackend);
        for (const active of SANDBOX_BACKENDS) {
          if (active === "none" || active === deploymentBackend) continue;
          await startTurnWithAttachment(settings, active);
        }
      });
    }
  }
});
