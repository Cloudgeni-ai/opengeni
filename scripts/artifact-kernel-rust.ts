#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export type ArtifactKernelRustTool = "cargo" | "rustc";

export type ArtifactKernelRustToolchain = Readonly<{
  repositoryRoot: string;
  kernelRoot: string;
  channel: string;
  profile: string;
  targets: readonly string[];
}>;

export type ArtifactKernelRustRequirements = Readonly<{
  targets?: readonly string[];
  components?: readonly string[];
}>;

type RustCommandOptions = Readonly<{
  cwd?: string;
  environment?: Readonly<Record<string, string>>;
  stdin?: "inherit" | "ignore";
  stdout?: "inherit" | "ignore";
  stderr?: "inherit" | "ignore";
}>;

type CapturedCommand = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

const exactChannel = /^\d+\.\d+\.\d+$/u;
const rustupName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;

/** Resolves the artifact kernel's checked-in exact Rust authority. */
export async function resolveArtifactKernelRustToolchain(
  repositoryRoot = resolve(import.meta.dir, ".."),
): Promise<ArtifactKernelRustToolchain> {
  const root = resolve(repositoryRoot);
  const kernelRoot = join(root, "packages", "artifact-tool", "kernel");
  const parsed = Bun.TOML.parse(
    await readFile(join(kernelRoot, "rust-toolchain.toml"), "utf8"),
  ) as {
    toolchain?: { channel?: unknown; profile?: unknown; targets?: unknown };
  };
  const channel = parsed.toolchain?.channel;
  const profile = parsed.toolchain?.profile ?? "minimal";
  const targets = parsed.toolchain?.targets ?? [];
  if (typeof channel !== "string" || !exactChannel.test(channel)) {
    throw new Error("Artifact kernel Rust toolchain channel must be an exact x.y.z version");
  }
  if (typeof profile !== "string" || !rustupName.test(profile)) {
    throw new Error("Artifact kernel Rust toolchain profile is missing or malformed");
  }
  if (!Array.isArray(targets) || targets.some((target) => !validRustupName(target))) {
    throw new Error("Artifact kernel Rust toolchain targets are malformed");
  }
  return Object.freeze({
    repositoryRoot: root,
    kernelRoot,
    channel,
    profile,
    targets: Object.freeze([...new Set(targets)]),
  });
}

/** Installs only missing checked-in toolchain requirements unless explicitly opted out. */
export async function ensureArtifactKernelRustToolchain(
  toolchain: ArtifactKernelRustToolchain,
  requirements: ArtifactKernelRustRequirements = {},
): Promise<void> {
  const rustup = requireRustup();
  const probe = await captureCommand(
    [rustup, "run", toolchain.channel, "rustc", "--version"],
    toolchain.kernelRoot,
    { RUSTUP_AUTO_INSTALL: "0" },
  );
  if (probe.exitCode !== 0) {
    const install = [
      rustup,
      "toolchain",
      "install",
      toolchain.channel,
      "--profile",
      toolchain.profile,
      "--no-self-update",
    ];
    await installOrExplain(
      install,
      toolchain.kernelRoot,
      `Rust ${toolchain.channel} is required by packages/artifact-tool/kernel/rust-toolchain.toml`,
    );
  }
  const rustcVersion = await captureArtifactKernelRustTool(toolchain, "rustc", ["--version"], {
    ensure: false,
  });
  assertArtifactKernelRustcVersion(rustcVersion, toolchain.channel);

  const targets = uniqueRustupNames([...toolchain.targets, ...(requirements.targets ?? [])]);
  if (targets.length > 0) {
    const installed = await captureRustupLines(rustup, toolchain, [
      "target",
      "list",
      "--installed",
      "--toolchain",
      toolchain.channel,
    ]);
    const missing = targets.filter((target) => !installed.has(target));
    if (missing.length > 0) {
      await installOrExplain(
        [rustup, "target", "add", "--toolchain", toolchain.channel, ...missing],
        toolchain.kernelRoot,
        `Rust ${toolchain.channel} is missing artifact-kernel target${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
      );
    }
  }

  const components = uniqueRustupNames(requirements.components ?? []);
  if (components.length > 0) {
    const installed = await captureRustupLines(rustup, toolchain, [
      "component",
      "list",
      "--installed",
      "--toolchain",
      toolchain.channel,
    ]);
    const missing = components.filter(
      (component) =>
        ![...installed].some((entry) => entry === component || entry.startsWith(`${component}-`)),
    );
    if (missing.length > 0) {
      await installOrExplain(
        [rustup, "component", "add", "--toolchain", toolchain.channel, ...missing],
        toolchain.kernelRoot,
        `Rust ${toolchain.channel} is missing artifact-kernel component${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
      );
    }
  }
}

/** Runs Cargo or rustc through the exact checked-in rustup toolchain. */
export async function runArtifactKernelRustTool(
  toolchain: ArtifactKernelRustToolchain,
  tool: ArtifactKernelRustTool,
  args: readonly string[],
  options: RustCommandOptions &
    Readonly<{ ensure?: boolean; requirements?: ArtifactKernelRustRequirements }> = {},
): Promise<void> {
  if (options.ensure !== false) {
    await ensureArtifactKernelRustToolchain(toolchain, options.requirements);
  }
  const rustup = requireRustup();
  const command = [rustup, "run", toolchain.channel, tool, ...args];
  const environment = await artifactKernelRustToolEnvironment(
    rustup,
    toolchain,
    tool,
    options.environment,
  );
  const child = Bun.spawn([...command], {
    cwd: options.cwd ?? toolchain.kernelRoot,
    env: environment,
    stdin: options.stdin ?? "inherit",
    stdout: options.stdout ?? "inherit",
    stderr: options.stderr ?? "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Command failed (${exitCode}): ${renderCommand(command)}`);
}

/** Captures Cargo or rustc output through the exact checked-in rustup toolchain. */
export async function captureArtifactKernelRustTool(
  toolchain: ArtifactKernelRustToolchain,
  tool: ArtifactKernelRustTool,
  args: readonly string[],
  options: Readonly<{
    cwd?: string;
    environment?: Readonly<Record<string, string>>;
    ensure?: boolean;
    requirements?: ArtifactKernelRustRequirements;
  }> = {},
): Promise<string> {
  if (options.ensure !== false) {
    await ensureArtifactKernelRustToolchain(toolchain, options.requirements);
  }
  const rustup = requireRustup();
  const command = [rustup, "run", toolchain.channel, tool, ...args];
  const environment = await artifactKernelRustToolEnvironment(
    rustup,
    toolchain,
    tool,
    options.environment,
  );
  const result = await captureCommand(
    command,
    options.cwd ?? toolchain.kernelRoot,
    environment,
    false,
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Command failed: ${renderCommand(command)}`);
  }
  return result.stdout;
}

export function assertArtifactKernelRustcVersion(
  rustcVersion: string,
  pinnedChannel: string,
): void {
  const [executable, version] = rustcVersion.trim().split(/\s+/u);
  if (executable !== "rustc" || version !== pinnedChannel) {
    throw new Error(
      `Artifact kernel requires Rust ${pinnedChannel}; pinned compiler reported ${rustcVersion.trim() || "<unknown>"}`,
    );
  }
}

async function captureRustupLines(
  rustup: string,
  toolchain: ArtifactKernelRustToolchain,
  args: readonly string[],
): Promise<ReadonlySet<string>> {
  const command = [rustup, ...args];
  const result = await captureCommand(command, toolchain.kernelRoot, { RUSTUP_AUTO_INSTALL: "0" });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Command failed: ${renderCommand(command)}`);
  }
  return new Set(result.stdout.split(/\s+/u).filter(Boolean));
}

async function installOrExplain(
  command: readonly string[],
  cwd: string,
  reason: string,
): Promise<void> {
  if (process.env.RUSTUP_AUTO_INSTALL === "0") {
    throw new Error(
      `${reason}, but RUSTUP_AUTO_INSTALL=0 forbids automatic setup. Install it explicitly with: ${renderCommand(command)}`,
    );
  }
  const child = Bun.spawn([...command], {
    cwd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${reason}. Setup command failed (${exitCode}): ${renderCommand(command)}`);
  }
}

async function captureCommand(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>> = {},
  inheritEnvironment = true,
): Promise<CapturedCommand> {
  const child = Bun.spawn([...command], {
    cwd,
    env: inheritEnvironment ? { ...process.env, ...environment } : environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function artifactKernelRustToolEnvironment(
  rustup: string,
  toolchain: ArtifactKernelRustToolchain,
  tool: ArtifactKernelRustTool,
  overrides: Readonly<Record<string, string>> = {},
): Promise<Record<string, string | undefined>> {
  const environment: Record<string, string | undefined> = { ...process.env, ...overrides };
  if (tool !== "cargo") return environment;

  const [cargo, rustc] = await Promise.all([
    resolveRustupTool(rustup, toolchain, "cargo"),
    resolveRustupTool(rustup, toolchain, "rustc"),
  ]);
  // Explicit Cargo env wins over user config; empty wrapper vars also suppress configured wrappers.
  delete environment.CARGO_BUILD_RUSTC;
  delete environment.CARGO_BUILD_RUSTC_WRAPPER;
  delete environment.CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER;
  environment.CARGO = cargo;
  environment.RUSTC = rustc;
  environment.RUSTC_WRAPPER = "";
  environment.RUSTC_WORKSPACE_WRAPPER = "";
  return environment;
}

async function resolveRustupTool(
  rustup: string,
  toolchain: ArtifactKernelRustToolchain,
  tool: ArtifactKernelRustTool,
): Promise<string> {
  const command = [rustup, "which", "--toolchain", toolchain.channel, tool];
  const result = await captureCommand(
    command,
    toolchain.kernelRoot,
    { ...process.env, RUSTUP_AUTO_INSTALL: "0" },
    false,
  );
  const executable = result.stdout.trim();
  if (result.exitCode !== 0 || !isAbsolute(executable)) {
    throw new Error(
      result.stderr.trim() ||
        `rustup did not resolve an absolute pinned ${tool} executable: ${renderCommand(command)}`,
    );
  }
  return executable;
}

function requireRustup(): string {
  const rustup = Bun.which("rustup", { PATH: process.env.PATH });
  if (!rustup) {
    throw new Error(
      "rustup is required for the artifact kernel so the checked-in exact Rust toolchain can override unrelated cargo/rustc binaries on PATH",
    );
  }
  return rustup;
}

function uniqueRustupNames(values: readonly string[]): readonly string[] {
  if (values.some((value) => !validRustupName(value))) {
    throw new Error("Artifact kernel Rust requirement is malformed");
  }
  return [...new Set(values)];
}

function validRustupName(value: unknown): value is string {
  return typeof value === "string" && rustupName.test(value);
}

function renderCommand(command: readonly string[]): string {
  return command
    .map((part) => (/^[a-zA-Z0-9_./:=+-]+$/u.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

function parseEnsureArguments(args: readonly string[]): ArtifactKernelRustRequirements {
  const targets: string[] = [];
  const components: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value || (name !== "--target" && name !== "--component")) {
      throw new TypeError(`Invalid artifact-kernel Rust ensure option: ${name ?? "<missing>"}`);
    }
    (name === "--target" ? targets : components).push(value);
  }
  return { targets, components };
}

if (import.meta.main) {
  const [operation, ...args] = process.argv.slice(2);
  const toolchain = await resolveArtifactKernelRustToolchain();
  if (operation === "ensure") {
    await ensureArtifactKernelRustToolchain(toolchain, parseEnsureArguments(args));
  } else if (operation === "cargo" || operation === "rustc") {
    await runArtifactKernelRustTool(toolchain, operation, args, { cwd: process.cwd() });
  } else {
    throw new TypeError(
      "usage: bun scripts/artifact-kernel-rust.ts ensure [--target <triple>] [--component <name>] | cargo|rustc [args...]",
    );
  }
}
