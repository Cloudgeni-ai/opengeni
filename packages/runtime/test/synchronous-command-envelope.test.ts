import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { synchronousCommandEnvelope } from "../src/sandbox/synchronous-command-envelope";

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
