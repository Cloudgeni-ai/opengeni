import { expect, test } from "bun:test";
import { verifyModalMaterializedPath } from "../src/sandbox/providers/modal-materialization-verification";
import {
  ModalCommandControl,
  type ModalProviderCommand,
  type ModalProviderOutputPage,
} from "../src/sandbox/providers/modal-command-control";
import { materializationVerificationDiagnostic } from "../src/sandbox/materialization-verification-error";
import { RoutingSandboxSession } from "../src/sandbox/routing/routing-session";
import { withSandboxProviderCapture } from "../src/sandbox/provider-operation-gate";

const marker = "__OPENGENI_MATERIALIZED_PATH_VISIBLE__";
const command: ModalProviderCommand = {
  provider: "modal",
  sandboxId: "sb-test",
  taskId: "ta-test",
  execId: "tp-test",
  streams: {
    stdout: { batchIndex: 0, utf8Remainder: "", exitCode: null },
    stderr: { batchIndex: 0, utf8Remainder: "", exitCode: null },
  },
};

function page(text: string, exitCode: number | null): ModalProviderOutputPage {
  return {
    command: structuredClone(command),
    chunks: [{ stream: "stdout", chunkId: "chunk", text }],
    exitCode,
    streamFidelity: "separate",
  };
}

function fixture(pages: ModalProviderOutputPage[]) {
  let starts = 0;
  let reads = 0;
  const pending = new Set<AbortController>();
  const control: Pick<ModalCommandControl, "start" | "readProbe"> = {
    async start(args) {
      starts++;
      expect(args.cmd).toBe(`test -e 'repos/example' && printf %s '${marker}'`);
      expect(args.workdir).toBe("/workspace");
      return structuredClone(command);
    },
    async readProbe() {
      reads++;
      return pages.shift() ?? page("", null);
    },
  };
  return { control, pending, starts: () => starts, reads: () => reads };
}

for (const [text, code, reason] of [
  ["", 1, "path_not_visible"],
  [marker, 127, "command_failed"],
  ["", 0, "invalid_response"],
  [`Process exited with code 0\nOutput:\n${marker}`, 0, "invalid_response"],
] as const) {
  test(`keeps ${reason} visible without retrying`, async () => {
    const f = fixture([page(text, code)]);
    await expect(
      verifyModalMaterializedPath(f.control, "repos/example", "/workspace", f.pending),
    ).rejects.toMatchObject({ diagnostic: { reason, exitCode: code } });
    expect(f.starts()).toBe(1);
    expect(f.reads()).toBe(1);
    expect(f.pending.size).toBe(0);
  });
}

test("marker before terminal failure is not success", async () => {
  const f = fixture([page(marker, null), page("", 1)]);
  await expect(
    verifyModalMaterializedPath(f.control, "repos/example", "/workspace", f.pending),
  ).rejects.toMatchObject({ diagnostic: { reason: "path_not_visible", exitCode: 1 } });
  expect(f.starts()).toBe(1);
  expect(f.reads()).toBe(2);
});

test("bounds empty observations without restarting or losing the exact execution", async () => {
  const f = fixture([]);
  await expect(
    verifyModalMaterializedPath(f.control, "repos/example", "/workspace", f.pending, 5),
  ).rejects.toMatchObject({
    diagnostic: {
      reason: "command_pending",
      providerSessionId: null,
      providerExecution: { sandboxId: "sb-test", taskId: "ta-test", execId: "tp-test" },
    },
  });
  expect(f.starts()).toBe(1);
  expect(f.pending.size).toBe(0);
});

for (const stage of ["start", "read"] as const) {
  test(`deadline aborts stalled ${stage} observation`, async () => {
    const f = fixture([]);
    let aborted = false;
    const stalled = (signal?: AbortSignal): Promise<never> =>
      new Promise((_, reject) => {
        signal!.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal!.reason);
          },
          { once: true },
        );
      });
    if (stage === "start") f.control.start = async (_, signal) => stalled(signal);
    else f.control.readProbe = async (_, __, cancellation) => stalled(cancellation.signal);
    await expect(
      verifyModalMaterializedPath(f.control, "repos/example", "/workspace", f.pending, 5),
    ).rejects.toMatchObject({ diagnostic: { reason: "command_pending" } });
    expect(aborted).toBe(true);
    expect(f.pending.size).toBe(0);
  });
}

test("provider errors keep identity and retained diagnostic evidence", async () => {
  const f = fixture([]);
  const error = Object.assign(new Error("provider unavailable"), { status: 503 });
  f.control.readProbe = async () => {
    throw error;
  };
  await expect(
    verifyModalMaterializedPath(f.control, "repos/example", "/workspace", f.pending),
  ).rejects.toBe(error);
  expect(materializationVerificationDiagnostic(error)).toMatchObject({
    reason: "command_error",
    providerExecution: { sandboxId: "sb-test", taskId: "ta-test", execId: "tp-test" },
  });
  expect(f.starts()).toBe(1);
});

test("rejects a changed provider identity without replay", async () => {
  const response = page(marker, 0);
  response.command.execId = "tp-other";
  const f = fixture([response]);
  await expect(
    verifyModalMaterializedPath(f.control, "repos/example", "/workspace", f.pending),
  ).rejects.toMatchObject({ diagnostic: { reason: "invalid_response" } });
  expect(f.starts()).toBe(1);
});

test("attempt cancellation preserves its cause and rejects late success", async () => {
  const f = fixture([]);
  const cancellation = new Error("attempt cancelled");
  f.control.readProbe = async () => {
    for (const controller of f.pending) controller.abort(cancellation);
    return page(marker, 0);
  };
  await expect(
    verifyModalMaterializedPath(f.control, "repos/example", "/workspace", f.pending),
  ).rejects.toBe(cancellation);
  expect(f.pending.size).toBe(0);
});

test("oversized provider output is a visible error rather than truncated success", async () => {
  const f = fixture([page("x".repeat(17_000) + marker, 0)]);
  await expect(
    verifyModalMaterializedPath(f.control, "repos/example", "/workspace", f.pending),
  ).rejects.toMatchObject({ diagnostic: { reason: "invalid_response" } });
  expect(f.starts()).toBe(1);
});

test("route change during verification rejects materialization without replay", async () => {
  let epoch = 0;
  let writes = 0;
  let probes = 0;
  const backend = {
    async materializeEntry() {
      writes++;
    },
    async verifyMaterializedPath() {
      probes++;
      epoch++;
    },
  };
  const proxy = new RoutingSandboxSession({
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: epoch }),
    resolveActiveBackend: async () => ({ session: backend, sandboxId: null, kind: "modal" }),
  });
  await expect(proxy.materializeEntry({ path: "repos/example", entry: {} })).rejects.toThrow(
    "superseded route",
  );
  expect(writes).toBe(1);
  expect(probes).toBe(1);
});

test("capture waits for the probe under the original gate without nested admission", async () => {
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finishing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const order: string[] = [];
  const backend = {
    async materializeEntry() {
      order.push("write");
    },
    async verifyMaterializedPath() {
      order.push("probe");
      entered();
      await finishing;
      order.push("verified");
    },
  };
  const proxy = new RoutingSandboxSession({
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => ({ session: backend, sandboxId: null, kind: "modal" }),
  });
  const materialization = proxy.materializeEntry({ path: "repos/example", entry: {} });
  await started;
  const capture = withSandboxProviderCapture(backend, async () => {
    order.push("capture");
  });
  expect(order).toEqual(["write", "probe"]);
  finish();
  await Promise.all([materialization, capture]);
  expect(order).toEqual(["write", "probe", "verified", "capture"]);
});

test("a stream failure aborts and drains its sibling before releasing probe ownership", async () => {
  const failure = new Error("stdout transport failed");
  let siblingEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    siblingEntered = resolve;
  });
  let siblingSettled = false;
  let siblingSignal: AbortSignal | undefined;
  const pending = new Set<AbortController>();
  const port = {
    sandboxGetTaskId: async () => ({ taskId: "ta-test" }),
    containerExec: async () => ({ execId: "tp-test" }),
    async *containerExecGetOutput(
      request: { fileDescriptor: number },
      options?: { signal?: AbortSignal },
    ): AsyncGenerator<never> {
      if (request.fileDescriptor === 1) {
        await entered;
        throw failure;
      }
      siblingSignal = options?.signal;
      try {
        siblingEntered();
        yield await new Promise<never>((_, reject) => {
          siblingSignal!.addEventListener("abort", () => reject(siblingSignal!.reason), {
            once: true,
          });
        });
      } finally {
        // Model asynchronous transport cleanup, not merely receipt of abort.
        await new Promise<void>((resolve) => setImmediate(resolve));
        siblingSettled = true;
      }
    },
  };
  const control = ModalCommandControl.forSandbox(
    { cpClient: port, version: () => "0.9.0" } as never,
    "sb-test",
    "/workspace",
  );
  await expect(
    verifyModalMaterializedPath(control, "repos/example", "/workspace", pending),
  ).rejects.toBe(failure);
  expect(siblingSignal?.aborted).toBe(true);
  expect(siblingSettled).toBe(true);
  expect(pending.size).toBe(0);
});
