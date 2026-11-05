import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const SCRIPT = "docker/check-default-commands.sh";
const scriptPath = resolve(root, SCRIPT);
// Absolute shells: the checked PATH below is a stub directory with its own sh.
const SH = Bun.which("sh")!;
const BASH = Bun.which("bash")!;

/** The default images: headless (compute, Docker) and desktop (Modal, compute desktop tier). */
const DOCKERFILES = ["docker/sandbox.Dockerfile", "docker/desktop.Dockerfile"] as const;

/** The check, as both images run it after everything else is installed. */
const CHECK_STEP =
  "RUN --mount=type=bind,source=docker/check-default-commands.sh,target=/opt/opengeni-check/check-default-commands.sh \\\n" +
  "    sh /opt/opengeni-check/check-default-commands.sh\n";

/**
 * Commands agents were seen reaching for on Opengeni's own images without
 * finding them, plus the core tools the images already shipped. Removing one
 * from the list needs a reason, not just an image change.
 */
const REQUIRED = [
  "bun",
  "bunx",
  "node",
  "npm",
  "npx",
  "python3",
  "pip",
  "uv",
  "ogtool",
  "anydoc",
  "git",
  "curl",
  "wget",
  "jq",
  "rg",
  "time",
  "zip",
  "unzip",
  "ss",
  "ip",
  "file",
  "strings",
  "xxd",
  "uuidgen",
  "pdftotext",
  "ps",
];

/** Debian packages behind the commands this change added to the images. */
const PACKAGES = ["time", "zip", "iproute2", "binutils", "file", "xxd", "bc", "patch"];

async function run(
  argv: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function listed(): Promise<string[]> {
  const result = await run([SH, scriptPath, "--list"], { PATH: process.env.PATH ?? "" });
  expect(result.exitCode).toBe(0);
  return result.stdout.split("\n").filter(Boolean);
}

/** The image's last stage: everything after the last FROM. */
function finalStage(source: string): string {
  const starts = [...source.matchAll(/^FROM /gmu)].map((match) => match.index!);
  return source.slice(starts.at(-1));
}

/** A PATH directory with an executable stub for each name. */
async function stubPath(names: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opengeni-default-commands-"));
  for (const name of names) {
    await writeFile(join(directory, name), "#!/bin/sh\nexit 0\n");
    await chmod(join(directory, name), 0o755);
  }
  return directory;
}

describe("default sandbox commands", () => {
  test("the list covers the commands agents reach for, once each", async () => {
    const names = await listed();
    expect(new Set(names).size).toBe(names.length);
    for (const name of REQUIRED)
      expect({ name, listed: names.includes(name) }).toEqual({ name, listed: true });
  });

  test("both default images run the check as their last build step", async () => {
    for (const path of DOCKERFILES) {
      const stage = finalStage(await readFile(resolve(root, path), "utf8"));
      const check = stage.indexOf(CHECK_STEP);
      expect({ path, check: check >= 0 }).toEqual({ path, check: true });
      // Nothing installed or removed after the check can escape it.
      const after = stage.slice(check + CHECK_STEP.length);
      expect({ path, laterSteps: after.match(/^(?:RUN|COPY|ADD) /gmu) ?? [] }).toEqual({
        path,
        laterSteps: [],
      });
    }
  });

  test("both default images install the added tools and link bunx to bun", async () => {
    for (const path of DOCKERFILES) {
      const stage = finalStage(await readFile(resolve(root, path), "utf8"));
      for (const name of PACKAGES) {
        expect({ path, name, installed: new RegExp(`\\s${name}\\s`, "u").test(stage) }).toEqual({
          path,
          name,
          installed: true,
        });
      }
      expect(stage).toContain("ln -s bun /usr/local/bin/bunx");
    }
  });

  test("the headless image ships npm and npx from its pinned Node release", async () => {
    const stage = finalStage(await readFile(resolve(root, "docker/sandbox.Dockerfile"), "utf8"));
    expect(stage).toContain(
      "COPY --from=node-target /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm",
    );
    expect(stage).toContain("ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm");
    expect(stage).toContain("ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx");
  });

  test("a missing command fails the check and is named", async () => {
    const names = await listed();
    const directory = await stubPath(names.filter((name) => name !== "bunx" && name !== "ss"));
    try {
      const result = await run([SH, scriptPath], { PATH: directory });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("default sandbox commands missing from this image: bunx ss\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a dangling link or a shell keyword does not count as the command", async () => {
    const names = await listed();
    const directory = await stubPath(names.filter((name) => name !== "ogtool" && name !== "time"));
    try {
      await symlink(join(directory, "no-such-ogtool.cjs"), join(directory, "ogtool"));
      // bash's `time` keyword answers `command -v time` without GNU time installed.
      for (const shell of [SH, BASH]) {
        const result = await run([shell, scriptPath], { PATH: directory });
        expect({ shell, exitCode: result.exitCode, stderr: result.stderr }).toEqual({
          shell,
          exitCode: 1,
          stderr: "default sandbox commands missing from this image: ogtool time\n",
        });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("an unknown argument is a usage error", async () => {
    const result = await run([SH, scriptPath, "--all"], { PATH: process.env.PATH ?? "" });
    expect(result.exitCode).toBe(2);
  });
});
