#!/usr/bin/env bun
import { readFile } from "node:fs/promises";

export function developmentPrerequisiteErrors(options: {
  bunVersion: string;
  requiredBunVersion: string;
  platform: string;
  which: (command: string) => string | null;
}): string[] {
  const errors: string[] = [];
  if (!Bun.semver.satisfies(options.bunVersion, `>=${options.requiredBunVersion}`)) {
    errors.push(
      `Bun ${options.bunVersion} is too old; this checkout requires Bun ${options.requiredBunVersion} or newer. Run bun upgrade, then retry.`,
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

if (import.meta.main) {
  const requiredBunVersion = (
    await readFile(new URL("../.bun-version", import.meta.url), "utf8")
  ).trim();
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
    process.exitCode = 1;
  }
}
