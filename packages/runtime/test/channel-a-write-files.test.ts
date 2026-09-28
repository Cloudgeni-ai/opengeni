// SandboxChannelAService.fsWriteFiles against a real host shell. The session
// runs each command through bash in a temporary workspace, so every check,
// hash, and write below executes exactly as it does inside a sandbox.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelAConflictError,
  ChannelAPartialMutationError,
  ChannelAValidationError,
  RoutingSandboxSession,
  SandboxChannelAService,
  type ChannelAExecArgs,
  type ChannelASession,
} from "../src/sandbox";
import {
  parseWriteFilesOutput,
  WRITE_FILES_COMMAND_MAX_CHARS,
} from "../src/sandbox/write-files-script";

setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): { root: string; outside: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "opengeni-write-files-")));
  roots.push(base);
  const root = join(base, "workspace");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return { root, outside };
}

function shellSession(
  root: string,
  beforeExec?: (args: ChannelAExecArgs) => void | Promise<void>,
  env?: () => Record<string, string | undefined>,
): { session: ChannelASession; commands: ChannelAExecArgs[] } {
  const commands: ChannelAExecArgs[] = [];
  return {
    commands,
    session: {
      exec: async (args) => {
        commands.push(args);
        await beforeExec?.(args);
        const child = Bun.spawn(["/bin/bash", "-c", args.cmd], {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
          ...(env ? { env: env() } : {}),
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { stdout, stderr, exitCode };
      },
    },
  };
}

function service(session: ChannelASession, events: unknown[] = []) {
  return new SandboxChannelAService({
    session,
    emit: async (batch) => {
      events.push(...batch);
    },
  });
}

const skillFiles = [
  { path: "SKILL.md", content: "---\nname: demo\ndescription: Demo\n---\n# Demo\n" },
  { path: "scripts/run.py", content: "#!/usr/bin/env python3\nprint('it\\'s \"quoted\" $HOME')\n" },
  { path: "scripts/lib/util.sh", content: "echo 'nested'\n" },
  { path: "references/bom.md", content: "﻿BOM and unicode: æøå \u{1f680}" },
  { path: "empty.txt", content: "" },
];

describe("fsWriteFiles", () => {
  test("creates a nested tree with exact bytes in one command and one change event", async () => {
    const { root } = workspace();
    const { session, commands } = shellSession(root);
    const events: { type: string; payload: { changes: unknown[] } }[] = [];
    const result = await service(session, events as unknown[]).fsWriteFiles({
      directory: "skills/demo",
      files: skillFiles,
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]!.cmd.length).toBeLessThanOrEqual(WRITE_FILES_COMMAND_MAX_CHARS);
    expect(result).toEqual({
      directory: "skills/demo",
      written: skillFiles.map((file) => file.path),
      unchanged: [],
      createdDirectory: true,
      revision: 1,
    });
    for (const file of skillFiles) {
      expect(readFileSync(join(root, "skills/demo", file.path), "utf8")).toBe(file.content);
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("fs.changed");
    expect(events[0]!.payload.changes).toEqual([
      { path: "skills", kind: "created", isDir: true, sizeBytes: null },
      { path: "skills/demo", kind: "created", isDir: true, sizeBytes: null },
      { path: "skills/demo/references", kind: "created", isDir: true, sizeBytes: null },
      { path: "skills/demo/scripts", kind: "created", isDir: true, sizeBytes: null },
      { path: "skills/demo/scripts/lib", kind: "created", isDir: true, sizeBytes: null },
      ...skillFiles.map((file) => ({
        path: `skills/demo/${file.path}`,
        kind: "created",
        isDir: false,
        sizeBytes: Buffer.byteLength(file.content),
      })),
    ]);
  });

  test("repeating the request keeps identical files and only fills in missing ones", async () => {
    const { root } = workspace();
    const { session, commands } = shellSession(root);
    const events: unknown[] = [];
    const svc = service(session, events);
    await svc.fsWriteFiles({ directory: "demo", files: skillFiles });
    rmSync(join(root, "demo/scripts/run.py"));
    const repeated = await svc.fsWriteFiles({ directory: "demo", files: skillFiles });

    expect(commands).toHaveLength(2);
    expect(repeated.written).toEqual(["scripts/run.py"]);
    expect(repeated.unchanged).toEqual(
      skillFiles.map((f) => f.path).filter((p) => p !== "scripts/run.py"),
    );
    expect(repeated.createdDirectory).toBe(false);
    expect(readFileSync(join(root, "demo/scripts/run.py"), "utf8")).toBe(skillFiles[1]!.content);

    const unchanged = await svc.fsWriteFiles({ directory: "demo", files: skillFiles });
    expect(unchanged.written).toEqual([]);
    expect(unchanged.unchanged).toHaveLength(skillFiles.length);
    // Nothing changed, so nothing is announced.
    expect(events).toHaveLength(2);
  });

  test("never overwrites a different existing file and writes nothing else", async () => {
    const { root } = workspace();
    mkdirSync(join(root, "demo/scripts"), { recursive: true });
    writeFileSync(join(root, "demo/scripts/run.py"), "edited by the user\n");
    const { session } = shellSession(root);
    const events: unknown[] = [];

    await expect(
      service(session, events).fsWriteFiles({ directory: "demo", files: skillFiles }),
    ).rejects.toThrow(ChannelAConflictError);
    expect(readFileSync(join(root, "demo/scripts/run.py"), "utf8")).toBe("edited by the user\n");
    expect(existsSync(join(root, "demo/SKILL.md"))).toBe(false);
    expect(existsSync(join(root, "demo/references"))).toBe(false);
    expect(events).toEqual([]);
  });

  test("a same-sized file with different bytes is a conflict", async () => {
    const { root } = workspace();
    mkdirSync(join(root, "demo"));
    writeFileSync(
      join(root, "demo/SKILL.md"),
      "X".repeat(Buffer.byteLength(skillFiles[0]!.content)),
    );
    const { session } = shellSession(root);
    await expect(
      service(session).fsWriteFiles({ directory: "demo", files: [skillFiles[0]!] }),
    ).rejects.toThrow("different content");
  });

  test("refuses symbolic links on the path and paths that leave the workspace", async () => {
    const { root, outside } = workspace();
    symlinkSync(outside, join(root, "escape"));
    mkdirSync(join(root, "inside"));
    symlinkSync(join(root, "inside"), join(root, "alias"));
    mkdirSync(join(root, "demo"));
    symlinkSync(join(outside, "target.md"), join(root, "demo/SKILL.md"));
    const { session } = shellSession(root);
    const svc = service(session);

    await expect(
      svc.fsWriteFiles({ directory: "escape/skill", files: skillFiles }),
    ).rejects.toThrow(ChannelAValidationError);
    await expect(svc.fsWriteFiles({ directory: "alias", files: skillFiles })).rejects.toThrow(
      "symbolic link",
    );
    // A dangling symlink at a file path is never followed or replaced.
    await expect(svc.fsWriteFiles({ directory: "demo", files: [skillFiles[0]!] })).rejects.toThrow(
      ChannelAConflictError,
    );
    expect(existsSync(join(outside, "target.md"))).toBe(false);
    expect(existsSync(join(outside, "skill"))).toBe(false);
  });

  test("rejects unsafe or ambiguous requests before running a command", async () => {
    const { root } = workspace();
    const { session, commands } = shellSession(root);
    const svc = service(session);
    const one = [{ path: "a.txt", content: "a" }];
    for (const directory of ["../up", "/abs", "a/./b", "a//b", "a\\b", ""]) {
      await expect(svc.fsWriteFiles({ directory, files: one })).rejects.toThrow(
        ChannelAValidationError,
      );
    }
    await expect(svc.fsWriteFiles({ directory: "d", files: [...one, ...one] })).rejects.toThrow(
      "duplicate",
    );
    await expect(
      svc.fsWriteFiles({
        directory: "d",
        files: [
          { path: "x", content: "file" },
          { path: "x/y", content: "child" },
        ],
      }),
    ).rejects.toThrow("both a file and a directory");
    await expect(svc.fsWriteFiles({ directory: "d", files: [] })).rejects.toThrow("required");
    expect(commands).toEqual([]);
  });

  test("splits a large request into checked batches under the command budget", async () => {
    const { root } = workspace();
    const { session, commands } = shellSession(root);
    // Providers move a file too large for one command out of band.
    const outOfBand: string[] = [];
    session.writeFile = async ({ path, content }) => {
      outOfBand.push(path);
      writeFileSync(join(root, path), content);
    };
    const files = Array.from({ length: 5 }, (_, index) => ({
      path: `data/part-${index}.txt`,
      content: `${index}`.repeat(30_000),
    }));
    // Larger than one command: written through the single-file path.
    files.push({ path: "data/huge.txt", content: "h".repeat(100_000) });
    const result = await service(session).fsWriteFiles({ directory: "big", files });

    expect(result.written).toEqual(files.map((file) => file.path));
    for (const file of files) {
      expect(readFileSync(join(root, "big", file.path), "utf8")).toBe(file.content);
    }
    for (const command of commands) {
      expect(command.cmd.length).toBeLessThanOrEqual(WRITE_FILES_COMMAND_MAX_CHARS);
    }
    // One read-only check, then several write batches.
    expect(commands.length).toBeGreaterThan(2);
    expect(outOfBand).toEqual(["big/data/huge.txt"]);

    const repeated = await service(session).fsWriteFiles({ directory: "big", files });
    expect(repeated.unchanged).toHaveLength(files.length);
  });

  test("a new directory holding only large files still counts as created", async () => {
    const { root } = workspace();
    const { session } = shellSession(root);
    session.writeFile = async ({ path, content }) => {
      writeFileSync(join(root, path), content);
    };
    const events: { payload: { changes: { path: string; isDir: boolean }[] } }[] = [];
    const content = "x".repeat(70_000);
    const result = await service(session, events as unknown[]).fsWriteFiles({
      directory: "skills/large",
      files: [{ path: "SKILL.md", content }],
    });

    // A complete checkout into a directory it created is a publish base.
    expect(result).toMatchObject({ written: ["SKILL.md"], createdDirectory: true });
    expect(readFileSync(join(root, "skills/large/SKILL.md"), "utf8")).toBe(content);
    expect(
      events.flatMap((event) => event.payload.changes.filter((change) => change.isDir)),
    ).toEqual([
      { path: "skills", kind: "created", isDir: true, sizeBytes: null },
      { path: "skills/large", kind: "created", isDir: true, sizeBytes: null },
    ]);
  });

  test("a later batch conflict reports the partial write and a repeat finishes it", async () => {
    const { root } = workspace();
    const files = Array.from({ length: 4 }, (_, index) => ({
      path: `part-${index}.txt`,
      content: `${index}`.repeat(40_000),
    }));
    let writes = 0;
    const { session } = shellSession(root, (args) => {
      // Check-mode commands report missing files; write batches do not.
      if (args.cmd.includes("__OGF_M__")) return;
      writes += 1;
      // Another writer creates a file after the check, before its batch runs.
      if (writes === 2) writeFileSync(join(root, "big/part-3.txt"), "someone else");
    });
    const svc = service(session);
    const failure = await svc.fsWriteFiles({ directory: "big", files }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ChannelAPartialMutationError);
    expect((failure as Error & { cause?: unknown }).cause).toBeInstanceOf(ChannelAConflictError);
    expect(readFileSync(join(root, "big/part-3.txt"), "utf8")).toBe("someone else");

    rmSync(join(root, "big/part-3.txt"));
    const repeated = await svc.fsWriteFiles({ directory: "big", files });
    expect(repeated.written.length + repeated.unchanged.length).toBe(files.length);
    for (const file of files) {
      expect(readFileSync(join(root, "big", file.path), "utf8")).toBe(file.content);
    }
  });

  test("a failed or short write removes its own file so a repeat finishes the tree", async () => {
    const { root, outside } = workspace();
    // A base64 that stops early, as a full disk would. It fails on its third
    // call so two files are complete before the batch stops.
    const bin = join(outside, "bin");
    mkdirSync(bin);
    const counter = join(outside, "calls");
    writeFileSync(
      join(bin, "base64"),
      `#!/bin/sh\nn=$(($(cat "${counter}" 2>/dev/null || echo 0) + 1))\necho "$n" > "${counter}"\nif [ "$n" = "$OG_FAIL_AT" ]; then head -c 3; exit "$OG_FAIL_STATUS"; fi\nexec /usr/bin/base64 "$@"\n`,
      { mode: 0o755 },
    );
    let failure: { at: string; status: string } | null = null;
    const { session } = shellSession(root, undefined, () =>
      failure
        ? {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            OG_FAIL_AT: failure.at,
            OG_FAIL_STATUS: failure.status,
          }
        : { ...process.env },
    );
    const svc = service(session);
    for (const [status, directory] of [
      // base64 reports the failure.
      ["1", "failed"],
      // base64 exits cleanly after a short write; the size check catches it.
      ["0", "short"],
    ] as const) {
      rmSync(counter, { force: true });
      failure = { at: "3", status };
      const error = await svc.fsWriteFiles({ directory, files: skillFiles }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ChannelAPartialMutationError);
      expect(existsSync(join(root, directory, skillFiles[1]!.path))).toBe(true);
      // The interrupted file is gone rather than left truncated.
      expect(existsSync(join(root, directory, skillFiles[2]!.path))).toBe(false);

      failure = null;
      const repeated = await svc.fsWriteFiles({ directory, files: skillFiles });
      expect(repeated.unchanged).toEqual([skillFiles[0]!.path, skillFiles[1]!.path]);
      for (const file of skillFiles) {
        expect(readFileSync(join(root, directory, file.path), "utf8")).toBe(file.content);
      }
    }
  });

  test("a routed session admits one workspace mutation for the whole tree", async () => {
    const { root } = workspace();
    const { session: shell } = shellSession(root);
    const operations: string[] = [];
    let admissions = 0;
    let settlements = 0;
    const routing = new RoutingSandboxSession({
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
      resolveActiveBackend: async () => ({
        session: shell as never,
        sandboxId: null,
        kind: "docker",
        leaseEpoch: 1,
        providerInstanceId: "instance",
        activeEpoch: 0,
      }),
      onOperation: ({ op }) => operations.push(op),
      beforeMutation: async () => {
        admissions += 1;
        return {};
      },
      afterMutation: async () => {
        settlements += 1;
      },
    });
    const files = Array.from({ length: 11 }, (_, index) => ({
      path: index === 0 ? "SKILL.md" : `scripts/tool_${index}.py`,
      content: `# Usage: python tool_${index}.py\n${"x = 1\n".repeat(400)}`,
    }));
    const svc = service(routing as unknown as ChannelASession);
    await svc.fsWriteFiles({ directory: "skills/analytics", files });
    expect({ operations, admissions, settlements }).toEqual({
      operations: ["exec"],
      admissions: 1,
      settlements: 1,
    });
    const repeated = await svc.fsWriteFiles({ directory: "skills/analytics", files });
    expect(repeated.unchanged).toHaveLength(files.length);
    expect(admissions).toBe(2);
  });

  test("works through a banner-only command surface such as Modal's", async () => {
    const { root } = workspace();
    const { session: shell } = shellSession(root);
    const session: ChannelASession = {
      execCommand: async (args) => {
        const result = await shell.exec!(args);
        return [
          "Chunk ID: banner",
          "Wall time: 0.0100 seconds",
          `Process exited with code ${result.exitCode}`,
          "Output:",
          `${result.stdout}${result.stderr}`,
        ].join("\n");
      },
    };
    const result = await service(session).fsWriteFiles({ directory: "demo", files: skillFiles });
    expect(result.written).toHaveLength(skillFiles.length);
    await expect(
      service(session).fsWriteFiles({
        directory: "demo",
        files: [{ path: "SKILL.md", content: "different" }],
      }),
    ).rejects.toThrow(ChannelAConflictError);
  });

  test("markers parse even when a provider drops newline bytes", () => {
    const output = parseWriteFilesOutput(
      "__OGF_D__0____OGF_S__1____OGF_W__2____OPENGENI_FS_BATCH_OK__",
    );
    expect(output).toMatchObject({
      complete: true,
      createdDirectories: [0],
      same: [1],
      written: [2],
      failure: null,
    });
    expect(parseWriteFilesOutput("__OGF_W__0____OPENGENI_FS_CONFLICT__F3__").failure).toEqual({
      code: "CONFLICT",
      target: { kind: "file", index: 3 },
    });
    expect(parseWriteFilesOutput("__OPENGENI_FS_NOT_FOUND__").failure).toEqual({
      code: "NOT_FOUND",
      target: null,
    });
  });
});
