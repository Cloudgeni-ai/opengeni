import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ThinkingOrbProps } from "thinking-orbs";
import type { GenieLoadingOptions } from "../src/timeline/genie-loading";

test("loading options preserve the supported renderer prop contract", () => {
  type PublicOptions = NonNullable<GenieLoadingOptions["orb"]>;
  type RendererOptions = Pick<ThinkingOrbProps, "state" | "size" | "speed">;
  type Equal = [PublicOptions] extends [RendererOptions]
    ? [RendererOptions] extends [PublicOptions]
      ? true
      : false
    : false;
  const equal: Equal = true;
  expect(equal).toBe(true);
});

test("loading declarations do not expose the private renderer dependency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "genie-declaration-"));
  try {
    const compiler = Bun.spawn({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, "../../../node_modules/typescript/bin/tsc"),
        "--ignoreConfig",
        "--noCheck",
        "--declaration",
        "--emitDeclarationOnly",
        "--jsx",
        "react-jsx",
        "--target",
        "esnext",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
        "--rootDir",
        "src",
        "--outDir",
        directory,
        "src/timeline/genie-loading.tsx",
      ],
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      compiler.exited,
      new Response(compiler.stdout).text(),
      new Response(compiler.stderr).text(),
    ]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
    const declaration = await readFile(join(directory, "timeline/genie-loading.d.ts"), "utf8");
    expect(declaration).not.toContain("thinking-orbs");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
