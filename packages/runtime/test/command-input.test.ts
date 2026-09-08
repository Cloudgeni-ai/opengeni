import { expect, test } from "bun:test";
import { sendCommandInput } from "../src/sandbox/command-input";
import { RoutingSandboxSession } from "../src/sandbox/routing/routing-session";

test("stdin uses the owning retained route even after the active pointer moves", async () => {
  let activeSandboxId: string | null = null;
  const inputs: unknown[] = [];
  const session = new RoutingSandboxSession({
    readPointer: async () => ({ activeSandboxId, activeEpoch: activeSandboxId ? 1 : 0 }),
    resolveActiveBackend: async () => {
      if (activeSandboxId) throw new Error("must not resolve the replacement route");
      return {
        sandboxId: null,
        kind: "modal",
        session: {
          execCommand: async () => "Process running with session ID 18\n\nOutput:\n",
          writeStdin: async (args: unknown) => {
            inputs.push(args);
            return "Process running with session ID 18\n\nOutput:\naccepted";
          },
        },
      };
    },
  });
  await session.execCommand({ cmd: "read value" });
  activeSandboxId = "replacement";
  const result = await sendCommandInput(session, { providerSessionId: 18, chars: "hello\n" });
  expect(result.supported).toBe(true);
  expect(inputs).toEqual([{ sessionId: 18, chars: "hello\n", yieldTimeMs: 0 }]);
});

test("Connected Machine input is explicitly unsupported and never invokes a pretend transport", async () => {
  let writes = 0;
  const result = await sendCommandInput(
    {
      commandCancellationTransport: async () => "remote_operation",
      writeStdin: async () => {
        writes += 1;
        return "wrong";
      },
    },
    { providerSessionId: 1, chars: "input" },
  );
  expect(result).toEqual({
    supported: false,
    reason: "Connected Machine commands do not support stdin transport",
  });
  expect(writes).toBe(0);
});

test("providers without arbitrary stdin report unsupported and empty input is not a read alias", async () => {
  expect(
    await sendCommandInput(
      { supportsCommandInput: () => false },
      { providerSessionId: 1, chars: "input" },
    ),
  ).toMatchObject({ supported: false });
  await expect(sendCommandInput({}, { providerSessionId: 1, chars: "" })).rejects.toThrow(
    "command_read",
  );
});
