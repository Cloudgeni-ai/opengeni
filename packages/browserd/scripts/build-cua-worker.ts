import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Pin the source we tested, including fixes newer than the published SDK.
// A pin that changes a tool's schema also needs the affected platform catalogs
// regenerated (scripts/generate-cua-desktop-tools.ts) and their byte and sha256
// pins in scripts/check-public-repo-hygiene.ts updated: native calls are refused
// when the worker's schema differs from the bundled one.
export const cuaSourceRevision = "67f4773671a9f20d12491c9c8584067951eee2b0";
const repository = "https://github.com/Cloudgeni-ai/cua.git";

export async function buildCuaWorker(architecture: string): Promise<string> {
  if (
    !["darwin", "linux", "win32"].includes(process.platform) ||
    !["x64", "arm64"].includes(architecture) ||
    (process.platform !== "darwin" && architecture !== process.arch)
  )
    throw new Error("CUA worker packaging requires macOS x64/arm64 or native Linux or Windows");
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
  if (
    !process.env.OPENGENI_CUA_SOURCE_DIR &&
    !(await Bun.file(join(source, ".git/HEAD")).exists())
  ) {
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
  const path = join(
    rust,
    "target",
    ...(cross ? [target] : []),
    "release",
    process.platform === "win32" ? "cua-driver.exe" : "cua-driver",
  );
  await readFile(path); // Require the complete executable before staging anything.
  return path;
}

if (import.meta.main) console.log(await buildCuaWorker(process.argv[2] ?? process.arch));
