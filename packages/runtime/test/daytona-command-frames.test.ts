import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daytonaCommandFrames } from "../src/sandbox/providers/daytona-command-frames";
import { SandboxChannelAService } from "../src/sandbox/channel-a";
import { cancellableSynchronousShellCommand } from "../src/sandbox/turn-tool-cancellation";
import { WRITE_FILES_COMMAND_MAX_BYTES } from "../src/sandbox/write-files-script";

async function run(command: string, env?: Record<string, string>) {
  const child = Bun.spawn(["/bin/sh", "-c", command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env } : {}),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // Native v0.162.0 line labels, including the final-partial newline rule.
  // Framing carries only newline-terminated ASCII, so that rule changes none
  // of the encoded original bytes. The actual Process decoder is separately
  // covered through the native SDK transport fixture.
  const labelled = (text: string, byte: string) =>
    text
      .split("\n")
      .filter(Boolean)
      .map((line) => byte.repeat(3) + line + "\n")
      .join("");
  return { raw: labelled(stdout, "\x01") + labelled(stderr, "\x02"), exitCode };
}

test.each([0, 7])(
  "Python-free native frames preserve NUL, marker bytes and unterminated UTF8 at exit %s",
  async (exitCode) => {
    const source =
      "printf '  雪\\000\\001\\001\\001tail'; printf 'é\\002\\002\\002\\n\\n' >&2; exit " +
      exitCode;
    const frame = daytonaCommandFrames(source, crypto.randomUUID());
    const result = await run(frame.command, { PATH: "/nonexistent", PYTHONPATH: "/nonexistent" });
    expect(frame.decode(result.raw, result.exitCode)).toEqual({
      stdout: "  雪\0\x01\x01\x01tail",
      stderr: "é\x02\x02\x02\n\n",
      exitCode,
    });
    expect(result.raw.split("\n").every((line) => line.length <= 512)).toBe(true);
    expect(frame.command).not.toContain("python");
  },
);

test("native frames concurrently drain large separate pipes without presentation limits", async () => {
  const frame = daytonaCommandFrames(
    "printf '%02000000d' 0; printf '%02000000d' 0 >&2",
    crypto.randomUUID(),
  );
  const result = await run(frame.command);
  expect(frame.decode(result.raw, result.exitCode)).toEqual({
    stdout: "0".repeat(2_000_000),
    stderr: "0".repeat(2_000_000),
    exitCode: 0,
  });
}, 30_000);

test("native frames keep the compiled command, cwd and native environment exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-frame-env-"));
  try {
    const source = 'printf \'%s\n%s\' "$PWD" "$ORIGINAL_ENV"';
    const frame = daytonaCommandFrames(source, crypto.randomUUID(), root, {
      ORIGINAL_ENV: "value\n",
    });
    const result = await run(frame.command);
    expect(frame.command.split(source)).toHaveLength(2);
    // Native Process's existing command-substitution export strips final LF.
    expect(frame.decode(result.raw, result.exitCode)).toEqual({
      stdout: `${root}\nvalue`,
      stderr: "",
      exitCode: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native framed exit waits for descendant-held pipes, not only original leader exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-frame-eof-"));
  const release = join(root, "release");
  const frame = daytonaCommandFrames(
    `printf prefix; (while [ ! -e '${release}' ]; do sleep 0.01; done; printf diagnostic >&2) & exit 7`,
    crypto.randomUUID(),
  );
  const pending = run(frame.command);
  let complete = false;
  void pending.then(() => {
    complete = true;
  });
  try {
    await Bun.sleep(50);
    expect(complete).toBe(false);
    await writeFile(release, "release");
    const result = await pending;
    expect(frame.decode(result.raw, result.exitCode)).toEqual({
      stdout: "prefix",
      stderr: "diagnostic",
      exitCode: 7,
    });
  } finally {
    await writeFile(release, "release");
    await pending;
    await rm(root, { recursive: true, force: true });
  }
});

test("native physical exit or purged logs alone cannot prove framed completion", async () => {
  const frame = daytonaCommandFrames("printf original", crypto.randomUUID());
  expect(frame.decode("", 0)).toBeNull();
  const result = await run(frame.command);
  expect(frame.decode(result.raw, null)).toBeNull();
  expect(frame.decode(result.raw.slice(0, -1), result.exitCode)).toBeNull();
  expect(() => frame.decode(result.raw, 7)).toThrow("exit mismatch");
  expect(() =>
    frame.decode(result.raw.replace(/^.* EOF stdout.*\n/mu, ""), result.exitCode),
  ).toThrow();
});

test("native frame identity, sequence, carrier and digest reject fabricated completion", async () => {
  const frame = daytonaCommandFrames("printf original; printf diagnostic >&2", crypto.randomUUID());
  const result = await run(frame.command);
  for (const raw of [
    result.raw.replace(frame.nonce, crypto.randomUUID()),
    result.raw.replace(" DATA stdout 0 ", " DATA stdout 1 "),
    result.raw.replace("\x01\x01\x01", "\x02\x02\x02"),
    result.raw.replace("EOF stdout", "EOF bogus"),
    result.raw.replace(/(EOF stdout \d+ \d+ )[a-f0-9]/u, "$1z"),
    result.raw + result.raw,
    result.raw.replace("DATA stdout", "FAKE stdout"),
    result.raw.replace(" DATA stdout 0 8 ", " DATA stdout 0 9 "),
    result.raw.replace(/( DATA stdout \d+ \d+ )[^\n]+/u, "$1%%%"),
    result.raw.replace(/( EOF stdout \d+ )\d+/u, "$1999"),
    result.raw.replace(" EXIT 0", " EXIT 1.5"),
    result.raw.replace(/(\x01\x01\x01[^\n]+ START\n)/u, "$1$1"),
  ])
    expect(() => frame.decode(raw, result.exitCode)).toThrow();
});

test("byte-valid native frames reject malformed original UTF8 rather than replace it", async () => {
  const frame = daytonaCommandFrames(String.raw`printf '\377'`, crypto.randomUUID());
  const result = await run(frame.command);
  expect(() => frame.decode(result.raw, result.exitCode)).toThrow();
});

test("actual admitted multi-batch source fits the single-argv budget through control and native frames", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-frame-argv-"));
  const sourceBytes: number[] = [];
  const controlledBytes: number[] = [];
  const framedBytes: number[] = [];
  const content = "a".repeat(64_000);
  const service = new SandboxChannelAService({
    workspaceRoot: root,
    session: {
      exec: async (args) => {
        const controlled = cancellableSynchronousShellCommand(
          args.cmd,
          join(root, crypto.randomUUID()),
        );
        const frame = daytonaCommandFrames(controlled, crypto.randomUUID(), root);
        sourceBytes.push(Buffer.byteLength(args.cmd));
        controlledBytes.push(Buffer.byteLength(controlled));
        framedBytes.push(Buffer.byteLength(frame.command));
        const result = await run(frame.command);
        const receipt = frame.decode(result.raw, result.exitCode);
        expect(receipt).not.toBeNull();
        return receipt!;
      },
    },
    emit: async () => {},
  });
  try {
    expect(
      (
        await service.fsWriteFiles({
          directory: "batch",
          files: [
            { path: "one.txt", content },
            { path: "two.txt", content },
          ],
        })
      ).written,
    ).toEqual(["one.txt", "two.txt"]);
    expect(sourceBytes.length).toBeGreaterThan(1);
    expect(Math.max(...sourceBytes)).toBeGreaterThan(WRITE_FILES_COMMAND_MAX_BYTES - 4 * 1024);
    expect(Math.max(...sourceBytes)).toBeLessThanOrEqual(WRITE_FILES_COMMAND_MAX_BYTES);
    expect(Math.max(...controlledBytes)).toBeLessThan(128 * 1024);
    expect(Math.max(...framedBytes)).toBeLessThan(128 * 1024);
    for (const file of ["one.txt", "two.txt"])
      expect(await readFile(join(root, "batch", file), "utf8")).toBe(content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native frames preserve original marker-bound process-group cancellation and stream EOF", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-frame-control-"));
  const marker = join(root, crypto.randomUUID());
  const started = join(root, "started");
  const frame = daytonaCommandFrames(
    cancellableSynchronousShellCommand(
      `printf prefix; printf started > '${started}'; sleep 30`,
      marker,
    ),
    crypto.randomUUID(),
  );
  const pending = run(frame.command);
  let group: number | undefined;
  try {
    for (let i = 0; i < 100; i++) {
      const record = await readFile(marker, "utf8").catch(() => "");
      if (record && (await readFile(started, "utf8").catch(() => "")) === "started") {
        const fields = record.trim().split(" ").map(Number);
        expect(fields).toHaveLength(2);
        expect(fields[0]).toBe(fields[1]);
        expect(Number.isSafeInteger(fields[1]) && fields[1]! > 1).toBe(true);
        group = fields[1];
        break;
      }
      await Bun.sleep(10);
    }
    expect(group).toBeDefined();
    // Only this uniquely marked, validated test-owned process group is killed.
    process.kill(-group!, "SIGTERM");
    const result = await pending;
    group = undefined;
    expect(frame.decode(result.raw, result.exitCode)).toEqual({
      stdout: "prefix",
      stderr: "",
      exitCode: 143,
    });
  } finally {
    if (group) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {}
    }
    await pending;
    await rm(root, { recursive: true, force: true });
  }
});
