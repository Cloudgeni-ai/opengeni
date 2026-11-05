import { describe, expect, test } from "bun:test";
import { SandboxWorkspaceReadNotFoundError } from "@openai/agents/sandbox";
import { SandboxFilesystemNotFoundError } from "modal";
import { runBeforeAgentStartHooks, type SandboxLifecycleHook } from "../src/index";
import { ChannelANotFoundError } from "../src/sandbox/channel-a";
import {
  instrumentSandboxClientSessionOperations,
  instrumentSandboxSessionOperations,
  sandboxHookOperationPurpose,
  withSandboxOperationPurpose,
  type SandboxSetupOperationObservation,
} from "../src/sandbox/operation-purpose";

function fakeSession() {
  const session = {
    calls: [] as string[],
    async exec(args: { cmd: string }) {
      session.calls.push(args.cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async readFile(args: { path: string }) {
      // Implemented through another instrumented method, like providers that
      // read files with a command.
      await session.exec({ cmd: `cat ${args.path}` });
      return "content";
    },
  };
  return session;
}

describe("sandbox setup operation purposes", () => {
  test("measures only scoped operations, keeps identity and counts nested operations once", async () => {
    const observations: SandboxSetupOperationObservation[] = [];
    const session = fakeSession();
    const instrumented = instrumentSandboxSessionOperations(session, "modal", (o) =>
      observations.push(o),
    );
    expect(instrumented).toBe(session);
    expect(instrumentSandboxSessionOperations(session, "modal", () => undefined)).toBe(session);

    await session.exec({ cmd: "agent tool" });
    expect(observations).toHaveLength(0);

    await withSandboxOperationPurpose("repository_skills", async () => {
      await session.readFile({ path: "/workspace/SKILL.md" });
      await withSandboxOperationPurpose("run_credentials", () => session.exec({ cmd: "write" }));
    });

    expect(session.calls).toEqual(["agent tool", "cat /workspace/SKILL.md", "write"]);
    expect(
      observations.map(({ op, purpose, outcome, backend }) => ({ op, purpose, outcome, backend })),
    ).toEqual([
      { op: "readFile", purpose: "repository_skills", outcome: "completed", backend: "modal" },
      { op: "exec", purpose: "run_credentials", outcome: "completed", backend: "modal" },
    ]);
    expect(observations.every((o) => o.durationSeconds >= 0)).toBe(true);
  });

  test("failed operations report failed and still throw", async () => {
    const observations: SandboxSetupOperationObservation[] = [];
    const session = {
      async exec() {
        throw new Error("boom");
      },
    };
    instrumentSandboxSessionOperations(session, "docker", (o) => observations.push(o));
    await expect(
      withSandboxOperationPurpose("file_resources", () => session.exec()),
    ).rejects.toThrow("boom");
    expect(observations.map((o) => o.outcome)).toEqual(["failed"]);
  });

  test("a read-only probe's definite path miss reports not_found, not failed, and still throws", async () => {
    const observations: SandboxSetupOperationObservation[] = [];
    const misses: unknown[] = [
      new ChannelANotFoundError("no such directory"),
      new SandboxFilesystemNotFoundError("no such file"),
      new SandboxWorkspaceReadNotFoundError("path not found: .claude/skills"),
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    ];
    let next = 0;
    const session = {
      async listDir() {
        throw misses[next++];
      },
      async readFile() {
        throw new SandboxFilesystemNotFoundError("SKILL.md");
      },
      async exec() {
        // A command cannot prove that a probed path is absent.
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    };
    instrumentSandboxSessionOperations(session, "modal", (o) => observations.push(o));
    await withSandboxOperationPurpose("repository_skills", async () => {
      for (const miss of misses) await expect(session.listDir()).rejects.toBe(miss);
      await expect(session.readFile()).rejects.toThrow("SKILL.md");
      await expect(session.exec()).rejects.toThrow("ENOENT");
    });
    expect(observations.map((o) => `${o.op}:${o.outcome}`)).toEqual([
      "listDir:not_found",
      "listDir:not_found",
      "listDir:not_found",
      "listDir:not_found",
      "readFile:not_found",
      "exec:failed",
    ]);
  });

  test("a probe failure that is not a definite path miss still reports failed", async () => {
    const observations: SandboxSetupOperationObservation[] = [];
    const session = {
      async listDir() {
        throw new Error("Modal sandbox sb-1 not found (has been terminated)");
      },
    };
    instrumentSandboxSessionOperations(session, "modal", (o) => observations.push(o));
    await expect(
      withSandboxOperationPurpose("repository_skills", () => session.listDir()),
    ).rejects.toThrow("terminated");
    expect(observations.map((o) => o.outcome)).toEqual(["failed"]);
  });

  test("sessions from every client creation method are measured, including lifecycle creates", async () => {
    const observations: SandboxSetupOperationObservation[] = [];
    const client = {
      async create() {
        return fakeSession();
      },
      async createWithLifecycle(_args: unknown, lifecycle: { onCreated(s: unknown): void }) {
        const session = fakeSession();
        lifecycle.onCreated(session);
        return session;
      },
      async resume() {
        return fakeSession();
      },
    };
    instrumentSandboxClientSessionOperations(client, "modal", (o) => observations.push(o));
    let announced: unknown;
    const created = await client.create();
    const lifecycleCreated = await client.createWithLifecycle(
      {},
      {
        onCreated: (s) => {
          announced = s;
        },
      },
    );
    const resumed = await client.resume();
    expect(announced).toBe(lifecycleCreated);
    for (const session of [created, lifecycleCreated, resumed]) {
      await withSandboxOperationPurpose("hook.codemode-token", () => session.exec({ cmd: "x" }));
    }
    expect(observations.map((o) => `${o.op}:${o.purpose}:${o.backend}`)).toEqual([
      "exec:hook.codemode-token:modal",
      "exec:hook.codemode-token:modal",
      "exec:hook.codemode-token:modal",
    ]);
  });

  test("lifecycle hooks report under their bounded hook id", async () => {
    const observations: SandboxSetupOperationObservation[] = [];
    const session = fakeSession();
    instrumentSandboxSessionOperations(session, "modal", (o) => observations.push(o));
    const hook = (id: string): SandboxLifecycleHook => ({
      id,
      phase: "beforeAgentStart",
      run: async (target) => {
        await (target as unknown as ReturnType<typeof fakeSession>).exec({ cmd: id });
      },
    });
    await runBeforeAgentStartHooks(
      session as never,
      [hook("repository-clone"), hook("custom-unknown")],
      { environment: {} },
    );
    expect(observations.map((o) => o.purpose)).toEqual(["hook.repository-clone", "hook.other"]);
    expect(sandboxHookOperationPurpose("azure-cli-login")).toBe("hook.azure-cli-login");
  });
});
