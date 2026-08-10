import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

test("bundled document parsing retains the Linux sharp native closure", async () => {
  const temporaryRoot = await mkdtemp(join(root, "apps/worker/.native-closure-"));
  const entrypoint = join(temporaryRoot, "entry.ts");
  const outdir = join(temporaryRoot, "dist");

  try {
    await mkdir(outdir, { recursive: true });
    await writeFile(
      entrypoint,
      `import { LiteParse } from "@llamaindex/liteparse";

new LiteParse({ ocrEnabled: true, numWorkers: 1 });
process.stdout.write("sharp-native-runtime-ready");
`,
    );

    // Bun.build mutates process-global resolver state. Keep the compiler smoke
    // test in a child process so it cannot contaminate later test modules.
    const buildProcess = Bun.spawn({
      cmd: [
        "bun",
        "build",
        entrypoint,
        `--outdir=${outdir}`,
        "--target=bun",
        "--format=esm",
        "--splitting",
        "--minify-syntax",
        "--minify-whitespace",
        "--external=@llamaindex/liteparse",
        "--external=sharp",
      ],
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [buildExitCode, buildStdout, buildStderr] = await Promise.all([
      buildProcess.exited,
      new Response(buildProcess.stdout).text(),
      new Response(buildProcess.stderr).text(),
    ]);
    expect(buildExitCode, `${buildStdout}\n${buildStderr}`).toBe(0);

    const process = Bun.spawn({
      cmd: ["bun", join(outdir, "entry.js")],
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("sharp-native-runtime-ready");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
