import { describe, expect, test } from "bun:test";
import { shell } from "@openai/agents/sandbox";
import {
  SandboxApiException,
  type AdapterFactory,
  type CreateSandboxRequest,
  type Endpoint,
} from "@alibaba-group/opensandbox";
import {
  Manifest,
  SandboxArchiveError,
  SandboxUnsupportedFeatureError,
} from "@openai/agents/sandbox";
import {
  OpenSandboxClient,
  SandboxConfigError,
  SandboxExactResumeInstanceUnavailableError,
  runWithToolCallCorrelation,
} from "../src/sandbox";
import { archiveRestoreScript } from "../src/sandbox/providers/opensandbox-adapter";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { chmod, chown, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMAGE = `registry.example.com/opengeni@sha256:${"a".repeat(64)}`;

type FakeFile = { type: "file" | "directory"; data?: Uint8Array };

class FakeOpenSandbox {
  readonly calls: string[] = [];
  readonly files = new Map<string, FakeFile>();
  readonly interrupted: string[] = [];
  createdRequest: CreateSandboxRequest | null = null;
  sandboxExists = true;
  commandGate: Promise<void> | null = null;
  resolveCommand: (() => void) | null = null;
  commandFailureAfterInit: Error | null = null;
  commandStatus = { running: false, exitCode: 0, content: "" };
  lifecycleRequestTimeoutSeconds: number | null = null;
  reportedImage = IMAGE;
  reportedExtensions: Record<string, string> = {};

  readonly adapterFactory: AdapterFactory;

  constructor() {
    const self = this;
    const lifecycle = {
      async createSandbox(request: CreateSandboxRequest) {
        self.calls.push("createSandbox");
        self.createdRequest = request;
        self.sandboxExists = true;
        return self.created();
      },
      async getSandbox(id: string) {
        self.calls.push(`getSandbox:${id}`);
        if (!self.sandboxExists) throw self.notFound();
        return self.info(id);
      },
      async listSandboxes() {
        return { items: self.sandboxExists ? [self.info("sbx-1")] : [] };
      },
      async patchSandboxMetadata(id: string) {
        return self.info(id);
      },
      async deleteSandbox(id: string) {
        self.calls.push(`deleteSandbox:${id}`);
        if (!self.sandboxExists) throw self.notFound();
        self.sandboxExists = false;
      },
      async pauseSandbox() {},
      async resumeSandbox() {},
      async renewSandboxExpiration(id: string, request: { expiresAt: string }) {
        self.calls.push(`renewSandboxExpiration:${id}`);
        return { expiresAt: new Date(request.expiresAt) };
      },
      async createSnapshot() {
        throw new Error("not used");
      },
      async getSnapshot() {
        throw new Error("not used");
      },
      async listSnapshots() {
        return { items: [] };
      },
      async deleteSnapshot() {},
      async getSandboxEndpoint(id: string, port: number): Promise<Endpoint> {
        self.calls.push(`getSandboxEndpoint:${id}:${port}`);
        if (!self.sandboxExists) throw self.notFound();
        return {
          endpoint: `proxy.example.test/sandboxes/${id}/${port}`,
          headers: { "x-open-sandbox-route": id },
        };
      },
      async getSignedEndpoint(id: string, port: number) {
        return await this.getSandboxEndpoint(id, port);
      },
      invalidateEndpointCache() {},
    };
    const commands = {
      async run(_command: string, _options: unknown, handlers: any) {
        self.calls.push("command:run");
        await handlers?.onInit?.({ id: "exec-1", timestamp: Date.now() });
        await handlers?.onStdout?.({ text: "out", timestamp: Date.now() });
        await handlers?.onStderr?.({
          text: "err",
          timestamp: Date.now(),
          isError: true,
        });
        if (self.commandFailureAfterInit) throw self.commandFailureAfterInit;
        if (self.commandGate) await self.commandGate;
        return {
          id: "exec-1",
          logs: { stdout: [], stderr: [] },
          result: [],
          complete: { timestamp: Date.now(), executionTimeMs: 1 },
          exitCode: 0,
        };
      },
      async *runStream() {},
      async interrupt(id: string) {
        self.calls.push(`command:interrupt:${id}`);
        self.interrupted.push(id);
        self.resolveCommand?.();
      },
      async getCommandStatus(id: string) {
        self.calls.push(`command:status:${id}`);
        return { id, ...self.commandStatus };
      },
      async getBackgroundCommandLogs() {
        return { content: "" };
      },
      async createSession() {
        return "session";
      },
      async runInSession() {
        throw new Error("not used");
      },
      async deleteSession() {},
    };
    const files = {
      async getFileInfo(paths: string[]) {
        return Object.fromEntries(
          paths.flatMap((path) => {
            const value = self.files.get(path);
            return value
              ? [
                  [
                    path,
                    {
                      path,
                      type: value.type,
                      size: value.data?.byteLength ?? 0,
                    },
                  ],
                ]
              : [];
          }),
        );
      },
      async search() {
        return [];
      },
      async listDirectory({ path }: { path: string }) {
        const prefix = path.endsWith("/") ? path : `${path}/`;
        return [...self.files.entries()]
          .filter(
            ([candidate]) =>
              candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"),
          )
          .map(([candidate, value]) => ({ path: candidate, type: value.type }));
      },
      async createDirectories(entries: Array<{ path: string }>) {
        for (const entry of entries) self.files.set(entry.path, { type: "directory" });
      },
      async deleteDirectories(paths: string[]) {
        for (const path of paths) {
          for (const candidate of [...self.files.keys()]) {
            if (candidate === path || candidate.startsWith(`${path}/`))
              self.files.delete(candidate);
          }
        }
      },
      async writeFiles(
        entries: Array<{
          path: string;
          data?: string | Uint8Array | ArrayBuffer;
        }>,
      ) {
        for (const entry of entries) {
          const data =
            typeof entry.data === "string"
              ? new TextEncoder().encode(entry.data)
              : entry.data instanceof Uint8Array
                ? Uint8Array.from(entry.data)
                : entry.data instanceof ArrayBuffer
                  ? new Uint8Array(entry.data)
                  : new Uint8Array();
          self.files.set(entry.path, { type: "file", data });
        }
      },
      async readFile(path: string) {
        return new TextDecoder().decode(self.files.get(path)?.data ?? new Uint8Array());
      },
      async readBytes(path: string, options?: { limit?: number }) {
        const bytes = self.files.get(path)?.data ?? new Uint8Array();
        return options?.limit === undefined
          ? Uint8Array.from(bytes)
          : bytes.slice(0, options.limit);
      },
      async *readBytesStream(path: string) {
        yield await this.readBytes(path);
      },
      async deleteFiles(paths: string[]) {
        for (const path of paths) self.files.delete(path);
      },
      async moveFiles(entries: Array<{ src: string; dest: string }>) {
        for (const entry of entries) {
          const value = self.files.get(entry.src);
          if (value) self.files.set(entry.dest, value);
          self.files.delete(entry.src);
        }
      },
      async replaceContents() {},
      async replaceContentsDetailed() {
        return [];
      },
      async setPermissions() {},
    };
    this.adapterFactory = {
      createLifecycleStack({ connectionConfig }) {
        self.lifecycleRequestTimeoutSeconds = connectionConfig.requestTimeoutSeconds;
        return { sandboxes: lifecycle as any };
      },
      createExecdStack() {
        return {
          commands: commands as any,
          files: files as any,
          health: {
            async ping() {
              self.calls.push("health:ping");
              return true;
            },
          },
          metrics: {
            async getMetrics() {
              return {};
            },
          } as any,
          isolation: {} as any,
        };
      },
      createEgressStack() {
        return {
          egress: {
            async getPolicy() {
              return {};
            },
            async patchRules() {},
            async deleteRules() {},
          } as any,
          credentialVault: {} as any,
        };
      },
    };
  }

  holdCommand(): void {
    this.commandGate = new Promise<void>((resolve) => {
      this.resolveCommand = resolve;
    });
  }

  private created() {
    return {
      id: "sbx-1",
      status: { state: "Creating" },
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      entrypoint: ["tail", "-f", "/dev/null"],
    };
  }

  private info(id: string) {
    return {
      id,
      image: { uri: this.reportedImage },
      entrypoint: ["tail", "-f", "/dev/null"],
      metadata: {},
      extensions: this.reportedExtensions,
      status: { state: "Running" },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
  }

  private notFound(): SandboxApiException {
    return new SandboxApiException({ message: "missing", statusCode: 404 });
  }
}

function createClient(
  fake: FakeOpenSandbox,
  options: { poolRef?: string } = {},
): OpenSandboxClient {
  return new OpenSandboxClient({
    baseUrl: "https://opensandbox.example.test",
    apiKey: "secret-test-key",
    image: IMAGE,
    ttlSeconds: 60,
    useServerProxy: true,
    readyTimeoutSeconds: 2,
    resourceLimits: { cpu: "1", memory: "1Gi" },
    resourceRequests: { cpu: "250m", memory: "512Mi" },
    environment: { BASE: "base" },
    ...(options.poolRef ? { poolRef: options.poolRef } : {}),
    adapterFactory: fake.adapterFactory,
  });
}

describe("OpenSandbox adapter", () => {
  test("create returns the accepted ID before endpoint, health, or manifest work", async () => {
    const fake = new FakeOpenSandbox();
    const client = createClient(fake);
    const session = await client.create({
      manifest: new Manifest({
        environment: { TURN: "turn" },
        entries: { "hello.txt": { type: "file", content: "hello" } },
      }),
    });

    expect(session.state).toMatchObject({
      sandboxId: "sbx-1",
      image: IMAGE,
      workspaceReady: false,
      environment: { BASE: "base", TURN: "turn" },
    });
    expect(fake.calls).toEqual(["createSandbox"]);
    expect(fake.lifecycleRequestTimeoutSeconds).toBe(2);
    expect(fake.createdRequest).toMatchObject({
      image: { uri: IMAGE },
      timeout: 60,
      resourceLimits: { cpu: "1", memory: "1Gi" },
      resourceRequests: { cpu: "250m", memory: "512Mi" },
      env: { BASE: "base", TURN: "turn" },
    });

    await session.start();
    expect(session.state.workspaceReady).toBe(true);
    expect(fake.files.get("/workspace")).toEqual({ type: "directory" });
    expect(new TextDecoder().decode(fake.files.get("/workspace/hello.txt")?.data)).toBe("hello");
    expect(fake.calls.indexOf("health:ping")).toBeGreaterThan(fake.calls.indexOf("createSandbox"));
  });

  test("empty manifests still establish the declared workspace root", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();

    await session.start();

    expect(session.state.workspaceReady).toBe(true);
    expect(fake.files.get("/workspace")).toEqual({ type: "directory" });
  });

  test("delete works before start and never resolves endpoints", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();
    await session.delete();
    expect(fake.calls).toEqual(["createSandbox", "deleteSandbox:sbx-1"]);
  });

  test("exact resume verifies the persisted ID and missing never creates", async () => {
    const fake = new FakeOpenSandbox();
    const client = createClient(fake);
    const created = await client.create();
    const serialized = await client.serializeSessionState(created.state);
    const state = await client.deserializeSessionState(serialized);

    const resumed = await client.resumeExact(state);
    expect(resumed.state).toBe(state);
    expect(fake.calls.filter((call) => call === "createSandbox")).toHaveLength(1);

    fake.sandboxExists = false;
    await expect(client.resumeExact(state)).rejects.toBeInstanceOf(
      SandboxExactResumeInstanceUnavailableError,
    );
    expect(fake.calls.filter((call) => call === "createSandbox")).toHaveLength(1);
  });

  test("direct exact resume rejects a concrete provider image mismatch", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();
    fake.reportedImage = `registry.example.com/opengeni@sha256:${"b".repeat(64)}`;

    await expect(session.start()).rejects.toThrow(/image changed for the persisted sandbox/);
  });

  test("pool exact resume accepts opaque lifecycle image and missing pool evidence", async () => {
    const fake = new FakeOpenSandbox();
    fake.reportedImage = "unknown";
    const session = await createClient(fake, { poolRef: "warm-pool" }).create();

    expect(fake.createdRequest).toMatchObject({
      extensions: { poolRef: "warm-pool" },
    });
    expect(fake.createdRequest).not.toHaveProperty("image");
    await session.start();
    expect(session.state.workspaceReady).toBe(true);
  });

  test("pool exact resume rejects explicit conflicting provider evidence", async () => {
    const fake = new FakeOpenSandbox();
    fake.reportedImage = "unknown";
    fake.reportedExtensions = { poolRef: "other-pool" };
    const session = await createClient(fake, { poolRef: "warm-pool" }).create();

    await expect(session.start()).rejects.toThrow(/pool changed for the persisted sandbox/);
  });

  test("direct exact resume rejects explicit provider pool evidence", async () => {
    const fake = new FakeOpenSandbox();
    fake.reportedExtensions = { poolRef: "unexpected-pool" };
    const session = await createClient(fake).create();

    await expect(session.start()).rejects.toThrow(/pool changed for the persisted sandbox/);
  });

  test("state codec rejects another provider binding or image", async () => {
    const fake = new FakeOpenSandbox();
    const client = createClient(fake);
    const created = await client.create();
    const serialized = await client.serializeSessionState(created.state);
    await expect(
      new OpenSandboxClient({
        baseUrl: "https://other.example.test",
        apiKey: "other",
        image: IMAGE,
        ttlSeconds: 60,
        useServerProxy: true,
        readyTimeoutSeconds: 2,
        resourceLimits: { cpu: "1" },
        resourceRequests: { cpu: "250m" },
        adapterFactory: fake.adapterFactory,
      }).deserializeSessionState(serialized),
    ).rejects.toBeInstanceOf(SandboxConfigError);
  });

  test("foreground command preserves ordered output and retained Ctrl-C interrupts exact execution", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();
    const foreground = await session.exec({
      cmd: "printf test",
      yieldTimeMs: 100,
    });
    expect(foreground).toMatchObject({
      output: "outerr",
      stdout: "out",
      stderr: "err",
      exitCode: 0,
    });

    fake.holdCommand();
    const retained = await runWithToolCallCorrelation("tool-call", () =>
      session.exec({ cmd: "sleep 30", yieldTimeMs: 0 }),
    );
    expect(retained.sessionId).toBeNumber();
    expect(session.hasRetainedProcess(retained.sessionId!)).toBe(true);
    expect(await session.cancelExecCommand("tool-call:0")).toBe(true);
    expect(fake.interrupted).toEqual(["exec-1"]);
    const settled = await session.writeStdin({
      sessionId: retained.sessionId!,
      yieldTimeMs: 100,
    });
    expect(settled).toContain("Process exited with code 0");
    expect(session.hasRetainedProcess(retained.sessionId!)).toBe(false);
  });

  test("does not expose interactive write_stdin while retaining internal poll and interrupt control", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();
    const tools = shell()
      .clone()
      .bind(session as never)
      .tools();

    expect(session.supportsPty()).toBe(false);
    expect(tools.map((tool) => tool.name)).toContain("exec_command");
    expect(tools.map((tool) => tool.name)).not.toContain("write_stdin");
    expect(typeof session.writeStdinForProcessControl).toBe("function");
  });

  test("post-dispatch transport loss polls status without exposing provider command content", async () => {
    const fake = new FakeOpenSandbox();
    fake.commandFailureAfterInit = new Error("synthetic transport loss");
    fake.commandStatus = {
      running: true,
      exitCode: 0,
      content: "long-task",
    };
    const session = await createClient(fake).create();

    const retained = await runWithToolCallCorrelation("tool-call", () =>
      session.exec({ cmd: "long-task", yieldTimeMs: 100 }),
    );
    expect(retained.output).toBe("outerrsynthetic transport loss\n");
    expect(retained.sessionId).toBeNumber();
    const sessionId = retained.sessionId!;
    expect(retained.exitCode).toBeUndefined();
    expect(fake.calls.filter((call) => call === "command:run")).toHaveLength(1);

    const running = await session.writeStdin({ sessionId, yieldTimeMs: 1 });
    expect(running).not.toContain("long-task");
    expect(running).toContain(`Process running with session ID ${sessionId}`);

    fake.commandStatus = {
      running: false,
      exitCode: 17,
      content: "long-task",
      error: "provider command failed",
    };
    const settled = await session.writeStdin({ sessionId, yieldTimeMs: 1 });
    expect(settled).not.toContain("long-task");
    expect(settled).toContain("provider command failed");
    expect(settled).toContain("Process exited with code 17");
    expect(session.hasRetainedProcess(sessionId)).toBe(false);
    expect(fake.calls.filter((call) => call === "command:run")).toHaveLength(1);
  });

  test("files and ports stay inside the declared workspace/private roots", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();
    await session.writeFile({ path: "dir/value.txt", content: "value" });
    expect(
      new TextDecoder().decode(await session.readFile({ path: "/workspace/dir/value.txt" })),
    ).toBe("value");
    expect(await session.pathExists("dir/value.txt")).toBe(true);
    expect(await session.listDir({ path: "dir" })).toEqual([
      { name: "value.txt", path: "dir/value.txt", type: "file" },
    ]);
    await expect(session.readFile({ path: "/etc/passwd" })).rejects.toThrow(/must stay within/);
    await expect(session.exec({ cmd: "id", runAs: "root" })).rejects.toBeInstanceOf(
      SandboxUnsupportedFeatureError,
    );

    const endpoint = await session.resolveExposedPort(8080);
    expect(endpoint).toMatchObject({
      host: "proxy.example.test",
      port: 443,
      tls: true,
      path: "/sandboxes/sbx-1/8080",
      headers: { "x-open-sandbox-route": "sbx-1" },
    });
  });

  test("archive input bound rejects bytes before upload or command execution", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create({
      archiveLimits: { maxInputBytes: 3 },
    });
    await expect(session.hydrateWorkspace(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(
      SandboxArchiveError,
    );
    expect(fake.calls).toEqual(["createSandbox"]);
  });

  test("archive restore keeps cleanup paths until its internal command is terminal", async () => {
    const fake = new FakeOpenSandbox();
    fake.holdCommand();
    const session = await createClient(fake).create();
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, timeout?: number) =>
      originalSetTimeout(handler, timeout === 120_000 ? 0 : timeout)) as typeof setTimeout;
    let settled = false;
    let failure: unknown;

    try {
      const hydration = session.hydrateWorkspace(new Uint8Array([1, 2, 3])).then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          failure = error;
        },
      );
      await Bun.sleep(20);

      expect(fake.calls).toContain("command:run");
      expect(settled).toBe(false);
      expect(
        [...fake.files.keys()].filter((path) => path.startsWith("/tmp/opengeni-private/restore-")),
      ).toHaveLength(1);

      fake.resolveCommand?.();
      await hydration;

      expect(failure).toBeUndefined();
      expect(settled).toBe(true);
      expect(
        [...fake.files.keys()].filter((path) => path.startsWith("/tmp/opengeni-private/restore-")),
      ).toHaveLength(0);
    } finally {
      fake.resolveCommand?.();
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("archive restore polls an exact uncertain execution before cleanup", async () => {
    const fake = new FakeOpenSandbox();
    fake.commandFailureAfterInit = new Error("synthetic restore transport loss");
    fake.commandStatus = {
      running: false,
      exitCode: 17,
      content: "provider command content must stay private",
      error: "provider restore failed",
    };
    const session = await createClient(fake).create();

    await expect(session.hydrateWorkspace(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(
      SandboxArchiveError,
    );

    expect(fake.calls.filter((call) => call === "command:run")).toHaveLength(1);
    expect(fake.calls.filter((call) => call === "command:status:exec-1")).toHaveLength(1);
    expect(
      [...fake.files.keys()].filter((path) => path.startsWith("/tmp/opengeni-private/restore-")),
    ).toHaveLength(0);
  });

  test("archive restore replaces a non-root workspace without writing its parent", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "opengeni-osb-restore-"));
    const readonlyParent = join(temporary, "readonly-parent");
    const workspace = join(readonlyParent, "workspace");
    const source = join(temporary, "source");
    const archive = join(temporary, "workspace.tar");
    const staging = join(workspace, ".opengeni-restore-test");
    const backup = join(workspace, ".opengeni-old-test");
    const runningAsRoot = process.getuid?.() === 0;
    const targetUid = runningAsRoot ? 65_534 : process.getuid?.();
    const targetGid = runningAsRoot ? 65_534 : process.getgid?.();

    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(source, { recursive: true });
      await writeFile(join(workspace, "old.txt"), "old");
      await writeFile(join(source, "new.txt"), "new");
      const packed = spawnSync("tar", ["-cf", archive, "-C", source, "."], {
        encoding: "utf8",
      });
      expect(packed.status).toBe(0);

      if (runningAsRoot) {
        await chown(workspace, targetUid!, targetGid!);
      }
      await chmod(temporary, 0o555);
      await chmod(readonlyParent, 0o555);
      await chmod(workspace, 0o755);
      await chmod(archive, 0o444);

      const options: SpawnSyncOptions = { encoding: "utf8" };
      if (runningAsRoot) {
        options.uid = targetUid;
        options.gid = targetGid;
      }
      const restored = spawnSync(
        "python3",
        ["-c", archiveRestoreScript(), archive, workspace, staging, backup, "-1", "-1", ""],
        options,
      );

      expect(restored.status, restored.stderr?.toString()).toBe(0);
      expect(await readFile(join(workspace, "new.txt"), "utf8")).toBe("new");
      await expect(readFile(join(workspace, "old.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(staging, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(backup, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await chmod(temporary, 0o755).catch(() => undefined);
      await chmod(readonlyParent, 0o755).catch(() => undefined);
      await chmod(workspace, 0o755).catch(() => undefined);
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
