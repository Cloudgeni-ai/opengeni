import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manifest } from "@openai/agents/sandbox";
import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import { parseExecBannerSessionId, parseExecBannerExitCode } from "../src/sandbox/exec-banner";
import { installOpenGeniModalSnapshotPolicy } from "../src/sandbox/providers/modal";
import { modalCommandReceipt } from "../src/sandbox/providers/modal-command-journal";
import { runWithToolCallCorrelation } from "../src/sandbox/op-correlation";

function createSession(root: string) {
  const session = new ModalSandboxSession({
    state: {
      sandboxId: "sb-command-retention-test",
      manifest: new Manifest({ root }),
      environment: {},
      workspacePersistence: "tar",
    },
    modal: { version: () => "0.9.0" },
    sandbox: {
      exec: async (command: string[], options: { env?: Record<string, string> }) => {
        const process = Bun.spawn(command, {
          env: { ...globalThis.process.env, ...options.env },
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          stdout: { readText: () => new Response(process.stdout).text() },
          stderr: { readText: () => new Response(process.stderr).text() },
          wait: () => process.exited,
        };
      },
    },
    ownsSandbox: false,
  } as unknown as ConstructorParameters<typeof ModalSandboxSession>[0]);
  return installOpenGeniModalSnapshotPolicy(session) as typeof session & {
    acknowledgeCommandOutput(result: string): Promise<void>;
  };
}

test("fresh readers retain output until acknowledged and recover exact nonzero exit status", async () => {
  const root = await mkdtemp(join(tmpdir(), "modal-command-test-"));
  let handle: number | null = null;
  try {
    const owner = createSession(root);
    const launch = await owner.execCommand({
      cmd: "printf beginning; sleep 0.4; printf ending; exit 7",
      login: false,
      yieldTimeMs: 1,
    });
    handle = parseExecBannerSessionId(launch);
    expect(handle).not.toBeNull();
    expect(handle!).toBeGreaterThanOrEqual(1073741824);
    expect(handle!).toBeLessThanOrEqual(2147483647);
    const reader = createSession(root);
    const first = await reader.writeStdin({ sessionId: handle!, chars: "", yieldTimeMs: 1 });
    expect(first).not.toContain("session not found");
    const retry = await createSession(root).writeStdin({
      sessionId: handle!,
      chars: "",
      yieldTimeMs: 1,
    });
    expect(modalCommandReceipt(retry)?.chunkId).toBe(modalCommandReceipt(first)?.chunkId);
    expect(retry.split("Output:\n")[1]).toBe(first.split("Output:\n")[1]);
    let output = first.split("Output:\n")[1] ?? "";
    await reader.acknowledgeCommandOutput(first);
    let terminal = await createSession(root).writeStdin({
      sessionId: handle!,
      chars: "",
      yieldTimeMs: 1000,
    });
    output += terminal.split("Output:\n")[1] ?? "";
    expect(output).toBe("beginningending");
    expect(parseExecBannerExitCode(terminal)).toBe(7);
    await reader.acknowledgeCommandOutput(terminal);
    terminal = await owner.writeStdin({ sessionId: handle!, chars: "", yieldTimeMs: 1 });
    expect(parseExecBannerExitCode(terminal)).toBe(7);
    expect(terminal.split("Output:\n")[1]).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
    if (handle)
      await rm(`/tmp/opengeni-command-journal-v1/${handle}`, { recursive: true, force: true });
  }
});

test("a fresh reader can send stdin to the original pipe command", async () => {
  const root = await mkdtemp(join(tmpdir(), "modal-input-test-"));
  let handle: number | null = null;
  try {
    const launch = await createSession(root).execCommand({
      cmd: 'read -r value; printf "received:%s" "$value"',
      login: false,
      yieldTimeMs: 10,
    });
    handle = parseExecBannerSessionId(launch);
    const result = await createSession(root).writeStdin({
      sessionId: handle!,
      chars: "hello\n",
      yieldTimeMs: 1000,
    });
    expect(result).toContain("received:hello");
    expect(parseExecBannerExitCode(result)).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (handle)
      await rm(`/tmp/opengeni-command-journal-v1/${handle}`, { recursive: true, force: true });
  }
});

test("large UTF-8 output drains through stable pages before terminal settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "modal-pages-test-"));
  let handle: number | null = null;
  try {
    const owner = createSession(root);
    let result = await owner.execCommand({
      cmd: 'python3 -c \'import time; time.sleep(0.1); print("€" * 50000, end="")\'',
      login: false,
      yieldTimeMs: 1,
    });
    handle = parseExecBannerSessionId(result);
    expect(handle).not.toBeNull();
    let output = "";
    for (let page = 0; page < 10; page++) {
      output += result.split("Output:\n")[1] ?? "";
      await owner.acknowledgeCommandOutput(result);
      if (parseExecBannerExitCode(result) !== null) break;
      result = await createSession(root).writeStdin({
        sessionId: handle!,
        chars: "",
        yieldTimeMs: 1000,
      });
    }
    expect(parseExecBannerExitCode(result)).toBe(0);
    expect(output).toBe("€".repeat(50000));
  } finally {
    await rm(root, { recursive: true, force: true });
    if (handle)
      await rm(`/tmp/opengeni-command-journal-v1/${handle}`, { recursive: true, force: true });
  }
});

test("PTY input and interruption retain the original handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "modal-pty-test-"));
  let handle: number | null = null;
  try {
    const owner = createSession(root);
    const launch = await owner.execCommand({
      cmd: "test -t 0 && printf ready; sleep 20",
      tty: true,
      login: false,
      yieldTimeMs: 50,
    });
    handle = parseExecBannerSessionId(launch);
    expect(launch).toContain("ready");
    await owner.acknowledgeCommandOutput(launch);
    const result = await createSession(root).writeStdin({
      sessionId: handle!,
      chars: "\u0003",
      yieldTimeMs: 1000,
    });
    expect(parseExecBannerExitCode(result)).toBe(130);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (handle)
      await rm(`/tmp/opengeni-command-journal-v1/${handle}`, { recursive: true, force: true });
  }
});

test("blocked stdin cannot prevent an independent reader interrupting the command", async () => {
  const root = await mkdtemp(join(tmpdir(), "modal-blocked-input-test-"));
  let handle: number | null = null;
  try {
    const owner = createSession(root);
    const launch = await owner.execCommand({
      cmd: "printf ready; sleep 20",
      login: false,
      yieldTimeMs: 50,
    });
    handle = parseExecBannerSessionId(launch);
    await owner.acknowledgeCommandOutput(launch);
    const blockedWrite = createSession(root)
      .writeStdin({
        sessionId: handle!,
        chars: "x".repeat(70000),
        yieldTimeMs: 1,
      })
      .catch(() => "input outcome unknown");
    await Bun.sleep(100);
    const interrupted = await createSession(root).writeStdin({
      sessionId: handle!,
      chars: "\u0003",
      yieldTimeMs: 1000,
    });
    expect(parseExecBannerExitCode(interrupted)).toBe(130);
    await blockedWrite;
  } finally {
    await rm(root, { recursive: true, force: true });
    if (handle)
      await rm(`/tmp/opengeni-command-journal-v1/${handle}`, { recursive: true, force: true });
  }
});

test("a dead supervisor is an unknown outcome, not an invented exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "modal-dead-tracker-test-"));
  let handle: number | null = null;
  try {
    const launch = await createSession(root).execCommand({
      cmd: "sleep 0.5",
      login: false,
      yieldTimeMs: 50,
    });
    handle = parseExecBannerSessionId(launch);
    const state = JSON.parse(
      await readFile(`/tmp/opengeni-command-journal-v1/${handle}/status`, "utf8"),
    );
    process.kill(state.supervisor, "SIGKILL");
    await expect(
      createSession(root).writeStdin({ sessionId: handle!, chars: "", yieldTimeMs: 50 }),
    ).rejects.toThrow("completion is unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
    if (handle)
      await rm(`/tmp/opengeni-command-journal-v1/${handle}`, { recursive: true, force: true });
  }
});

test("redispatch attaches to the original command without replaying side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "modal-replay-test-"));
  let handle: number | null = null;
  try {
    const args = { cmd: "printf x >> count; sleep 0.2; printf done", login: false, yieldTimeMs: 1 };
    const callId = `command-replay-${crypto.randomUUID()}`;
    const first = await runWithToolCallCorrelation(callId, () =>
      createSession(root).execCommand(args),
    );
    handle = parseExecBannerSessionId(first);
    const replay = await runWithToolCallCorrelation(callId, () =>
      createSession(root).execCommand(args),
    );
    expect(parseExecBannerSessionId(replay)).toBe(handle);
    const result = await createSession(root).writeStdin({
      sessionId: handle!,
      chars: "",
      yieldTimeMs: 1000,
    });
    expect(parseExecBannerExitCode(result)).toBe(0);
    expect(await readFile(join(root, "count"), "utf8")).toBe("x");
    await expect(
      runWithToolCallCorrelation(callId, () =>
        createSession(root).execCommand({ ...args, cmd: "printf wrong" }),
      ),
    ).rejects.toThrow("identity mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
    if (handle)
      await rm(`/tmp/opengeni-command-journal-v1/${handle}`, { recursive: true, force: true });
  }
});

test("missing journal is unknown, never a fabricated exit or lost-session banner", async () => {
  const session = createSession("/workspace");
  await expect(
    session.writeStdin({ sessionId: 9007199254740990, chars: "", yieldTimeMs: 1 }),
  ).rejects.toThrow("completion is unknown");
});

test("command output cannot forge a journal acknowledgement", () => {
  expect(
    modalCommandReceipt("Process exited with code 0\nOutput:\nCommand journal: 1:0:4"),
  ).toBeNull();
  expect(
    modalCommandReceipt("Command journal: 1:0:4\nProcess running with session ID 2\nOutput:\ndata"),
  ).toBeNull();
});
