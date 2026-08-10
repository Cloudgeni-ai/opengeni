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

    const result = await Bun.build({
      entrypoints: [entrypoint],
      outdir,
      target: "bun",
      format: "esm",
      splitting: true,
      minify: { syntax: true, whitespace: true, identifiers: false },
      external: ["@llamaindex/liteparse", "sharp"],
    });
    expect(result.success, result.logs.map(String).join("\n")).toBe(true);

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
