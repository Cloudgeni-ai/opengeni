import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RoutingSandboxSession,
  materializationVerificationDiagnostic,
  type RoutableBackendSession,
} from "../src/sandbox";

test("a real provider-shell visibility failure retains the result and checked root", async () => {
  const root = await mkdtemp(join(tmpdir(), "opengeni-visibility-"));
  const mountedRoot = join(root, "provider");
  const stagingRoot = join(root, "staging");
  const path = "repos/example";
  const observations: unknown[] = [];
  try {
    await mkdir(mountedRoot);
    const backend: RoutableBackendSession = {
      state: { manifest: { root: mountedRoot } },
      async materializeEntry() {
        // Reproduce a successful staging write that is invisible in the provider.
        await mkdir(join(stagingRoot, path), { recursive: true });
      },
      async execCommand(value) {
        const args = value as { shell: string; cmd: string; workdir: string };
        const child = Bun.spawn([args.shell, "-c", args.cmd], {
          cwd: args.workdir,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return `Process exited with code ${code}\nOutput:\n${stdout}${stderr}`;
      },
    };
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({ session: backend, sandboxId: null, kind: "modal" }),
      onOperation: (value) => observations.push(value),
    });
    await expect(proxy.materializeEntry({ path, entry: {} })).rejects.toMatchObject({
      code: "sandbox_materialization_verification_failed",
      diagnostic: {
        reason: "path_not_visible",
        path,
        workdir: mountedRoot,
        exitCode: 1,
        output: "Process exited with code 1\nOutput:\n",
      },
    });
    expect(observations).toContainEqual(
      expect.objectContaining({
        op: "materializeEntry",
        outcome: "failed",
        materializationFailureReason: "path_not_visible",
      }),
    );
    // The same real check succeeds once the destination is visible in its cwd.
    await mkdir(join(mountedRoot, path), { recursive: true });
    await proxy.materializeEntry({ path, entry: {} });
    expect(observations.at(-1)).toMatchObject({ op: "materializeEntry", outcome: "ok" });
    expect(observations.at(-1)).not.toHaveProperty("materializationFailureReason");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [output, reason, exitCode, providerSessionId] of [
  ["Process exited with code 127\nOutput:\nsh: command not found\n", "command_failed", 127, null],
  ["Process running with session ID 42\nOutput:\n", "command_pending", null, 42],
  ["Process exited with code 0\nOutput:\n", "invalid_response", 0, null],
  [
    "Process exited with code 0\nProcess exited with code 1\nOutput:\n",
    "invalid_response",
    null,
    null,
  ],
  [
    "Process running with session ID 42\nOutput:\n__OPENGENI_MATERIALIZED_PATH_VISIBLE__",
    "command_pending",
    null,
    42,
  ],
] as const) {
  test(`preserves ${reason} evidence without replaying materialization`, async () => {
    let writes = 0;
    const backend: RoutableBackendSession = {
      async materializeEntry() {
        writes++;
      },
      async execCommand() {
        return output;
      },
    };
    const proxy = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({ session: backend, sandboxId: null, kind: "modal" }),
    });
    await expect(
      proxy.materializeEntry({ path: "repos/example", entry: {} }),
    ).rejects.toMatchObject({
      diagnostic: { reason, output, exitCode, providerSessionId },
    });
    expect(writes).toBe(1);
  });
}

test("retains thrown provider error identity and diagnostics without misreporting a missing path", async () => {
  const cause = new Error("exact provider transport detail");
  const backend: RoutableBackendSession = {
    async materializeEntry() {},
    async execCommand() {
      throw cause;
    },
  };
  const proxy = new RoutingSandboxSession({
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => ({ session: backend, sandboxId: null, kind: "modal" }),
  });
  await expect(proxy.materializeEntry({ path: "repos/example", entry: {} })).rejects.toBe(cause);
  expect(materializationVerificationDiagnostic(cause)).toMatchObject({
    reason: "command_error",
    output: null,
    causeMessage: cause.message,
  });
});
