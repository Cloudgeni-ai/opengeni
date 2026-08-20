import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  captureArtifactKernelRustTool,
  ensureArtifactKernelRustToolchain,
  resolveArtifactKernelRustToolchain,
} from "./artifact-kernel-rust";

const roots: string[] = [];
const originalPath = process.env.PATH;
const originalAutoInstall = process.env.RUSTUP_AUTO_INSTALL;
const originalRustupLog = process.env.FAKE_RUSTUP_LOG;
const originalDirectLog = process.env.FAKE_DIRECT_LOG;
const originalRustupState = process.env.FAKE_RUSTUP_STATE;
const originalPinnedCargo = process.env.FAKE_PINNED_CARGO;
const originalCargoHome = process.env.CARGO_HOME;
const originalCargo = process.env.CARGO;
const originalRustc = process.env.RUSTC;
const originalCargoBuildRustc = process.env.CARGO_BUILD_RUSTC;
const originalRustcWrapper = process.env.RUSTC_WRAPPER;
const originalCargoBuildRustcWrapper = process.env.CARGO_BUILD_RUSTC_WRAPPER;
const originalRustcWorkspaceWrapper = process.env.RUSTC_WORKSPACE_WRAPPER;
const originalCargoBuildRustcWorkspaceWrapper = process.env.CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER;

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalAutoInstall === undefined) delete process.env.RUSTUP_AUTO_INSTALL;
  else process.env.RUSTUP_AUTO_INSTALL = originalAutoInstall;
  restoreEnvironment("FAKE_RUSTUP_LOG", originalRustupLog);
  restoreEnvironment("FAKE_DIRECT_LOG", originalDirectLog);
  restoreEnvironment("FAKE_RUSTUP_STATE", originalRustupState);
  restoreEnvironment("FAKE_PINNED_CARGO", originalPinnedCargo);
  restoreEnvironment("CARGO_HOME", originalCargoHome);
  restoreEnvironment("CARGO", originalCargo);
  restoreEnvironment("RUSTC", originalRustc);
  restoreEnvironment("CARGO_BUILD_RUSTC", originalCargoBuildRustc);
  restoreEnvironment("RUSTC_WRAPPER", originalRustcWrapper);
  restoreEnvironment("CARGO_BUILD_RUSTC_WRAPPER", originalCargoBuildRustcWrapper);
  restoreEnvironment("RUSTC_WORKSPACE_WRAPPER", originalRustcWorkspaceWrapper);
  restoreEnvironment(
    "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
    originalCargoBuildRustcWorkspaceWrapper,
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artifact kernel Rust toolchain runner", () => {
  test("rejects a floating toolchain channel", async () => {
    const fixture = await createFixture({
      channel: "stable",
      installed: true,
      targetInstalled: true,
    });
    await expect(resolveArtifactKernelRustToolchain(fixture.repositoryRoot)).rejects.toThrow(
      "exact x.y.z version",
    );
  });

  test("ignores wrong direct rustc and cargo binaries earlier on PATH", async () => {
    const fixture = await createFixture({ installed: true, targetInstalled: true });
    const toolchain = await resolveArtifactKernelRustToolchain(fixture.repositoryRoot);

    expect((await captureArtifactKernelRustTool(toolchain, "rustc", ["-Vv"])).trim()).toBe(
      "rustc 1.97.0 (pinned fixture)",
    );
    expect((await captureArtifactKernelRustTool(toolchain, "cargo", ["-V"])).trim()).toBe(
      "cargo 1.97.0 (pinned fixture)",
    );
    expect(await Bun.file(fixture.directLog).exists()).toBe(false);
    const rustupLog = await readFile(fixture.rustupLog, "utf8");
    expect(rustupLog).toContain("run 1.97.0 rustc -Vv");
    expect(rustupLog).toContain("run 1.97.0 cargo -V");
  });

  test("binds Cargo to pinned compiler paths despite ambient and user config overrides", async () => {
    const fixture = await createFixture({ installed: true, targetInstalled: true });
    const toolchain = await resolveArtifactKernelRustToolchain(fixture.repositoryRoot);
    await writeFile(
      join(fixture.cargoHome, "config.toml"),
      `[build]\nrustc = "${fixture.wrongRustc}"\nrustc-wrapper = "${fixture.wrongWrapper}"\nrustc-workspace-wrapper = "${fixture.wrongWrapper}"\n`,
    );
    process.env.CARGO_HOME = fixture.cargoHome;
    process.env.CARGO = fixture.wrongCargo;
    process.env.RUSTC = fixture.wrongRustc;
    process.env.CARGO_BUILD_RUSTC = fixture.wrongRustc;
    process.env.RUSTC_WRAPPER = fixture.wrongWrapper;
    process.env.CARGO_BUILD_RUSTC_WRAPPER = fixture.wrongWrapper;
    process.env.RUSTC_WORKSPACE_WRAPPER = fixture.wrongWrapper;
    process.env.CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER = fixture.wrongWrapper;

    const reportedCompiler = await captureArtifactKernelRustTool(
      toolchain,
      "cargo",
      ["compiler-probe"],
      {
        environment: {
          RUSTC: fixture.wrongRustc,
          CARGO_BUILD_RUSTC: fixture.wrongRustc,
          RUSTC_WRAPPER: fixture.wrongWrapper,
          CARGO_BUILD_RUSTC_WRAPPER: fixture.wrongWrapper,
          RUSTC_WORKSPACE_WRAPPER: fixture.wrongWrapper,
          CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: fixture.wrongWrapper,
        },
      },
    );

    expect(reportedCompiler.trim()).toBe("rustc 1.97.0 (pinned fixture)");
    expect(await Bun.file(fixture.directLog).exists()).toBe(false);
    const rustupLog = await readFile(fixture.rustupLog, "utf8");
    expect(rustupLog).toContain("which --toolchain 1.97.0 cargo");
    expect(rustupLog).toContain("which --toolchain 1.97.0 rustc");
  });

  test("bootstraps a missing exact toolchain and target without changing the default", async () => {
    const fixture = await createFixture({ installed: false, targetInstalled: false });
    const toolchain = await resolveArtifactKernelRustToolchain(fixture.repositoryRoot);

    await ensureArtifactKernelRustToolchain(toolchain);

    const rustupLog = await readFile(fixture.rustupLog, "utf8");
    expect(rustupLog).toContain("toolchain install 1.97.0 --profile minimal --no-self-update");
    expect(rustupLog).toContain("target add --toolchain 1.97.0 wasm32-unknown-unknown");
    expect(rustupLog).not.toContain("default");
    expect(await Bun.file(fixture.directLog).exists()).toBe(false);
  });

  test("bootstraps explicitly requested components on the pinned toolchain", async () => {
    const fixture = await createFixture({ installed: true, targetInstalled: true });
    const toolchain = await resolveArtifactKernelRustToolchain(fixture.repositoryRoot);

    await ensureArtifactKernelRustToolchain(toolchain, { components: ["rustfmt", "clippy"] });

    const rustupLog = await readFile(fixture.rustupLog, "utf8");
    expect(rustupLog).toContain("component add --toolchain 1.97.0 rustfmt clippy");
  });

  test("respects RUSTUP_AUTO_INSTALL=0 with an actionable missing-toolchain error", async () => {
    const fixture = await createFixture({ installed: false, targetInstalled: false });
    process.env.RUSTUP_AUTO_INSTALL = "0";
    const toolchain = await resolveArtifactKernelRustToolchain(fixture.repositoryRoot);

    await expect(ensureArtifactKernelRustToolchain(toolchain)).rejects.toThrow(
      "RUSTUP_AUTO_INSTALL=0 forbids automatic setup",
    );
    const rustupLog = await readFile(fixture.rustupLog, "utf8");
    expect(rustupLog).not.toContain("toolchain install");
  });

  test("respects RUSTUP_AUTO_INSTALL=0 with an actionable missing-target error", async () => {
    const fixture = await createFixture({ installed: true, targetInstalled: false });
    process.env.RUSTUP_AUTO_INSTALL = "0";
    const toolchain = await resolveArtifactKernelRustToolchain(fixture.repositoryRoot);

    await expect(ensureArtifactKernelRustToolchain(toolchain)).rejects.toThrow(
      "rustup target add --toolchain 1.97.0 wasm32-unknown-unknown",
    );
    const rustupLog = await readFile(fixture.rustupLog, "utf8");
    expect(rustupLog).not.toContain("target add");
  });

  test("respects RUSTUP_AUTO_INSTALL=0 with an actionable missing-component error", async () => {
    const fixture = await createFixture({ installed: true, targetInstalled: true });
    process.env.RUSTUP_AUTO_INSTALL = "0";
    const toolchain = await resolveArtifactKernelRustToolchain(fixture.repositoryRoot);

    await expect(
      ensureArtifactKernelRustToolchain(toolchain, { components: ["rustfmt"] }),
    ).rejects.toThrow("rustup component add --toolchain 1.97.0 rustfmt");
    const rustupLog = await readFile(fixture.rustupLog, "utf8");
    expect(rustupLog).not.toContain("component add");
  });
});

async function createFixture(
  options: Readonly<{
    channel?: string;
    installed: boolean;
    targetInstalled: boolean;
  }>,
) {
  if (process.platform === "win32") throw new Error("POSIX fake tool fixture required");
  const root = await mkdtemp(join(tmpdir(), "opengeni-artifact-rust-"));
  roots.push(root);
  const repositoryRoot = join(root, "repository");
  const kernelRoot = join(repositoryRoot, "packages", "artifact-tool", "kernel");
  const binRoot = join(root, "bin");
  const toolchainBinRoot = join(root, "toolchain-bin");
  const cargoHome = join(root, "cargo-home");
  const stateRoot = join(root, "state");
  await Promise.all([
    mkdir(kernelRoot, { recursive: true }),
    mkdir(binRoot, { recursive: true }),
    mkdir(toolchainBinRoot, { recursive: true }),
    mkdir(cargoHome, { recursive: true }),
    mkdir(stateRoot, { recursive: true }),
  ]);
  await writeFile(
    join(kernelRoot, "rust-toolchain.toml"),
    `[toolchain]\nchannel = "${options.channel ?? "1.97.0"}"\nprofile = "minimal"\ntargets = ["wasm32-unknown-unknown"]\n`,
  );
  const rustupLog = join(root, "rustup.log");
  const directLog = join(root, "direct.log");
  const wrongRustc = join(binRoot, "rustc");
  const wrongCargo = join(binRoot, "cargo");
  const wrongWrapper = join(binRoot, "rustc-wrapper");
  const pinnedRustc = join(toolchainBinRoot, "rustc");
  const pinnedCargo = join(toolchainBinRoot, "cargo");
  if (options.installed) await writeFile(join(stateRoot, "toolchain"), "installed\n");
  if (options.targetInstalled) {
    await writeFile(join(stateRoot, "targets"), "wasm32-unknown-unknown\n");
  }
  await executable(
    wrongRustc,
    `#!/bin/sh\nprintf '%s\\n' rustc >> "$FAKE_DIRECT_LOG"\nprintf '%s\\n' 'rustc 9.99.0 (wrong direct compiler)'\n`,
  );
  await executable(
    wrongCargo,
    `#!/bin/sh\nprintf '%s\\n' cargo >> "$FAKE_DIRECT_LOG"\nprintf '%s\\n' 'cargo 9.99.0 (wrong direct cargo)'\n`,
  );
  await executable(
    wrongWrapper,
    `#!/bin/sh\nprintf '%s\\n' wrapper >> "$FAKE_DIRECT_LOG"\nexec "$@"\n`,
  );
  await executable(pinnedRustc, `#!/bin/sh\nprintf '%s\\n' 'rustc 1.97.0 (pinned fixture)'\n`);
  await executable(pinnedCargo, `#!/bin/sh\nprintf '%s\\n' 'cargo 1.97.0 (pinned fixture)'\n`);
  await executable(
    join(binRoot, "rustup"),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_RUSTUP_LOG"
state="$FAKE_RUSTUP_STATE"
if [ "$1" = run ]; then
  [ -f "$state/toolchain" ] || exit 1
  tool="$3"
  if [ "$tool" = rustc ]; then
    printf '%s\\n' 'rustc 1.97.0 (pinned fixture)'
  elif [ "$tool" = cargo ]; then
    if [ "\${4:-}" = compiler-probe ]; then
      [ "$CARGO" = "$FAKE_PINNED_CARGO" ] || exit 10
      [ -z "\${CARGO_BUILD_RUSTC+x}" ] || exit 11
      [ -z "\${CARGO_BUILD_RUSTC_WRAPPER+x}" ] || exit 12
      [ -z "\${CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER+x}" ] || exit 13
      [ -n "\${RUSTC:-}" ] || exit 14
      [ "\${RUSTC_WRAPPER+x}" = x ] && [ -z "$RUSTC_WRAPPER" ] || exit 15
      [ "\${RUSTC_WORKSPACE_WRAPPER+x}" = x ] && [ -z "$RUSTC_WORKSPACE_WRAPPER" ] || exit 16
      [ -f "$CARGO_HOME/config.toml" ] || exit 17
      "$RUSTC" --version
    else
      printf '%s\\n' 'cargo 1.97.0 (pinned fixture)'
    fi
  else
    exit 2
  fi
elif [ "$1" = which ] && [ "$2" = --toolchain ] && [ "$3" = 1.97.0 ]; then
  if [ "$4" = rustc ]; then
    printf '%s\\n' '${pinnedRustc}'
  elif [ "$4" = cargo ]; then
    printf '%s\\n' '${pinnedCargo}'
  else
    exit 4
  fi
elif [ "$1" = toolchain ] && [ "$2" = install ]; then
  touch "$state/toolchain"
elif [ "$1" = target ] && [ "$2" = list ]; then
  [ ! -f "$state/targets" ] || cat "$state/targets"
elif [ "$1" = target ] && [ "$2" = add ]; then
  shift 4
  printf '%s\\n' "$@" >> "$state/targets"
elif [ "$1" = component ] && [ "$2" = list ]; then
  [ ! -f "$state/components" ] || cat "$state/components"
elif [ "$1" = component ] && [ "$2" = add ]; then
  shift 4
  printf '%s\\n' "$@" >> "$state/components"
else
  exit 3
fi
`,
  );
  process.env.PATH = `${binRoot}${delimiter}${originalPath ?? ""}`;
  process.env.FAKE_RUSTUP_LOG = rustupLog;
  process.env.FAKE_DIRECT_LOG = directLog;
  process.env.FAKE_RUSTUP_STATE = stateRoot;
  process.env.FAKE_PINNED_CARGO = pinnedCargo;
  delete process.env.RUSTUP_AUTO_INSTALL;
  return {
    repositoryRoot,
    rustupLog,
    directLog,
    cargoHome,
    wrongCargo,
    wrongRustc,
    wrongWrapper,
  };
}

async function executable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
