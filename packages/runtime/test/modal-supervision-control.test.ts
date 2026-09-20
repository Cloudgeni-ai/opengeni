import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ModalCommandControl } from "../src/sandbox/providers/modal-command-control";
import { withCommandSupervisionReady } from "../src/sandbox/provider-command-session";
import type {
  ModalCommandRouterWire,
  ModalRouterStart,
} from "../src/sandbox/providers/modal-command-router-wire";

function fixture() {
  const starts: ModalRouterStart[] = [];
  let failStart = false;
  let response = "";
  const control = ModalCommandControl.forSandbox(
    {
      version: () => "0.9.0",
      cpClient: { sandboxGetTaskId: async () => ({ taskId: "task-original" }) },
    } as never,
    "sandbox-original",
    "/workspace",
  );
  // Replace only the transport seam, preserving production request construction
  // and response validation. TLS/replay is exercised by router-wire tests.
  Object.defineProperty(control, "withRouter", {
    value: async (
      taskId: string,
      _signal: AbortSignal,
      run: (router: ModalCommandRouterWire) => Promise<unknown>,
    ) => {
      expect(taskId).toBe("task-original");
      return run({
        start: async (args: ModalRouterStart) => {
          starts.push(args);
          if (failStart) throw new Error("ambiguous start");
        },
        read: async (_id: unknown, stream: string) => {
          expect(stream).toBe("stdout");
          return { bytes: Buffer.from(response), eof: true };
        },
        poll: async () => 0,
      } as unknown as ModalCommandRouterWire);
    },
  });
  return {
    control,
    starts,
    failStart: () => {
      failStart = true;
    },
    response: (text: string) => {
      response = text;
    },
  };
}

test("only readiness-gated nonPTY commands without runAs get an idle supervisor", async () => {
  const f = fixture();
  const legacy = await f.control.start({ cmd: "original" });
  expect(legacy.supervision).toBeUndefined();
  const command = await withCommandSupervisionReady(true, () =>
    f.control.start({ cmd: "original" }),
  );
  expect(command.supervision?.protocol).toBe("native-subreaper-v1");
  expect(f.starts[1]!.commandArgs).toEqual([
    "/usr/local/bin/opengeni-command-supervisor",
    "launch",
    "--invocation",
    command.supervision!.invocationId,
    "--nonce",
    command.supervision!.nonce,
    "--socket",
    command.supervision!.controlPath,
    "--",
    "/bin/sh",
    "-c",
    "original",
  ]);
  expect(
    (await withCommandSupervisionReady(true, () => f.control.start({ cmd: "original", tty: true })))
      .supervision,
  ).toBeUndefined();
  expect(
    (
      await withCommandSupervisionReady(true, () =>
        f.control.start({ cmd: "original", runAs: "root" }),
      )
    ).supervision,
  ).toBeUndefined();
});

test("ambiguous supervised start retains exactly its client-chosen idle invocation without replay", async () => {
  const f = fixture();
  f.failStart();
  const command = await withCommandSupervisionReady(true, () => f.control.start({ cmd: "once" }));
  expect(f.starts).toHaveLength(1);
  expect(command.execId).toBe(f.starts[0]!.execId);
  expect(command.supervision).toBeDefined();
});

test("control uses a separate exact-task helper and validates invocation-bound receipts", async () => {
  const f = fixture();
  const command = await withCommandSupervisionReady(true, () =>
    f.control.start({ cmd: "user-data" }),
  );
  const receipt = {
    protocol: "native-subreaper-v1",
    invocationId: command.supervision!.invocationId,
    receiptId: randomUUID(),
    leaderExitCode: 0,
  };
  f.response(JSON.stringify({ state: "quiescent", receipt }));
  expect(await f.control.supervisionControl(command, "status")).toEqual({
    state: "quiescent",
    receipt,
  });
  expect(f.starts[1]!.execId).not.toBe(command.execId);
  expect(f.starts[1]!.workdir).toBe("/tmp");
  expect(f.starts[1]!.commandArgs).not.toContain("user-data");
  f.response(
    JSON.stringify({ state: "quiescent", receipt: { ...receipt, invocationId: randomUUID() } }),
  );
  await expect(f.control.supervisionControl(command, "status")).rejects.toThrow(
    "invocation mismatch",
  );
  f.response(JSON.stringify({ state: "quiescent" }));
  await expect(f.control.supervisionControl(command, "status")).rejects.toThrow(
    "lacks its receipt",
  );
});

test("control refuses foreign sandbox identity and oversized proof before acceptance", async () => {
  const f = fixture();
  const command = await withCommandSupervisionReady(true, () =>
    f.control.start({ cmd: "user-data" }),
  );
  await expect(
    f.control.supervisionControl({ ...command, sandboxId: "other" }, "status"),
  ).rejects.toThrow("identity is unavailable");
  expect(f.starts).toHaveLength(1);
  f.response("x".repeat(4097));
  await expect(f.control.supervisionControl(command, "status")).rejects.toThrow(
    "exceeds its bound",
  );
});
