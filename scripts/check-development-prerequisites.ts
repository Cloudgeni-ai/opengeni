#!/usr/bin/env bun
import { canonicalBunVersion } from "./bun-version";

export function developmentPrerequisiteErrors(options: {
  bunVersion: string;
  requiredBunVersion: string;
  platform: string;
  which: (command: string) => string | null;
}): string[] {
  const errors: string[] = [];
  if (options.bunVersion !== options.requiredBunVersion) {
    errors.push(
      `Bun ${options.bunVersion} does not match this checkout's pinned Bun ${options.requiredBunVersion}. Install it with: curl -fsSL https://bun.com/install | bash -s "bun-v${options.requiredBunVersion}". Then check bun --version (including PATH order).`,
    );
  }
  if (options.platform !== "linux" && options.platform !== "darwin") {
    errors.push("Local startup requires macOS or Linux. On Windows, run inside WSL2.");
  }
  for (const [command, hint] of [
    ["git", "Install Git."],
    ["curl", "Install curl; startup uses it for downloads and health checks."],
    [
      "rustup",
      "Install rustup from https://rustup.rs; startup builds the native artifact kernel and relay.",
    ],
    [
      "cc",
      "Install the Xcode Command Line Tools on macOS, or a C build toolchain (build-essential on Debian/Ubuntu) on Linux.",
    ],
  ] as const) {
    if (!options.which(command)) errors.push(`Missing ${command}. ${hint}`);
  }
  return errors;
}

export async function checkDevelopmentPrerequisites(): Promise<void> {
  const requiredBunVersion = await canonicalBunVersion();
  const errors = developmentPrerequisiteErrors({
    bunVersion: Bun.version,
    requiredBunVersion,
    platform: process.platform,
    which: Bun.which,
  });
  if (errors.length > 0) {
    console.error(
      "OpenGeni startup prerequisites are missing:\n" +
        errors.map((error) => `  - ${error}`).join("\n"),
    );
    console.error("See https://docs.opengeni.ai/run-locally");
    throw new Error("OpenGeni startup prerequisites are not satisfied");
  }
}

if (import.meta.main) await checkDevelopmentPrerequisites();
