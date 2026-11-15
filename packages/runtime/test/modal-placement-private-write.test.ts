import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { Manifest } from "@openai/agents/sandbox";
import { UnixLocalSandboxClient } from "@openai/agents/sandbox/local";
import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import { SandboxChannelAService, type ChannelASession } from "../src/sandbox/channel-a";
import { installOpenGeniModalSnapshotPolicy } from "../src/sandbox/providers/modal";
import {
  installModalCommandSession,
  type installModalCommandSession as InstallModalCommandSession,
} from "../src/sandbox/providers/modal-command-session";
import {
  RoutingSandboxSession,
  type RoutingRetainedProcess,
} from "../src/sandbox/routing/routing-session";

type Control = Parameters<typeof InstallModalCommandSession>[1];

const MARKER = "__OPENGENI_PLACEMENT_PRIVATE_WRITE_OK__";

/** One native Modal process. The placement-private transfer reads its declared
 * base64 byte count from stdin, decodes it, then prints its marker; any other
 * internal command (cleanup) exits at once. */
function nativeProcess(command: string[], staged: Map<string, string>) {
  const script = command.join(" ");
  const transfer = script.match(/dd bs=1 count=(\d+) .*> '([^']+)'/u);
  let received = "";
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  if (!transfer) finish();
  return {
    stdin: {
      writeText: async (text: string) => {
        received += text;
        if (transfer && received.length >= Number(transfer[1])) {
          staged.set(transfer[2]!, Buffer.from(received, "base64").toString());
          finish();
        }
      },
      close: async () => {},
    },
    stdout: new ReadableStream<string>({
      start(controller) {
        void done.then(() => {
          if (transfer) controller.enqueue(MARKER);
          controller.close();
        });
      },
    }),
    stderr: new ReadableStream<string>({
      start(controller) {
        void done.then(() => controller.close());
      },
    }),
    wait: async () => {
      await done;
      return 0;
    },
  };
}

/** The pinned Modal SDK session with Opengeni's production Modal policy. It
 * has no native private-file write, so staging streams over the SDK's stdin. */
function modalSession(control: Control) {
  const staged = new Map<string, string>();
  const nativeCommands: string[] = [];
  const sdk = installOpenGeniModalSnapshotPolicy(
    new ModalSandboxSession({
      state: {
        sandboxId: "sb-private",
        manifest: new Manifest({ root: "/workspace" }),
        environment: {},
        workspacePersistence: "tar",
      },
      ownsSandbox: false,
      sandbox: {
        terminate: async () => 0,
        poll: async () => 0,
        exec: async (command: string[]) => {
          nativeCommands.push(command.join(" "));
          return nativeProcess(command, staged);
        },
      },
      modal: { version: () => "0.9.0" },
      app: {},
    } as never),
  ) as ChannelASession & { close(): Promise<void> };
  expect(sdk.writePlacementPrivate).toBeUndefined();
  expect(sdk.writeFile).toBeUndefined();
  // Production installs this inside installOpenGeniModalSnapshotPolicy when
  // the SDK profile is authenticated; this fixture has none, so it installs
  // the same command session afterwards with a fake router control.
  installModalCommandSession(sdk, control);
  return { sdk, staged, nativeCommands };
}

const forbidden = async () => {
  throw new Error("unexpected retained Modal command control");
};

test("a Modal sandbox stages a placement-private file through the routing session", async () => {
  const { sdk, staged, nativeCommands } = modalSession({
    start: forbidden,
    read: forbidden,
    readProbe: forbidden,
    write: forbidden,
  });
  const backend = { session: sdk, sandboxId: "sb-private", kind: "modal", activeEpoch: 0 };
  const route = new RoutingSandboxSession({
    defaultResolved: backend,
    readPointer: async () => ({ activeSandboxId: "sb-private", activeEpoch: 0 }),
    resolveActiveBackend: async () => backend,
    beforeMutation: async () => {
      throw new Error("placement-private staging is not a workspace mutation");
    },
  });
  try {
    await route.writePlacementPrivate({
      path: "/tmp/opengeni-private/workspace-exports/upload.curl",
      content: 'url = "https://storage.example.invalid/object"\n',
      createParents: true,
    });
    expect([...staged]).toEqual([
      [
        "/tmp/opengeni-private/workspace-exports/upload.curl",
        'url = "https://storage.example.invalid/object"\n',
      ],
    ]);
    expect(nativeCommands).toHaveLength(1);
  } finally {
    await sdk.close();
  }
});

test("a large sandbox file export stages its upload authority and uploads from a Modal sandbox", async () => {
  // Publishing a file above the inline limit uploads it from the box. The
  // signed URL is staged as a private file first; on Modal that staging used
  // to fail every time as "completion is pending or unknown".
  const starts: string[] = [];
  const commands = new Map<string, ModalRouterProviderCommand>();
  const control: Control = {
    start: async (args) => {
      starts.push(args.cmd);
      return {
        kind: "modal-router-v1",
        sandboxId: "sb-private",
        taskId: "task-private",
        execId: `exec-${starts.length}`,
        streams: {
          stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
          stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
        },
      };
    },
    read: async (value, waitMs) => {
      if (value.kind !== "modal-router-v1" || waitMs > 50_000)
        throw new Error("Invalid Modal output read bounds");
      const cmd = starts[Number(value.execId.slice("exec-".length)) - 1]!;
      const ok = cmd.match(/__OPENGENI_WORKSPACE_EXPORT_[0-9a-f]+_OK__/u)![0];
      const command = structuredClone(value);
      command.streams.stdout.byteOffset += Buffer.byteLength(ok);
      for (const stream of ["stdout", "stderr"] as const) {
        command.streams[stream].eof = true;
        command.streams[stream].exitCode = 0;
      }
      return {
        command,
        expected: value,
        exitCode: 0,
        chunks: [{ stream: "stdout" as const, chunkId: `${value.execId}:0`, text: ok }],
      };
    },
    readProbe: forbidden,
    write: forbidden,
  };
  const { sdk, staged, nativeCommands } = modalSession(control);
  const backend = { session: sdk, sandboxId: "sb-private", kind: "modal", activeEpoch: 0 };
  let generation = 0;
  const settled: number[] = [];
  const route = new RoutingSandboxSession({
    defaultResolved: backend,
    readPointer: async () => ({ activeSandboxId: "sb-private", activeEpoch: 0 }),
    resolveActiveBackend: async () => backend,
    beforeMutation: async () => ({ handle: ++generation }),
    providerCommandHandle: (admission) => (admission as { handle: number } | undefined)?.handle,
    afterMutation: async ({ retainedProcess }) => {
      if (retainedProcess?.providerCommand?.kind === "modal-router-v1")
        commands.set(retainedProcess.id, structuredClone(retainedProcess.providerCommand));
    },
    providerCommandPersistence: (process: RoutingRetainedProcess) => ({
      load: async () => commands.get(process.id) ?? null,
      reserveInput: forbidden,
      captureRouterPage: async (page) => {
        commands.set(process.id, structuredClone(page.command));
        return { command: page.command, captured: true };
      },
    }),
    settleProcess: async ({ process }) => {
      settled.push(process.providerSessionId);
    },
  });
  const service = new SandboxChannelAService({ session: route, workspaceRoot: "/workspace" });
  const sha256 = "a".repeat(64);
  try {
    const exported = await service.exportWorkspaceFile({
      path: "renders/final.mp4",
      sizeBytes: 54_000_000,
      sha256,
      upload: {
        url: "https://storage.example.invalid/object?X-Amz-Signature=must-not-leak",
        requiredHeaders: { "content-type": "video/mp4" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(exported).toEqual({ path: "renders/final.mp4", sizeBytes: 54_000_000, sha256 });
    // The signed URL reached the box only as staged private file content.
    const [[stagedPath, stagedContent]] = [...staged];
    expect(stagedPath).toStartWith("/tmp/opengeni-private/workspace-exports/");
    expect(stagedContent).toContain("must-not-leak");
    expect([...starts, ...nativeCommands].join("\n")).not.toContain("must-not-leak");
    // One admitted upload, and the staged file is removed afterwards.
    expect(starts).toHaveLength(1);
    expect(starts[0]).toContain("--upload-file");
    expect(nativeCommands.some((cmd) => cmd.includes(`rm -f '${stagedPath}'`))).toBeTrue();
  } finally {
    await sdk.close();
  }
});

test("staging is the first internal command on a fresh local sandbox session", async () => {
  // Local and other SDK backends install their output collection on first
  // use, so staging must also work before any other command has run.
  const session = await new UnixLocalSandboxClient().create(new Manifest());
  const path = `/tmp/opengeni-private/test-${crypto.randomUUID()}/upload.curl`;
  const backend = { session, sandboxId: null, kind: "unix_local", activeEpoch: 0 };
  const route = new RoutingSandboxSession({
    defaultResolved: backend,
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => backend,
    beforeMutation: async () => {
      throw new Error("placement-private staging is not a workspace mutation");
    },
  });
  try {
    await route.writePlacementPrivate({ path, content: "private\n", createParents: true });
    expect(await readFile(path, "utf8")).toBe("private\n");
  } finally {
    await rm(path.slice(0, path.lastIndexOf("/")), { recursive: true, force: true });
    await session.close();
  }
});
