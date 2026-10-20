import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const root = resolve(import.meta.dir, "..");
const dockerfilePath = resolve(root, "docker/sandbox.Dockerfile");

function computerNativeStage(source: string): string {
  const start = source.indexOf(
    "FROM --platform=$BUILDPLATFORM rust:1.82-bookworm AS computer-native-build",
  );
  if (start < 0) return "";
  const next = source.indexOf("\nFROM ", start + 1);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

function keepsComputerNativeBuildOnTheNativeRunner(source: string): boolean {
  const xxStage =
    "FROM --platform=$BUILDPLATFORM tonistiigi/xx:1.9.0@sha256:c64defb9ed5a91eacb37f96ccc3d4cd72521c4bd18d5442905b95e2226b0e707 AS xx";
  const stage = computerNativeStage(source);
  const target = stage.indexOf("ARG TARGETPLATFORM");
  const targetLibraries = stage.indexOf(
    "RUN xx-apt-get install -y --no-install-recommends xx-c-essentials",
    target,
  );
  const sourceCopy = stage.indexOf("COPY agent .", targetLibraries);
  const triple = stage.indexOf('rust_target="$(xx-cargo --print-target-triple)"', sourceCopy);
  const build = stage.indexOf(
    "xx-cargo build --locked --release --target-dir /src/agent/target -p opengeni-computer-native",
    triple,
  );
  const install = stage.indexOf(
    'install -m 0755 "target/${rust_target}/release/opengeni-computer-native" /out/opengeni-computer-native',
    build,
  );
  const verify = stage.indexOf("xx-verify /out/opengeni-computer-native", install);
  // The sandbox's agent is built in the same cross-compiling step, installed
  // from the target's directory and verified as target-native too.
  const buildLineEnd = build < 0 ? -1 : stage.indexOf("\n", build);
  const buildLine =
    build < 0 ? "" : stage.slice(build, buildLineEnd < 0 ? undefined : buildLineEnd);
  const agentInstall = stage.indexOf(
    'install -m 0755 "target/${rust_target}/release/opengeni-agent" /out/opengeni-agent',
    build,
  );
  const agentVerify = stage.indexOf("xx-verify /out/opengeni-agent", agentInstall);

  return (
    source.includes(xxStage) &&
    stage.includes("COPY --from=xx / /") &&
    stage.includes("apt-get install -y --no-install-recommends clang lld") &&
    target >= 0 &&
    targetLibraries > target &&
    sourceCopy > targetLibraries &&
    triple > sourceCopy &&
    build > triple &&
    install > build &&
    verify > install &&
    /(^|\s)-p opengeni-agent(\s|;|$)/u.test(buildLine) &&
    agentInstall > build &&
    agentVerify > agentInstall &&
    !stage.includes("cargo build --locked --release -p opengeni-computer-native") &&
    !stage.includes("target/release/opengeni-agent /out/opengeni-agent") &&
    !stage.includes("target/release/opengeni-computer-native /out/opengeni-computer-native")
  );
}

describe("sandbox native computer image build contract", () => {
  test("cross-compiles the target helper on the native build platform", async () => {
    const source = await readFile(dockerfilePath, "utf8");

    expect(keepsComputerNativeBuildOnTheNativeRunner(source)).toBe(true);

    const emulatedStage = source.replace(
      "FROM --platform=$BUILDPLATFORM rust:1.82-bookworm AS computer-native-build",
      "FROM rust:1.82-bookworm AS computer-native-build",
    );
    const unverifiedOutput = source.replace(
      "    xx-verify /out/opengeni-computer-native",
      "    file /out/opengeni-computer-native",
    );
    const unlockedBuild = source.replace("xx-cargo build --locked", "xx-cargo build");
    const missingTargetLibraries = source.replace(
      "RUN xx-apt-get install -y --no-install-recommends xx-c-essentials\n",
      "",
    );

    expect(keepsComputerNativeBuildOnTheNativeRunner(emulatedStage)).toBe(false);
    expect(keepsComputerNativeBuildOnTheNativeRunner(unverifiedOutput)).toBe(false);
    expect(keepsComputerNativeBuildOnTheNativeRunner(unlockedBuild)).toBe(false);
    expect(keepsComputerNativeBuildOnTheNativeRunner(missingTargetLibraries)).toBe(false);

    const agentNotBuilt = source.replace(" -p opengeni-agent;", ";");
    const agentUnverified = source.replace(
      "    xx-verify /out/opengeni-agent",
      "    file /out/opengeni-agent",
    );
    const agentNotInstalled = source.replace(
      '    install -m 0755 "target/${rust_target}/release/opengeni-agent" /out/opengeni-agent; \\\n',
      "",
    );
    expect(agentNotBuilt).not.toBe(source);
    expect(agentUnverified).not.toBe(source);
    expect(agentNotInstalled).not.toBe(source);
    expect(keepsComputerNativeBuildOnTheNativeRunner(agentNotBuilt)).toBe(false);
    expect(keepsComputerNativeBuildOnTheNativeRunner(agentUnverified)).toBe(false);
    expect(keepsComputerNativeBuildOnTheNativeRunner(agentNotInstalled)).toBe(false);
  });
});
