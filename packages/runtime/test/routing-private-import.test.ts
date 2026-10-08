import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceFileImportRequest } from "@opengeni/contracts";
import {
  RoutingMutationOutcomeUnknownError,
  RoutingSandboxSession,
  SandboxChannelAService,
  SynchronousCommandOutcomeUnknownError,
  type ActivePointer,
  type RoutableBackendSession,
} from "../src/sandbox";
import type { SynchronousCommandPage } from "../src/sandbox/synchronous-command";
import { synchronousNativeOutputFixture } from "./synchronous-output-fixture";

const csv = Buffer.from('record,total\r\n"Generated ""entry"" ø",9.75\r\n', "utf8");
const sha256 = createHash("sha256").update(csv).digest("hex");
type ExecSurface = "exec" | "execCommand";

function request(filename: string): WorkspaceFileImportRequest {
  return {
    operationId: randomUUID(),
    destinationPath: filename,
    overwrite: false,
    mayReplaceExisting: false,
    sizeBytes: csv.length,
    sha256,
    source: {
      url: `https://files.example.test/${filename}?signature=synthetic-authority`,
      expiresAt: "2030-01-02T03:04:05.000Z",
    },
  };
}

/** A provider with exec/stdin and class-private state, but no filesystem writer. */
class StreamingBackend implements RoutableBackendSession {
  readonly commands: Array<{ cmd: string; runAs?: string }> = [];
  readonly staged: Array<{ path: string; content: string }> = [];
  readonly cleaned: string[] = [];
  #transfers = new Map<number, string>();
  #configs = new Map<string, string>();
  #files = new Map<string, Buffer>();
  #pages = new Map<unknown, SynchronousCommandPage>();
  #transferOutputs = new Map<number, ReturnType<typeof synchronousNativeOutputFixture>>();

  constructor(
    private readonly requests: readonly WorkspaceFileImportRequest[],
    private readonly onStdin: () => void = () => {},
    private readonly surface: ExecSurface = "exec",
  ) {}

  content(path: string): Buffer | undefined {
    return this.#files.get(path);
  }

  getSynchronousCommandOutput(raw: unknown): SynchronousCommandPage | null {
    return this.#pages.get(raw) ?? null;
  }

  private output<T>(
    raw: T,
    stdout: string,
    exitCode: number | null,
    providerSessionId?: number,
  ): T {
    const outputFixture =
      (providerSessionId === undefined
        ? undefined
        : this.#transferOutputs.get(providerSessionId)) ?? synchronousNativeOutputFixture();
    if (providerSessionId !== undefined)
      this.#transferOutputs.set(providerSessionId, outputFixture);
    outputFixture.record(
      raw,
      stdout,
      "",
      exitCode,
      exitCode === null ? providerSessionId : undefined,
    );
    this.#pages.set(raw, outputFixture.getSynchronousCommandOutput(raw)!);
    return raw;
  }

  get exec(): RoutableBackendSession["exec"] {
    return this.surface === "exec" ? this.execute : undefined;
  }

  get execCommand(): RoutableBackendSession["execCommand"] {
    return this.surface === "execCommand" ? this.executeCommand : undefined;
  }

  private async executeCommand(args: unknown): Promise<string> {
    const result = (await this.execute(args)) as {
      stdout?: string;
      exitCode?: number;
      sessionId?: number;
    };
    const raw =
      `Chunk ID: ${randomUUID()}\n` +
      (result.sessionId === undefined
        ? `Process exited with code ${result.exitCode}\n\nOutput:\n${result.stdout ?? ""}`
        : `Process running with session ID ${result.sessionId}\n\nOutput:\n`);
    // This alias preserves the same raw page, not a second cursor advancement.
    this.#pages.set(raw, this.#pages.get(result)!);
    return raw;
  }

  private async execute(args: unknown): Promise<unknown> {
    const input = args as { cmd: string; runAs?: string };
    this.commands.push(input);
    if (input.cmd.includes("__OPENGENI_FS_CONFINED_OK__")) {
      return this.output(
        { stdout: "__OPENGENI_FS_CONFINED_OK__", stderr: "", exitCode: 0 },
        "__OPENGENI_FS_CONFINED_OK__",
        0,
      );
    }
    if (input.cmd.includes("__OPENGENI_PLACEMENT_PRIVATE_WRITE_OK__")) {
      const path = input.cmd.match(/> '([^']+)'/u)?.[1];
      if (!path) throw new Error("expected private transfer path");
      const sessionId = this.staged.length + 41;
      this.#transfers.set(sessionId, path);
      return this.output({ sessionId }, "", null, sessionId);
    }
    if (input.cmd.startsWith("rm -f ")) {
      const path = input.cmd.match(/^rm -f '([^']+)'$/u)?.[1];
      if (!path) throw new Error("expected private cleanup path");
      // rm -f also succeeds when staging never created the file.
      if (this.#configs.delete(path)) this.cleaned.push(path);
      return this.output({ stdout: "", stderr: "", exitCode: 0 }, "", 0);
    }
    const marker = input.cmd.match(/__OPENGENI_WORKSPACE_IMPORT_[0-9a-f]+_OK__/u)?.[0];
    const source = this.requests.find((item) => input.cmd.includes(item.destinationPath));
    const config = [...this.#configs].find(([path]) => input.cmd.includes(path))?.[1];
    if (!marker || !source || !config) throw new Error("expected staged workspace import");
    expect(config).toContain(source.source.url);
    expect(input.cmd).toContain(source.sha256);
    expect(input.cmd).toContain(String(source.sizeBytes));
    const replayed = this.#files.has(source.destinationPath);
    if (!replayed) this.#files.set(source.destinationPath, Buffer.from(csv));
    const stdout = `${marker}\t${replayed ? "replayed" : "created"}`;
    return this.output({ stdout, stderr: "", exitCode: 0 }, stdout, 0);
  }

  async writeStdin(args: unknown): Promise<string> {
    const input = args as { sessionId: number; chars: string };
    const path = this.#transfers.get(input.sessionId);
    if (!path) throw new Error("private transfer session not found");
    const content = Buffer.from(input.chars, "base64").toString("utf8");
    this.#configs.set(path, content);
    this.staged.push({ path, content });
    this.onStdin();
    return this.output(
      `Chunk ID: ${randomUUID()}\nProcess exited with code 0\n\nOutput:\n__OPENGENI_PLACEMENT_PRIVATE_WRITE_OK__`,
      "__OPENGENI_PLACEMENT_PRIVATE_WRITE_OK__",
      0,
      input.sessionId,
    );
  }
}

function fixture(
  requests: readonly WorkspaceFileImportRequest[],
  swapOnStdin: boolean,
  surface: ExecSurface,
) {
  let pointer: ActivePointer = { activeSandboxId: null, activeEpoch: 0 };
  let resolutions = 0;
  const events: string[] = [];
  const backend = new StreamingBackend(
    requests,
    () => {
      if (swapOnStdin) pointer = { activeSandboxId: "replacement", activeEpoch: 1 };
    },
    surface,
  );
  const routing = new RoutingSandboxSession({
    readPointer: async () => ({ ...pointer }),
    resolveActiveBackend: async (active) => {
      resolutions += 1;
      if (active.activeSandboxId !== null) throw new Error("must not replay on replacement");
      return { session: backend, sandboxId: null, kind: "modal" };
    },
    beforeMutation: async ({ op }) => {
      events.push(`admitted:${op}`);
      return "fixture-admission";
    },
    afterMutation: async ({ outcome }) => {
      events.push(`settled:${outcome}`);
    },
  });
  const channel = new SandboxChannelAService({
    session: routing,
    workspaceRoot: "/workspace",
    runAs: "fixture-user",
    emit: async (batch) => {
      expect(JSON.stringify(batch)).not.toContain("synthetic-authority");
      events.push("fs:emitted");
    },
  });
  return { backend, channel, events, resolutions: () => resolutions };
}

function expectPrivateAuthority(backend: StreamingBackend) {
  expect(backend.cleaned).toEqual(backend.staged.map((item) => item.path));
  for (const staged of backend.staged) {
    expect(staged.path).toStartWith("/tmp/opengeni-private/workspace-imports/");
    for (const { cmd } of backend.commands) {
      expect(cmd).not.toContain("synthetic-authority");
      expect(cmd).not.toContain(Buffer.from(staged.content).toString("base64"));
    }
  }
  const transfers = backend.commands.filter(({ cmd }) =>
    cmd.includes("__OPENGENI_PLACEMENT_PRIVATE_WRITE_OK__"),
  );
  for (const { cmd } of transfers) {
    expect(cmd).toContain("install -d -m 0700");
    expect(cmd).toContain("chmod 0600");
    expect(cmd).not.toContain("/workspace/");
  }
  expect(backend.commands.every((item) => item.runAs === "fixture-user")).toBe(true);
}

describe.each(["exec", "execCommand"] as const)(
  "routed workspace imports without a provider file API (%s)",
  (surface) => {
    test.each(["single", "batch"] as const)(
      "%s import retains stdin staging and cleanup under one admission",
      async (kind) => {
        const requests = [request("generated-one.csv"), request("generated-two.csv")].slice(
          0,
          kind === "single" ? 1 : 2,
        );
        const { backend, channel, events, resolutions } = fixture(requests, false, surface);
        expect(surface === "exec" ? backend.execCommand : backend.exec).toBeUndefined();
        const receipts =
          kind === "single"
            ? [await channel.importWorkspaceFile(requests[0]!)]
            : await channel.importWorkspaceFiles(requests);
        expect(receipts.map((item) => item.destinationPath)).toEqual(
          requests.map((item) => item.destinationPath),
        );
        expect(receipts.map((item) => item.revision)).toEqual(kind === "single" ? [1] : [1, 2]);
        for (const item of requests) {
          expect(backend.content(item.destinationPath)).toEqual(csv);
        }
        expect(resolutions()).toBe(1);
        expect(events).toEqual([
          `admitted:${kind === "single" ? "importWorkspaceFile" : "importWorkspaceFiles"}`,
          "settled:resolved",
          "fs:emitted",
        ]);
        expectPrivateAuthority(backend);
      },
    );

    test.each(["single", "batch"] as const)(
      "%s import cleans on the original provider after a pointer move",
      async (kind) => {
        const requests = [request("generated-one.csv"), request("generated-two.csv")].slice(
          0,
          kind === "single" ? 1 : 2,
        );
        const { backend, channel, events, resolutions } = fixture(requests, true, surface);
        const operation =
          kind === "single"
            ? channel.importWorkspaceFile(requests[0]!)
            : channel.importWorkspaceFiles(requests);
        await expect(operation).rejects.toBeInstanceOf(RoutingMutationOutcomeUnknownError);
        expect(backend.staged).toHaveLength(requests.length);
        expect(resolutions()).toBe(1);
        expect(events).toEqual([
          `admitted:${kind === "single" ? "importWorkspaceFile" : "importWorkspaceFiles"}`,
          "settled:resolved",
        ]);
        expectPrivateAuthority(backend);
      },
    );

    test("exact replay retains revision and emits no duplicate workspace mutation", async () => {
      const source = request("generated.csv");
      const { backend, channel, events } = fixture([source], false, surface);
      const first = await channel.importWorkspaceFile(source);
      const replay = await channel.importWorkspaceFile(source);
      expect(first.replayed).toBe(false);
      expect(replay).toMatchObject({ ...first, replayed: true });
      expect(channel.currentRevision()).toBe(1);
      expect(events.filter((event) => event === "fs:emitted")).toHaveLength(1);
      expectPrivateAuthority(backend);
    });
  },
);

test("presentation-only receipts cannot authorize private staging or replay confinement", async () => {
  const source = request("untrusted.csv");
  const { backend, channel } = fixture([source], false, "execCommand");
  backend.getSynchronousCommandOutput = () => null;
  await expect(channel.importWorkspaceFile(source)).rejects.toBeInstanceOf(
    SynchronousCommandOutcomeUnknownError,
  );
  expect(backend.commands).toHaveLength(1);
  expect(backend.staged).toEqual([]);
  expect(backend.cleaned).toEqual([]);
});
