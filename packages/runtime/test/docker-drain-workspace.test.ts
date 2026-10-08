import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  mkdirSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cid = "a".repeat(64);
const uuid = "e6eaed4d-c965-4c62-bca7-40e9465e9b05";
const fp = "b".repeat(64);
let root = "";
let present = true;
let running = true;
let daemonId = "owned-daemon";
let foreign = false;
const nativeCalls: string[][] = [];
const probe = async (args: readonly string[]) => {
  nativeCalls.push([...args]);
  if (args[0] === "info") return { stdout: daemonId, stderr: "" };
  if (args[0] === "inspect") {
    if (!present)
      throw Object.assign(new Error("literal missing"), {
        code: 1,
        signal: null,
        killed: false,
        stderr: "Error: No such object: " + cid,
      });
    return {
      stdout: JSON.stringify({
        id: cid,
        running,
        labels: {
          "openai-agents-sandbox": "true",
          "openai-agents-sandbox.session-identity": foreign ? "foreign" : uuid,
          "openai-agents-sandbox.mount-authority-fingerprint": fp,
        },
        mounts: [{ Type: "bind", Source: root, Destination: "/workspace", RW: true }],
      }),
      stderr: "",
    };
  }
  if (args[0] === "rm") {
    present = false;
    return { stdout: cid, stderr: "" };
  }
  throw new Error("effect outside closed mock: " + JSON.stringify(args));
};

const { Manifest } = await import("@openai/agents/sandbox");
const codec = await import("../src/sandbox/host-archive-spool");
const {
  attachDockerWorkspaceForDrain,
  rememberOwnedDockerSdkState,
  rememberSerializedDockerOwnership,
  serializeDockerOwnership,
} = await import("../src/sandbox/providers/docker-workspace-drain");
const { captureWorkspaceArchiveForStorage, disposeWorkspaceArchive } =
  await import("../src/sandbox/workspace-archive");
const { testSettings } = await import("@opengeni/testing");
const { terminateProviderBox, verifyDockerDrainCaptureFence } =
  await import("../../../apps/worker/src/activities/sandbox-lease");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opengeni-docker-drain-owned-"));
  writeFileSync(join(root, "preserved.txt"), "actual retained bytes");
  present = running = true;
  foreign = false;
  daemonId = "owned-daemon";
  nativeCalls.length = 0;
});
afterEach(() => {
  mock.restore();
  rmSync(root, { recursive: true, force: true });
});

function state() {
  return {
    containerId: cid,
    sessionIdentity: uuid,
    workspaceRootPath: root,
    workspaceRootOwned: true,
    snapshot: null,
    snapshotSpec: null,
    image: "fixture-image",
    environment: {},
    manifest: new Manifest(),
    configuredExposedPorts: [],
    dockerVolumeNames: [],
  };
}
const client = {
  canReusePreservedOwnedSession: async () => true,
};
async function recordedState() {
  const original = state();
  rememberOwnedDockerSdkState(original as never);
  const serialized = await serializeDockerOwnership(client as never, original as never, probe);
  const restored = { ...original };
  rememberSerializedDockerOwnership(restored as never, { ...original, ...serialized });
  return { original, restored, serialized };
}
const captureFence = async () => ({ archivePublished: false });

test("caller state shape alone cannot mint protected ownership", async () => {
  expect(await serializeDockerOwnership(client as never, state() as never, probe)).toEqual({});
  expect(nativeCalls).toHaveLength(0);
});

test.each([false, true])(
  "legacy stopped/missing (missing=%s) never resumes or reads contents",
  async (missing) => {
    present = !missing;
    running = false;
    const capture = spyOn(codec, "captureHostWorkspaceArchive");
    await expect(
      attachDockerWorkspaceForDrain(client as never, state() as never, captureFence, probe),
    ).rejects.toThrow("no owned-root receipt");
    expect(capture).not.toHaveBeenCalled();
    expect(nativeCalls.every((x) => x[0] === "inspect")).toBe(true);
  },
);

test("current capture fence rejects before native or filesystem observation", async () => {
  await expect(
    attachDockerWorkspaceForDrain(
      client as never,
      state() as never,
      async () => {
        throw new Error("changed epoch");
      },
      probe,
    ),
  ).rejects.toThrow("changed epoch");
  expect(nativeCalls).toHaveLength(0);
});

test("protected receipt captures preserved workspace after exact container disappeared", async () => {
  const { restored } = await recordedState();
  present = false;
  const handle = await attachDockerWorkspaceForDrain(
    client as never,
    restored as never,
    captureFence,
    probe,
  );
  for (const name of [
    "exec",
    "execCommand",
    "resume",
    "create",
    "close",
    "readFile",
    "hydrateWorkspace",
  ])
    expect(name in handle).toBe(false);
  const archive = await captureWorkspaceArchiveForStorage(
    handle,
    Date.now(),
    { requestId: uuid },
    true,
  );
  try {
    expect(archive.kind).toBe("host_spool");
    if (archive.kind !== "host_spool") throw new Error("wrong archive transport");
    const chunks: Uint8Array[] = [];
    for await (const chunk of archive.spool.open()) chunks.push(chunk);
    expect(JSON.parse(Buffer.concat(chunks).toString()).files).toEqual([
      { path: "preserved.txt", data: Buffer.from("actual retained bytes").toString("base64") },
    ]);
  } finally {
    await disposeWorkspaceArchive(archive);
  }
  expect(nativeCalls.some((x) => ["run", "exec", "network", "rm"].includes(x[0]!))).toBe(false);
});

test.each(["daemon", "foreign", "inode", "mode", "symlink"])(
  "protected receipt rejects %s drift before content capture",
  async (kind) => {
    const { restored } = await recordedState();
    present = false;
    if (kind === "daemon") daemonId = "foreign-daemon";
    if (kind === "foreign") {
      present = true;
      foreign = true;
    }
    let saved: string | undefined;
    if (kind === "inode" || kind === "symlink") {
      saved = root + "-original";
      renameSync(root, saved);
      if (kind === "inode") {
        mkdirSync(root);
        writeFileSync(join(root, "foreign.txt"), "forbidden");
      } else symlinkSync(saved, root);
    }
    if (kind === "mode") chmodSync(root, 0o755);
    const capture = spyOn(codec, "captureHostWorkspaceArchive");
    try {
      await expect(
        attachDockerWorkspaceForDrain(client as never, restored as never, captureFence, probe),
      ).rejects.toThrow();
      expect(capture).not.toHaveBeenCalled();
      expect(nativeCalls.some((x) => ["run", "exec", "network", "rm"].includes(x[0]!))).toBe(false);
    } finally {
      if (saved) {
        rmSync(root, { recursive: true, force: true });
        renameSync(saved, root);
      }
    }
  },
);

test("descriptor codec checks exact uid/gid/inode before inventory and survives alias replacement", async () => {
  const identity = await codec.readHostWorkspaceRootIdentity(root);
  for (const key of ["uid", "gid", "ino"] as const) {
    await expect(
      codec.captureHostWorkspaceArchive(root, [], {
        ...identity,
        [key]: String(BigInt(identity[key]) + 1n),
      }),
    ).rejects.toThrow("root identity changed");
  }
  const saved = root + "-original";
  renameSync(root, saved);
  mkdirSync(root);
  try {
    await expect(codec.captureHostWorkspaceArchive(root, [], identity)).rejects.toThrow(
      "root identity changed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    renameSync(saved, root);
  }
});

test("teardown vetoes unpublished capture and preserves workspace after published exact removal", async () => {
  const { restored } = await recordedState();
  let published = false;
  const handle = await attachDockerWorkspaceForDrain(
    client as never,
    restored as never,
    async () => ({ archivePublished: published }),
    probe,
  );
  await expect(handle.delete()).rejects.toThrow("not durably published");
  expect(nativeCalls.some((x) => x[0] === "rm")).toBe(false);
  published = true;
  await handle.delete();
  expect(nativeCalls.filter((x) => x[0] === "rm")).toEqual([["rm", "-f", cid]]);
  expect(readFileSync(join(root, "preserved.txt"), "utf8")).toBe("actual retained bytes");
});

test("actual reaper two EDQUOT captures create zero siblings and retain lease/data", async () => {
  const { original, serialized } = await recordedState();
  present = false;
  const lease = {
    id: "lease",
    sandboxGroupId: uuid,
    liveness: "draining",
    refcount: 0,
    leaseEpoch: 1,
    instanceId: cid,
    backend: "docker",
    resumeBackendId: "docker",
    workspaceGeneration: 3,
    archiveComplete: false,
    archiveCapture: {
      id: "capture",
      providerRequestId: uuid,
      workspaceGeneration: 3,
      publishedAt: null,
    },
    resumeState: {
      backendId: "docker",
      opengeniProviderInstanceId: cid,
      sessionState: {
        providerState: { ...original, ...serialized },
        manifest: original.manifest,
      },
    },
  };
  const provider = {
    backendId: "docker",
    async deserializeSessionState(value: Record<string, unknown>) {
      const restored = { ...value, manifest: original.manifest };
      rememberSerializedDockerOwnership(restored as never, value);
      return restored;
    },
    async resume() {
      throw new Error("ordinary SDK resume forbidden");
    },
    async attachWorkspaceForDrain(value: never, fence: typeof captureFence) {
      return await attachDockerWorkspaceForDrain(client as never, value, fence, probe);
    },
  };
  let published = 0;
  let stopped = 0;
  const capture = spyOn(codec, "captureHostWorkspaceArchive").mockImplementation(
    async (path, _, identity) => {
      await codec.readHostWorkspaceRootIdentity(path, identity);
      throw Object.assign(new Error("injected EDQUOT write"), { code: "EDQUOT" });
    },
  );
  const verify = async () =>
    await verifyDockerDrainCaptureFence(
      {} as never,
      {
        accountId: "account",
        workspaceId: "workspace",
        sandboxGroupId: uuid,
        leaseId: "lease",
        leaseEpoch: 1,
        instanceId: cid,
        workspaceGeneration: 3,
        captureId: "capture",
        providerRequestId: uuid,
      },
      {
        readLease: (async () => lease) as never,
        readWorkspaceArchiveCapturePreflight: (async () => ({ workspaceGeneration: 3 })) as never,
      },
    );
  for (let n = 0; n < 2; n++)
    await expect(
      terminateProviderBox(
        testSettings({ sandboxBackend: "docker", sandboxOwnershipEnabled: true }),
        lease as never,
        { info() {}, warn() {} } as never,
        async () => {
          published++;
          return { wrote: true };
        },
        (() => provider) as never,
        undefined,
        uuid,
        "capture_required",
        undefined,
        true,
        undefined,
        "workspace",
        async () => {
          stopped++;
        },
        verify,
      ),
    ).rejects.toThrow("EDQUOT");
  expect(capture).toHaveBeenCalledTimes(2);
  expect(published).toBe(0);
  expect(stopped).toBe(0);
  expect(lease.instanceId).toBe(cid);
  expect(readFileSync(join(root, "preserved.txt"), "utf8")).toBe("actual retained bytes");
  expect(nativeCalls.some((x) => ["run", "exec", "network", "rm"].includes(x[0]!))).toBe(false);
});

test.each(["epoch", "capture", "writer"])(
  "actual pre-read fence rejects %s drift",
  async (kind) => {
    const current = {
      id: "lease",
      liveness: "draining",
      leaseEpoch: kind === "epoch" ? 2 : 1,
      instanceId: cid,
      backend: "docker",
      workspaceGeneration: 3,
      archiveComplete: false,
      archiveCapture: {
        id: kind === "capture" ? "foreign" : "capture",
        providerRequestId: uuid,
        workspaceGeneration: 3,
        publishedAt: null,
      },
    };
    await expect(
      verifyDockerDrainCaptureFence(
        {} as never,
        {
          accountId: "account",
          workspaceId: "workspace",
          sandboxGroupId: uuid,
          leaseId: "lease",
          leaseEpoch: 1,
          instanceId: cid,
          workspaceGeneration: 3,
          captureId: "capture",
          providerRequestId: uuid,
        },
        {
          readLease: (async () => current) as never,
          readWorkspaceArchiveCapturePreflight: (async () =>
            kind === "writer" ? null : { workspaceGeneration: 3 }) as never,
        },
      ),
    ).rejects.toThrow();
  },
);

test.each(["success", "cas_miss", "published"])(
  "actual reaper JSON/fingerprint/publication/teardown lifecycle (%s)",
  async (mode) => {
    const { original, serialized } = await recordedState();
    const lease = {
      id: "lease",
      sandboxGroupId: uuid,
      liveness: "draining",
      refcount: 0,
      leaseEpoch: 1,
      instanceId: cid,
      backend: "docker",
      resumeBackendId: "docker",
      workspaceGeneration: 3,
      archiveComplete: mode === "published",
      archiveCapture: {
        id: "capture",
        providerRequestId: uuid,
        workspaceGeneration: 3,
        publishedAt: mode === "published" ? new Date() : null,
      },
      resumeState: {
        backendId: "docker",
        opengeniProviderInstanceId: cid,
        sessionState: {
          providerState: { ...original, ...serialized },
          manifest: original.manifest,
        },
      },
    };
    const provider = {
      backendId: "docker",
      async deserializeSessionState(value: Record<string, unknown>) {
        const restored = { ...value, manifest: original.manifest };
        rememberSerializedDockerOwnership(restored as never, value);
        return restored;
      },
      async resume() {
        throw new Error("ordinary SDK resume forbidden");
      },
      async attachWorkspaceForDrain(value: never, fence: typeof captureFence) {
        return await attachDockerWorkspaceForDrain(client as never, value, fence, probe);
      },
    };
    let publications = 0;
    let stops = 0;
    const capture = spyOn(codec, "captureHostWorkspaceArchive");
    const fence = async () =>
      await verifyDockerDrainCaptureFence(
        {} as never,
        {
          accountId: "account",
          workspaceId: "workspace",
          sandboxGroupId: uuid,
          leaseId: "lease",
          leaseEpoch: 1,
          instanceId: cid,
          workspaceGeneration: 3,
          captureId: "capture",
          providerRequestId: uuid,
        },
        {
          readLease: (async () => lease) as never,
          readWorkspaceArchiveCapturePreflight: (async () => ({ workspaceGeneration: 3 })) as never,
        },
      );
    const result = await terminateProviderBox(
      testSettings({ sandboxBackend: "docker", sandboxOwnershipEnabled: true }),
      lease as never,
      { info() {}, warn() {} } as never,
      async (archive, metadata) => {
        publications++;
        if (mode === "published") throw new Error("already-published recapture forbidden");
        expect(archive && typeof archive === "object" && archive.kind).toBe("host_spool");
        if (!archive || typeof archive !== "object") throw new Error("wrong archive");
        const chunks: Uint8Array[] = [];
        for await (const chunk of archive.spool.open()) chunks.push(chunk);
        expect(JSON.parse(Buffer.concat(chunks).toString()).files[0].data).toBe(
          Buffer.from("actual retained bytes").toString("base64"),
        );
        expect(metadata?.workspace.fileCount).toBe(1);
        if (mode === "cas_miss") return { wrote: false };
        lease.archiveComplete = true;
        lease.archiveCapture.publishedAt = new Date();
        return { wrote: true };
      },
      (() => provider) as never,
      undefined,
      uuid,
      mode === "published" ? "archive_published" : "capture_required",
      undefined,
      true,
      undefined,
      "workspace",
      async () => {
        stops++;
      },
      fence,
    );
    expect(result.terminated).toBe(mode !== "cas_miss");
    expect(publications).toBe(mode === "published" ? 0 : 1);
    expect(stops).toBe(mode === "cas_miss" ? 0 : 1);
    expect(capture).toHaveBeenCalledTimes(mode === "published" ? 0 : 1);
    expect(nativeCalls.filter((x) => x[0] === "rm")).toHaveLength(mode === "cas_miss" ? 0 : 1);
    expect(nativeCalls.some((x) => ["run", "exec", "network"].includes(x[0]!))).toBe(false);
    expect(readFileSync(join(root, "preserved.txt"), "utf8")).toBe("actual retained bytes");
  },
);

test("protected metadata with wrong producer identity is rejected before observation", async () => {
  const { original, serialized } = await recordedState();
  nativeCalls.length = 0;
  for (const change of [
    { workspaceRootOwned: "true" },
    { containerId: "c".repeat(64) },
    { workspaceRootPath: root + "-foreign" },
    { sessionIdentity: "foreign" },
  ]) {
    expect(() =>
      rememberSerializedDockerOwnership(original as never, {
        ...original,
        ...serialized,
        ...change,
      }),
    ).toThrow("producer state differs");
  }
  expect(nativeCalls).toHaveLength(0);
});

test("live grant mint rejects a root replaced during SDK ownership verification", async () => {
  const original = state();
  rememberOwnedDockerSdkState(original as never);
  const saved = root + "-original";
  const racingClient = {
    async canReusePreservedOwnedSession() {
      renameSync(root, saved);
      mkdirSync(root);
      writeFileSync(join(root, "foreign.txt"), "forbidden");
      return true;
    },
  };
  try {
    await expect(
      serializeDockerOwnership(racingClient as never, original as never, probe),
    ).rejects.toThrow("root identity changed");
    expect(nativeCalls.some((x) => ["run", "exec", "network", "rm"].includes(x[0]!))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    renameSync(saved, root);
  }
});

test.each(["signal", "bad_json", "stderr"])(
  "native %s uncertainty vetoes content capture",
  async (kind) => {
    const { restored } = await recordedState();
    const uncertainProbe = async (args: readonly string[]) => {
      if (args[0] !== "inspect") return await probe(args);
      if (kind === "signal")
        throw Object.assign(new Error("unknown read"), {
          code: 1,
          signal: "SIGTERM",
          killed: true,
          stderr: "Error: No such object: " + cid,
        });
      if (kind === "bad_json") return { stdout: "{", stderr: "" };
      return { ...(await probe(args)), stderr: "unknown diagnostic" };
    };
    const capture = spyOn(codec, "captureHostWorkspaceArchive");
    await expect(
      attachDockerWorkspaceForDrain(
        client as never,
        restored as never,
        captureFence,
        uncertainProbe,
      ),
    ).rejects.toThrow();
    expect(capture).not.toHaveBeenCalled();
  },
);

test("Docker network facade forwards drain without setup, ordinary resume or network allocation", async () => {
  const { dockerProvider } = await import("../src/sandbox/providers/docker");
  const { createSandboxClientForBackend } = await import("../src/sandbox");
  let attached = 0;
  let checked = 0;
  const handle = { captureOnly: true };
  const raw = {
    backendId: "docker",
    async resume() {
      throw new Error("ordinary resume forbidden");
    },
    async resumeExact() {
      throw new Error("normal attach forbidden");
    },
    async attachWorkspaceForDrain(_: unknown, check: typeof captureFence) {
      expect(this).toBe(raw);
      await check();
      attached++;
      return handle;
    },
  };
  const build = spyOn(dockerProvider, "build").mockReturnValue(raw as never);
  const facade = createSandboxClientForBackend(
    "docker",
    testSettings({ sandboxBackend: "docker", dockerNetwork: "never-connect" }),
  ) as unknown as {
    attachWorkspaceForDrain: typeof raw.attachWorkspaceForDrain;
  };
  try {
    expect(
      await facade.attachWorkspaceForDrain({}, async () => {
        checked++;
        return { archivePublished: false };
      }),
    ).toBe(handle);
    expect(attached).toBe(1);
    expect(checked).toBe(1);
    expect(nativeCalls).toHaveLength(0);
  } finally {
    build.mockRestore();
  }
});

test.each([{ maxInputBytes: 1024, maxExtractedBytes: 2048, maxMembers: 16 }, null])(
  "non-Linux borrowed installed SDK persistence retains accepted limits (%s) without restore/create",
  async (archiveLimits) => {
    const { DockerSandboxSession, DockerSandboxClient } =
      await import("@openai/agents/sandbox/local");
    const { restored } = await recordedState();
    present = false;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const installedPersist = DockerSandboxSession.prototype.persistWorkspace;
    let borrowedLimits: unknown;
    const persist = spyOn(DockerSandboxSession.prototype, "persistWorkspace").mockImplementation(
      async function (this: InstanceType<typeof DockerSandboxSession>) {
        borrowedLimits = Reflect.get(this, "archiveLimits");
        return await installedPersist.call(this);
      },
    );
    const create = spyOn(DockerSandboxClient.prototype, "create").mockImplementation(async () => {
      throw new Error("SDK create forbidden");
    });
    const resume = spyOn(DockerSandboxClient.prototype, "resume").mockImplementation(async () => {
      throw new Error("SDK resume/restore forbidden");
    });
    const hydrate = spyOn(DockerSandboxSession.prototype, "hydrateWorkspace").mockImplementation(
      async () => {
        throw new Error("SDK workspace restore forbidden");
      },
    );
    const close = spyOn(DockerSandboxSession.prototype, "close").mockImplementation(async () => {
      throw new Error("SDK workspace deletion forbidden");
    });
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
      const handle = await attachDockerWorkspaceForDrain(
        client as never,
        restored as never,
        captureFence,
        probe,
        archiveLimits,
      );
      const bytes = await handle.persistWorkspace();
      const archive = JSON.parse(Buffer.from(bytes).toString("utf8"));
      expect(archive.version).toBe(1);
      expect(archive.files).toEqual([
        { path: "preserved.txt", data: Buffer.from("actual retained bytes").toString("base64") },
      ]);
      expect(borrowedLimits).toBe(archiveLimits);
      expect(persist).toHaveBeenCalledTimes(1);
      for (const effect of [create, resume, hydrate, close]) expect(effect).not.toHaveBeenCalled();
      expect(nativeCalls.every((x) => ["info", "inspect"].includes(x[0]!))).toBe(true);
      expect(readFileSync(join(root, "preserved.txt"), "utf8")).toBe("actual retained bytes");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  },
);

test("Docker adapter forwards the exact accepted archive override to its restricted attachment", async () => {
  const drain = await import("../src/sandbox/providers/docker-workspace-drain");
  const { dockerProvider } = await import("../src/sandbox/providers/docker");
  const attached = spyOn(drain, "attachDockerWorkspaceForDrain").mockResolvedValue({} as never);
  const adapter = dockerProvider.build({
    settings: testSettings({ sandboxBackend: "docker" }),
    exposedPorts: [],
  }) as unknown as {
    attachWorkspaceForDrain: (
      state: unknown,
      check: typeof captureFence,
      options?: { archiveLimits: { maxMembers: number } | null },
    ) => Promise<unknown>;
  };
  const selected = { maxMembers: 7 };
  try {
    await adapter.attachWorkspaceForDrain({}, captureFence, { archiveLimits: selected });
    expect(attached.mock.calls[0]?.[4]).toBe(selected);
    await adapter.attachWorkspaceForDrain({}, captureFence, { archiveLimits: null });
    expect(attached.mock.calls[1]?.[4]).toBeNull();
  } finally {
    attached.mockRestore();
  }
});
