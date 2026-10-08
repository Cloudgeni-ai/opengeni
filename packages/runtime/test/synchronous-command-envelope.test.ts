import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { synchronousCommandEnvelope } from "../src/sandbox/synchronous-command-envelope";
import { SandboxChannelAService } from "../src/sandbox/channel-a";
import { cancellableSynchronousShellCommand } from "../src/sandbox/turn-tool-cancellation";
import { WRITE_FILES_COMMAND_MAX_BYTES } from "../src/sandbox/write-files-script";

async function run(command: string, cwd?: string) {
  const child = Bun.spawn(["/bin/sh", "-c", command], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("the completion envelope proves the one process exit and independent bytes", async () => {
  const envelope = synchronousCommandEnvelope(
    "printf 'metadata: exit 0\\n'; printf '  diagnostic\\n' >&2; exit 7",
    crypto.randomUUID(),
  );
  const child = Bun.spawn(["/bin/sh", "-c", envelope.command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(7);
  expect(envelope.decode(stdout, exitCode)).toEqual({
    stdout: "metadata: exit 0\n",
    stderr: "  diagnostic\n",
    exitCode: 7,
  });
  type Record = {
    nonce: string;
    commandSha256: string;
    stdout: { bytes: number; base64: string };
    stderr: { sha256: string };
    extra?: string;
  };
  for (const mutate of [
    (record: Record) => {
      record.nonce = crypto.randomUUID();
    },
    (record: Record) => {
      record.commandSha256 = "0".repeat(64);
    },
    (record: Record) => {
      record.stdout.bytes++;
    },
    (record: Record) => {
      record.stderr.sha256 = "0".repeat(64);
    },
    (record: Record) => {
      record.stdout.base64 += "invalid";
    },
    (record: Record) => {
      record.extra = "untrusted";
    },
  ]) {
    const record = JSON.parse(stdout);
    mutate(record);
    expect(envelope.decode(JSON.stringify(record), exitCode)).toBeNull();
  }
  expect(envelope.decode(stdout.slice(0, -10), exitCode)).toBeNull();
  expect(envelope.decode(stdout, 0)).toBeNull();
});

test("the completion compiler ignores workspace Python modules and startup environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-python-"));
  try {
    await writeFile(join(root, "subprocess.py"), "raise SystemExit('workspace module executed')\n");
    await writeFile(join(root, "hashlib.py"), "raise SystemExit('workspace module executed')\n");
    const envelope = synchronousCommandEnvelope(
      "printf '%s' \"$CAPTURE_MODE\"; printf diagnostic >&2",
      crypto.randomUUID(),
    );
    const child = Bun.spawn(["/bin/sh", "-c", envelope.command], {
      cwd: root,
      env: { ...process.env, PYTHONPATH: root, CAPTURE_MODE: "original" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(envelope.decode(stdout, exitCode)).toEqual({
      stdout: "original",
      stderr: "diagnostic",
      exitCode: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the envelope drains large independent UTF8 pipes concurrently", async () => {
  const envelope = synchronousCommandEnvelope(
    'python3 -I -S -c \'import os; os.write(1, ("🙂out\\n" * 100000).encode()); os.write(2, ("🙂err\\n" * 100000).encode())\'',
    crypto.randomUUID(),
  );
  const result = await run(envelope.command);
  expect(envelope.decode(result.stdout, result.exitCode)).toEqual({
    stdout: "🙂out\n".repeat(100_000),
    stderr: "🙂err\n".repeat(100_000),
    exitCode: 0,
  });
  expect(result.stderr).toBe("");
});

test("a byte-valid envelope cannot silently replace malformed UTF8 streams", async () => {
  const envelope = synchronousCommandEnvelope("printf '\\377'", crypto.randomUUID());
  const result = await run(envelope.command);
  expect(result.exitCode).toBe(0);
  expect(envelope.decode(result.stdout, result.exitCode)).toBeNull();
});

test("the envelope waits for descendant-held stream EOF after its original leader exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-eof-"));
  const release = join(root, "release");
  const envelope = synchronousCommandEnvelope(
    `printf prefix; (while [ ! -e '${release}' ]; do sleep 0.01; done; printf tail; printf diagnostic >&2) & exit 7`,
    crypto.randomUUID(),
  );
  let completed = false;
  const pending = run(envelope.command).finally(() => {
    completed = true;
  });
  try {
    await Bun.sleep(50);
    expect(completed).toBe(false);
    await writeFile(release, "release");
    const result = await pending;
    expect(envelope.decode(result.stdout, result.exitCode)).toEqual({
      stdout: "prefixtail",
      stderr: "diagnostic",
      exitCode: 7,
    });
  } finally {
    await writeFile(release, "release");
    await pending;
    await rm(root, { recursive: true, force: true });
  }
});

test("actual admitted multi-batch filesystem source remains below the single-argv limit through control and collection", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-argv-"));
  const commands: number[] = [];
  const controlled: number[] = [];
  const wrapped: number[] = [];
  const content = "a".repeat(64_000);
  const service = new SandboxChannelAService({
    workspaceRoot: root,
    session: {
      exec: async (args) => {
        commands.push(Buffer.byteLength(args.cmd));
        const source = cancellableSynchronousShellCommand(
          args.cmd,
          join(root, crypto.randomUUID()),
        );
        const envelope = synchronousCommandEnvelope(source, crypto.randomUUID());
        controlled.push(Buffer.byteLength(source));
        wrapped.push(Buffer.byteLength(envelope.command));
        const result = await run(envelope.command, root);
        const receipt = envelope.decode(result.stdout, result.exitCode);
        expect(receipt).not.toBeNull();
        return receipt!;
      },
    },
    emit: async () => {},
  });
  try {
    const result = await service.fsWriteFiles({
      directory: "batch",
      files: [
        { path: "one.txt", content },
        { path: "two.txt", content },
      ],
    });
    expect(result.written).toEqual(["one.txt", "two.txt"]);
    expect(commands.length).toBeGreaterThan(1);
    expect(Math.max(...commands)).toBeGreaterThan(WRITE_FILES_COMMAND_MAX_BYTES - 4 * 1024);
    expect(Math.max(...commands)).toBeLessThanOrEqual(WRITE_FILES_COMMAND_MAX_BYTES);
    expect(Math.max(...controlled)).toBeLessThan(128 * 1024);
    expect(Math.max(...wrapped)).toBeLessThan(128 * 1024);
    expect(await readFile(join(root, "batch", "one.txt"), "utf8")).toBe(content);
    expect(await readFile(join(root, "batch", "two.txt"), "utf8")).toBe(content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the envelope preserves the existing exact process-group cancellation path", async () => {
  const root = await mkdtemp(join(tmpdir(), "completion-control-"));
  const marker = join(root, crypto.randomUUID());
  const started = join(root, "started");
  const source = cancellableSynchronousShellCommand(
    `printf prefix; printf started > '${started}'; sleep 30`,
    marker,
  );
  const envelope = synchronousCommandEnvelope(source, crypto.randomUUID());
  const child = Bun.spawn(["/bin/sh", "-c", envelope.command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const pending = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  let group: number | undefined;
  try {
    for (let i = 0; i < 100; i++) {
      const data = await readFile(marker, "utf8").catch(() => "");
      if (data && (await readFile(started, "utf8").catch(() => "")) === "started") {
        const fields = data.trim().split(" ").map(Number);
        expect(fields).toHaveLength(2);
        expect(fields[0]).toBe(fields[1]);
        expect(Number.isSafeInteger(fields[1]) && fields[1]! > 1).toBe(true);
        group = fields[1];
        break;
      }
      await Bun.sleep(10);
    }
    expect(group).toBeDefined();
    // The marker was emitted by this test's unique group leader, never a broad
    // process search. Terminate only that validated, test-owned process group.
    process.kill(-group!, "SIGTERM");
    const [stdout, stderr, exitCode] = await pending;
    group = undefined;
    expect(envelope.decode(stdout, exitCode)).toMatchObject({ stdout: "prefix", exitCode: 143 });
    expect(stderr).toBe("");
  } finally {
    if (group) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {}
    }
    child.kill();
    await pending;
    await rm(root, { recursive: true, force: true });
  }
});
