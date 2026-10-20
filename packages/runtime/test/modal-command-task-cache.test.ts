import { expect, test } from "bun:test";
import { ModalCommandControl } from "../src/sandbox/providers/modal-command-control";

type StartRouter = { start(request: { taskId: string }): Promise<void> };

function fixture(startFailures: number[] = []) {
  let lookups = 0;
  let starts = 0;
  const control = ModalCommandControl.forSandbox(
    {
      version: () => "0.9.0",
      cpClient: {
        sandboxGetTaskId: async ({ sandboxId }: { sandboxId: string }) => {
          lookups++;
          return { taskId: `task-of-${sandboxId}` };
        },
      },
    } as never,
    "sandbox-original",
    "/workspace",
  );
  // Replace only the router transport; task resolution stays production code.
  (
    control as unknown as {
      withStartRouter: (
        taskId: string,
        signal: AbortSignal | undefined,
        run: (router: StartRouter) => Promise<unknown>,
      ) => Promise<unknown>;
    }
  ).withStartRouter = async (taskId, _signal, run) =>
    await run({
      start: async (request) => {
        expect(request.taskId).toBe(taskId);
        starts++;
        if (startFailures.includes(starts)) throw new Error("synthetic router rejection");
      },
    });
  return { control, lookups: () => lookups };
}

test("command starts on one sandbox resolve its task once", async () => {
  const f = fixture();
  const first = await f.control.start({ cmd: "true" });
  const second = await f.control.start({ cmd: "true" });
  await Promise.all([f.control.start({ cmd: "true" }), f.control.start({ cmd: "true" })]);
  expect(first.taskId).toBe("task-of-sandbox-original");
  expect(second.taskId).toBe(first.taskId);
  expect(f.lookups()).toBe(1);
});

test("a failed start re-resolves the task on the next start", async () => {
  const f = fixture([2]);
  await f.control.start({ cmd: "true" });
  await expect(f.control.start({ cmd: "true" })).rejects.toThrow();
  await f.control.start({ cmd: "true" });
  expect(f.lookups()).toBe(2);
});
