import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(import.meta.dir, "..");

/** A closed list of pinned package files, not a runtime installer or archive. */
export async function stageCuaRuntime(architecture: string): Promise<string> {
  if (process.platform !== "darwin" || !["x64", "arm64"].includes(architecture)) {
    throw new Error("CUA release packaging is currently macOS x64/arm64 only");
  }
  const sdkEntry = fileURLToPath(import.meta.resolve("@trycua/cua-driver"));
  const require = createRequire(sdkEntry);
  const sdkPackage = JSON.parse(
    await readFile(join(dirname(sdkEntry), "..", "package.json"), "utf8"),
  ) as { version: string };
  const nativeName = `@trycua/cua-driver-darwin-${architecture}`;
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
  for (const file of ["LICENSE.md", "THIRD-PARTY-NOTICES.md"]) {
    await copyFile(join(packageRoot, "src", "cua", file), join(sdkDirectory, file));
    assets.push(`cua-sdk/${file}`);
  }
  for (const file of [
    "package.json",
    "libcua_driver_sdk.dylib",
    "cua_driver_node_runtime.node",
    "node-runtime-NOTICE.md",
  ]) {
    const path = join(nativeDirectory, file);
    await copyFile(join(dirname(nativePackagePath), file), path);
    if (file.endsWith(".dylib") || file.endsWith(".node")) {
      for (const args of [
        ["--force", "--sign", "-", "--timestamp=none", path],
        ["--verify", "--strict", path],
      ]) {
        const signed = Bun.spawn(["codesign", ...args], { stdout: "inherit", stderr: "inherit" });
        if ((await signed.exited) !== 0)
          throw new Error(`CUA native asset signing failed: ${file}`);
      }
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

if (import.meta.main) {
  console.log(await stageCuaRuntime(process.argv[2] ?? process.arch));
}
