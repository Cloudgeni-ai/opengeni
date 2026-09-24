import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ModalCommandControl } from "../src/sandbox/providers/modal-command-control";
import {
  withCommandSupervisionReady as withReady,
  withSupervisedLaunchReservation,
} from "../src/sandbox/provider-command-session";
import {
  ModalCommandStartPreDispatchUnavailableError,
  ModalCommandStartRejectedError,
} from "../src/sandbox/providers/modal-command-router-wire";

function withCommandSupervisionReady<T>(ready: boolean, fn: () => T): T {
  return withSupervisedLaunchReservation({ reserve: async () => {} }, () => withReady(ready, fn));
}
import type {
  ModalCommandRouterWire,
  ModalRouterStart,
} from "../src/sandbox/providers/modal-command-router-wire";

function fixture() {
  const starts: ModalRouterStart[] = [];
  let failStart: unknown = null;
  let exitCode = 0;
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
          if (failStart) throw failStart;
        },
        read: async (_id: unknown, stream: string) => {
          expect(stream).toBe("stdout");
          return { bytes: Buffer.from(response), eof: true };
        },
        poll: async () => exitCode,
      } as unknown as ModalCommandRouterWire);
    },
  });
  return {
    control,
    starts,
    failStart: (error: unknown = new Error("ambiguous start")) => {
      failStart = error;
    },
    response: (text: string) => {
      response = text;
    },
    exit: (code: number) => {
      exitCode = code;
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

test("supervised launch cannot dispatch without committed reservation", async () => {
  const f = fixture();
  await expect(withReady(true, () => f.control.start({ cmd: "never" }))).rejects.toThrow(
    "pre-dispatch reservation",
  );
  expect(f.starts).toHaveLength(0);
  await expect(
    withSupervisedLaunchReservation(
      {
        reserve: async () => {
          expect(f.starts).toHaveLength(0);
          throw new Error("DB commit failed");
        },
      },
      () => withReady(true, () => f.control.start({ cmd: "never" })),
    ),
  ).rejects.toThrow("DB commit failed");
  expect(f.starts).toHaveLength(0);
});

test("authenticated definite start rejection is not converted into running", async () => {
  const f = fixture();
  f.failStart(new ModalCommandStartRejectedError(5, new Error("missing executable")));
  await expect(
    withCommandSupervisionReady(true, () => f.control.start({ cmd: "never" })),
  ).rejects.toBeInstanceOf(ModalCommandStartRejectedError);
  expect(f.starts).toHaveLength(1);
});

test("pre-dispatch readiness failure escapes supervised start without a second launch", async () => {
  const f = fixture();
  const error = await ModalCommandStartPreDispatchUnavailableError.ensureReady({
    waitForReady: (_deadline: number, callback: (error: Error) => void) =>
      callback(new Error("not ready")),
  } as never).catch((failure) => failure);
  expect(error).toBeInstanceOf(ModalCommandStartPreDispatchUnavailableError);
  f.failStart(error);
  await expect(
    withCommandSupervisionReady(true, () => f.control.start({ cmd: "never" })),
  ).rejects.toBe(error);
  expect(f.starts).toHaveLength(1);
});

test("exact-instance capability requires native kernel probe, protocol and terminal zero", async () => {
  const f = fixture();
  f.response("native-subreaper-v1");
  await f.control.verifySupervisionCapability();
  expect(f.starts[0]!.commandArgs).toEqual([
    "/usr/local/bin/opengeni-command-supervisor",
    "capabilities",
  ]);
  f.exit(127);
  await expect(f.control.verifySupervisionCapability()).rejects.toThrow("lacks compatible");
  f.exit(0);
  f.response("other-version");
  await expect(f.control.verifySupervisionCapability()).rejects.toThrow("lacks compatible");
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
