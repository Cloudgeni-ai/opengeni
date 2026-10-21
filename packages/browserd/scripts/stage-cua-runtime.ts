import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCuaWorker, cuaSourceRevision } from "./build-cua-worker";

const packageRoot = resolve(import.meta.dir, "..");

/** A closed list of pinned package files, not a runtime installer or archive.
 * macOS and Linux carry the source-built private worker; Windows runs the
 * published SDK's native runtime in process (see src/cua/sdk.ts). */
export async function stageCuaRuntime(architecture: string): Promise<string> {
  if (
    !["darwin", "linux", "win32"].includes(process.platform) ||
    !["x64", "arm64"].includes(architecture) ||
    (process.platform !== "darwin" && architecture !== process.arch)
  ) {
    throw new Error("CUA release packaging requires macOS x64/arm64 or native Linux or Windows");
  }
  const windows = process.platform === "win32";
  const sdkEntry = fileURLToPath(import.meta.resolve("@trycua/cua-driver"));
  const require = createRequire(sdkEntry);
  const sdkPackage = JSON.parse(
    await readFile(join(dirname(sdkEntry), "..", "package.json"), "utf8"),
  ) as { version: string };
  const nativeName = `@trycua/cua-driver-${process.platform}-${architecture}${
    process.platform === "linux" ? "-gnu" : windows ? "-msvc" : ""
  }`;
  const nativePackagePath = require.resolve(`${nativeName}/package.json`);
  const nativePackage = JSON.parse(await readFile(nativePackagePath, "utf8")) as {
    name: string;
    version: string;
  };
  if (nativePackage.name !== nativeName || nativePackage.version !== sdkPackage.version) {
    throw new Error("CUA SDK and native package revisions differ");
  }
  const output = join(packageRoot, "dist", "cua", architecture);
  const sdkDirectory = join(output, "cua-sdk");
  await mkdir(sdkDirectory, { recursive: true });
  const bundled = await Bun.build({
    entrypoints: [sdkEntry],
    target: "bun",
    outdir: sdkDirectory,
    naming: "index.js",
  });
  if (!bundled.success || bundled.outputs.length !== 1) {
    throw new AggregateError(
      bundled.logs,
      "CUA SDK must produce one self-contained JavaScript module",
    );
  }
  const nativeDirectory = join(output, "node_modules", nativeName);
  await mkdir(nativeDirectory, { recursive: true });
  const assets = ["cua-sdk/index.js"];
  if (!windows) {
    const worker = join(output, "cua-driver");
    await copyFile(await buildCuaWorker(architecture), worker);
    await signMacAsset(worker);
    await Bun.write(
      join(output, "cua-source.json"),
      JSON.stringify({ revision: cuaSourceRevision }),
    );
    assets.push("cua-driver", "cua-source.json");
  }
  for (const file of ["LICENSE.md", "THIRD-PARTY-NOTICES.md"]) {
    await copyFile(join(packageRoot, "src", "cua", file), join(sdkDirectory, file));
    assets.push(`cua-sdk/${file}`);
  }
  for (const file of [
    "package.json",
    process.platform === "linux"
      ? "libcua_driver_sdk.so"
      : windows
        ? "cua_driver_sdk.dll"
        : "libcua_driver_sdk.dylib",
    "cua_driver_node_runtime.node",
    "node-runtime-NOTICE.md",
  ]) {
    const path = join(nativeDirectory, file);
    await copyFile(join(dirname(nativePackagePath), file), path);
    if (file.endsWith(".dylib") || file.endsWith(".node")) {
      if (process.platform === "darwin") await thinMacNativeAsset(path, architecture);
      await signMacAsset(path);
    }
    assets.push(`node_modules/${nativeName}/${file}`);
  }
  // Cargo embeds these exact, already-signed files in the normal agent envelope.
  const manifest = join(output, "embedded.rs");
  await Bun.write(
    manifest,
    `[\n${assets.map((name) => `    (${JSON.stringify(name)}, include_bytes!(${JSON.stringify(join(output, name))}) as &[u8]),`).join("\n")}\n]\n`,
  );
  return manifest;
}

/** Upstream architecture-named packages can contain universal binaries. Each
 * agent slice embeds only its matching native slice, then signs the result. */
export async function thinMacNativeAsset(path: string, architecture: string): Promise<void> {
  const target = architecture === "x64" ? "x86_64" : architecture === "arm64" ? "arm64" : null;
  if (!target) throw new Error(`Unsupported macOS CUA architecture: ${architecture}`);
  const lipo = async (...args: string[]): Promise<string> => {
    const child = Bun.spawn(["lipo", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`CUA native asset thinning failed: ${stderr.trim()}`);
    return stdout.trim();
  };
  const architectures = (await lipo("-archs", path)).split(/\s+/);
  if (!architectures.includes(target)) {
    throw new Error(`CUA native asset does not contain required architecture ${target}`);
  }
  if (architectures.length > 1) await lipo(path, "-thin", target, "-output", path);
  if ((await lipo("-archs", path)) !== target) {
    throw new Error(`CUA native asset must contain only ${target}`);
  }
}

async function signMacAsset(path: string): Promise<void> {
  if (process.platform !== "darwin") return;
  for (const args of [
    ["--force", "--sign", "-", "--timestamp=none", path],
    ["--verify", "--strict", path],
  ]) {
    const signed = Bun.spawn(["codesign", ...args], { stdout: "inherit", stderr: "inherit" });
    if ((await signed.exited) !== 0) throw new Error("CUA native asset signing failed");
  }
}

if (import.meta.main) {
  console.log(await stageCuaRuntime(process.argv[2] ?? process.arch));
}
