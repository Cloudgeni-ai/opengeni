import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Pin the source we tested, including fixes newer than the published SDK.
export const cuaSourceRevision = "35e376ed509cb8eee49624279256a81da83df8cc";
const repository = "https://github.com/trycua/cua.git";

export async function buildCuaWorker(architecture: string): Promise<string> {
  if (process.platform !== "darwin" || !["x64", "arm64"].includes(architecture))
    throw new Error("CUA worker packaging requires macOS x64/arm64");
  const source = resolve(
    process.env.OPENGENI_CUA_SOURCE_DIR ??
      join(import.meta.dir, "../dist/cua-source", cuaSourceRevision),
  );
  await mkdir(source, { recursive: true });
  const run = async (args: string[], cwd = source): Promise<string> => {
    const child = Bun.spawn(args, {
      cwd,
      env: {
        ...process.env,
        RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN ?? "stable",
      },
      stdout: "pipe",
      stderr: "inherit",
    });
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) throw new Error(`CUA build failed: ${args[0]}`);
    return output.trim();
  };
  if (!(await Bun.file(join(source, ".git/HEAD")).exists())) {
    await run(["git", "init"]);
    await run(["git", "remote", "add", "origin", repository]);
    await run([
      "git",
      "sparse-checkout",
      "set",
      "libs/cua-driver",
      "libs/cua/crates",
      "libs/images",
    ]);
    await run(["git", "fetch", "--depth=1", "origin", cuaSourceRevision]);
    await run(["git", "checkout", "--detach", "FETCH_HEAD"]);
  }
  if (
    (await run(["git", "rev-parse", "HEAD"])) !== cuaSourceRevision ||
    (await run(["git", "status", "--porcelain", "--untracked-files=no"]))
  )
    throw new Error("CUA source must be the unmodified pinned revision");

  const rust = join(source, "libs/cua-driver/rust");
  const target = architecture === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  // Native builds can reuse Cargo's normal cache; release CI also builds the other architecture.
  const cross = architecture !== process.arch;
  await run(
    [
      "cargo",
      "build",
      "--locked",
      "--release",
      "-p",
      "cua-driver",
      ...(cross ? ["--target", target] : []),
    ],
    rust,
  );
  const path = join(rust, "target", ...(cross ? [target] : []), "release/cua-driver");
  await readFile(path); // Require the complete executable before staging anything.
  return path;
}

if (import.meta.main) console.log(await buildCuaWorker(process.argv[2] ?? process.arch));
