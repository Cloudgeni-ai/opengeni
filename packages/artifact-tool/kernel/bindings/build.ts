import { copyFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveCurrentArtifactRuntimeTarget } from "../../src/runtime-cli";
import { writeArtifactKernelBuildReceipt } from "./package-receipt";

const root = import.meta.dir;
const output = resolve(process.env.OPENGENI_ARTIFACT_BINDINGS_OUT ?? join(root, "dist"));
const protocol = join(root, "protocol");
const napi = join(root, "napi");
const wasm = join(root, "wasm");

requireTool("bun", "Install Bun and rerun this build with `bun run .../bindings/build.ts`.");
requireTool("cargo", "Install the pinned Rust toolchain.");
requireTool("rustup", "Install rustup and the repository's pinned Rust toolchain.");
requireTool(
  "wasm-bindgen",
  "Install the Cargo.lock-matched CLI. The WASM build script prints the exact command.",
);
await requireSuccessful(
  ["cargo", "fmt", "--version"],
  "rustfmt is required. Run: rustup component add rustfmt",
);
await requireSuccessful(
  ["cargo", "clippy", "--version"],
  "Clippy is required. Run: rustup component add clippy",
);

const installedTargets = await capture(["rustup", "target", "list", "--installed"]);
if (!installedTargets.split(/\s+/).includes("wasm32-unknown-unknown")) {
  throw new Error(
    "Missing Rust target wasm32-unknown-unknown. Run: rustup target add wasm32-unknown-unknown",
  );
}

await run(["bun", "test", join(root, "spreadsheet-adapter.test.ts")]);
await run([
  "bun",
  "x",
  "tsc",
  "--noEmit",
  "--ignoreConfig",
  "--strict",
  "--target",
  "es2022",
  "--module",
  "esnext",
  "--moduleResolution",
  "bundler",
  "--types",
  "bun",
  join(root, "build.ts"),
  join(root, "verify.ts"),
  join(root, "package-receipt.ts"),
  join(root, "spreadsheet-adapter.ts"),
  join(root, "spreadsheet-adapter.test.ts"),
  join(wasm, "scripts", "smoke.ts"),
  join(wasm, "scripts", "smoke-modality.ts"),
  join(wasm, "scripts", "benchmark.ts"),
]);

await run(["cargo", "fmt", "--manifest-path", join(protocol, "Cargo.toml"), "--check"]);
await run(["cargo", "test", "--locked", "--manifest-path", join(protocol, "Cargo.toml")]);
await run([
  "cargo",
  "clippy",
  "--locked",
  "--manifest-path",
  join(protocol, "Cargo.toml"),
  "--all-targets",
  "--",
  "-D",
  "warnings",
]);
await run(["cargo", "fmt", "--manifest-path", join(napi, "Cargo.toml"), "--check"]);
await run([
  "cargo",
  "test",
  "--locked",
  "--manifest-path",
  join(napi, "Cargo.toml"),
  "--features",
  "noop",
]);
await run([
  "cargo",
  "clippy",
  "--locked",
  "--manifest-path",
  join(napi, "Cargo.toml"),
  "--all-targets",
  "--features",
  "noop",
  "--",
  "-D",
  "warnings",
]);
await run(["cargo", "build", "--locked", "--manifest-path", join(napi, "Cargo.toml"), "--release"]);

const nativeTarget = resolveCurrentArtifactRuntimeTarget();
const nativeDirectory = join(output, "native", nativeTarget);
await rm(nativeDirectory, { recursive: true, force: true });
await mkdir(nativeDirectory, { recursive: true });
const nativeSource = join(napi, "target", "release", nativeLibraryName());
const nativeOutput = join(nativeDirectory, "opengeni_artifact_kernel.node");
await copyFile(nativeSource, nativeOutput);
await run(["bun", "run", join(napi, "scripts", "smoke.mjs")], {
  OPENGENI_ARTIFACT_KERNEL_NATIVE_PATH: nativeOutput,
});

await run(["sh", join(wasm, "scripts", "check.sh")]);
await rm(join(output, "wasm-web"), { recursive: true, force: true });
await rm(join(output, "wasm-bundler"), { recursive: true, force: true });
await run(["sh", join(wasm, "scripts", "build.sh"), "web", join(output, "wasm-web")]);
for (const modality of ["spreadsheet", "document", "presentation"] as const) {
  await run(["sh", join(wasm, "scripts", "build.sh"), "web", join(output, "wasm-web"), modality]);
}
await run(["bun", "run", join(root, "verify.ts")], {
  OPENGENI_ARTIFACT_KERNEL_NATIVE_PATH: nativeOutput,
  OPENGENI_ARTIFACT_KERNEL_WASM_WEB_DIR: join(output, "wasm-web"),
});
await writeArtifactKernelBuildReceipt(nativeTarget, output);
await writeArtifactKernelBuildReceipt("wasm-web", output);

console.log(`Artifact bindings built and verified: ${output}`);

function requireTool(name: string, help: string): string {
  const path = Bun.which(name);
  if (!path) throw new Error(`Missing required tool ${name}. ${help}`);
  return path;
}

function nativeLibraryName(): string {
  if (process.platform === "darwin") return "libopengeni_artifact_kernel_napi.dylib";
  if (process.platform === "linux") return "libopengeni_artifact_kernel_napi.so";
  if (process.platform === "win32") return "opengeni_artifact_kernel_napi.dll";
  throw new Error(`Unsupported native build platform: ${process.platform}`);
}

async function run(command: string[], environment: Record<string, string> = {}): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: root,
    env: { ...process.env, ...environment },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
}

async function capture(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "inherit" });
  const capturedOutput = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
  return capturedOutput;
}

async function requireSuccessful(command: string[], help: string): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, stdout: "ignore", stderr: "ignore" });
  if ((await child.exited) !== 0) throw new Error(help);
}
