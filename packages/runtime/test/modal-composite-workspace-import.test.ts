import { expect, test } from "bun:test";
import { Manifest } from "@openai/agents/sandbox";
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

const CONFINED = "__OPENGENI_FS_CONFINED_OK__";

/** One native (unadmitted) Modal SDK process: the workspace confinement probe,
 * the placement-private stdin transfer, or its cleanup. */
function nativeProcess(command: string[], staged: Map<string, string>) {
  const script = command.join(" ");
  const transfer = script.match(/dd bs=1 count=(\d+) .*> '([^']+)'/u);
  const output = script.includes(CONFINED)
    ? CONFINED
    : (script.match(/__OPENGENI_WORKSPACE_INSPECT_[0-9a-f]+_ABSENT__/u)?.[0] ?? "");
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
          if (transfer) controller.enqueue("__OPENGENI_PLACEMENT_PRIVATE_WRITE_OK__");
          else if (output) controller.enqueue(output);
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

/** The pinned Modal SDK session with Opengeni's production Modal policy and a
 * fake router control for admitted commands. */
function modalSession(control: Control) {
  const staged = new Map<string, string>();
  const nativeCommands: string[] = [];
  const sdk = installOpenGeniModalSnapshotPolicy(
    new ModalSandboxSession({
      state: {
        sandboxId: "sb-import",
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
  installModalCommandSession(sdk, control);
  return { sdk, staged, nativeCommands };
}

const forbidden = async () => {
  throw new Error("unexpected Modal command control");
};

function importFixture() {
  const starts: string[] = [];
  const commands = new Map<string, ModalRouterProviderCommand>();
  const settled: number[] = [];
  const control: Control = {
    start: async (args) => {
      starts.push(args.cmd);
      return {
        kind: "modal-router-v1",
        sandboxId: "sb-import",
        taskId: "task-import",
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
      const marker = cmd.match(/__OPENGENI_WORKSPACE_IMPORT_[0-9a-f]+_OK__/u)![0];
      const text = `${marker}\tcreated`;
      const command = structuredClone(value);
      command.streams.stdout.byteOffset += Buffer.byteLength(text);
      for (const stream of ["stdout", "stderr"] as const) {
        command.streams[stream].eof = true;
        command.streams[stream].exitCode = 0;
      }
      return {
        command,
        expected: value,
        exitCode: 0,
        chunks: [{ stream: "stdout" as const, chunkId: `${value.execId}:0`, text }],
      };
    },
    readProbe: forbidden,
    write: forbidden,
  };
  const { sdk, staged, nativeCommands } = modalSession(control);
  const backend = { session: sdk, sandboxId: "sb-import", kind: "modal", activeEpoch: 0 };
  let generation = 0;
  const route = new RoutingSandboxSession({
    defaultResolved: backend,
    readPointer: async () => ({ activeSandboxId: "sb-import", activeEpoch: 0 }),
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
  return { sdk, staged, nativeCommands, route, starts, settled };
}

test("a browser download saves into a Modal sandbox workspace through the routed import", async () => {
  // Saving a browser download imports the file with one composite routed
  // operation. Its confinement probe and private staging run unadmitted on
  // the SDK's own exec, whose separate output Modal collects natively. That
  // collection used to miss the composite's session wrapper, so every save
  // failed at once as "completion is pending or unknown".
  const { sdk, staged, nativeCommands, route, starts } = importFixture();
  const service = new SandboxChannelAService({ session: route, workspaceRoot: "/workspace" });
  const sha256 = "b".repeat(64);
  try {
    const receipt = await service.importWorkspaceFile({
      operationId: crypto.randomUUID(),
      destinationPath: "downloads/plans/drawing.ifc",
      overwrite: false,
      mayReplaceExisting: false,
      createParents: true,
      sizeBytes: 180_000_000,
      sha256,
      source: {
        url: "https://storage.example.invalid/object?X-Amz-Signature=must-not-leak",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(receipt).toEqual({
      destinationPath: "downloads/plans/drawing.ifc",
      sizeBytes: 180_000_000,
      sha256,
      replayed: false,
      revision: 1,
    });
    // The signed source reached the box only as staged private file content.
    const [[stagedPath, stagedContent]] = [...staged];
    expect(stagedPath).toStartWith("/tmp/opengeni-private/workspace-imports/");
    expect(stagedContent).toContain("must-not-leak");
    expect([...starts, ...nativeCommands].join("\n")).not.toContain("must-not-leak");
    // One admitted transfer; the confinement probe ran natively first, and the
    // staged authority is removed afterwards.
    expect(starts).toHaveLength(1);
    expect(starts[0]).toContain("curl --config");
    expect(nativeCommands[0]).toContain(CONFINED);
    expect(nativeCommands.some((cmd) => cmd.includes(`rm -f '${stagedPath}'`))).toBeTrue();
  } finally {
    await sdk.close();
  }
});

test("a routed Modal import inspection reads the workspace through native collection", async () => {
  // The non-mutating sibling of the import runs on the same composite session.
  const { sdk, nativeCommands, route, starts } = importFixture();
  try {
    const inspected = await route.inspectWorkspaceFilesOnResolvedBackend({
      requests: [
        {
          operationId: crypto.randomUUID(),
          destinationPath: "downloads/report.pdf",
          overwrite: false,
          mayReplaceExisting: false,
          sizeBytes: 3,
          sha256: "c".repeat(64),
          source: {
            url: "https://storage.example.invalid/object",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      ],
      workspaceRoot: "/workspace",
      revision: 0,
    });
    expect(inspected).toBeNull();
    expect(starts).toHaveLength(0);
    expect(nativeCommands.length).toBeGreaterThan(0);
  } finally {
    await sdk.close();
  }
});
