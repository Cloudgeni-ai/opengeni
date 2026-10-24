// Build the system audio helper (audio-capture/) into
// build/audio-capture/<os>-<arch>/, where electron-builder's extraResources
// puts it next to the app. Release builds make every architecture the
// platform ships (macOS's universal app merges its two copies); `--host`
// builds only this machine's, for packaging and trying the app locally.
//
// Linux builds go through cargo-zigbuild against glibc 2.28, so the helper
// runs on the distributions the app supports; it loads the PulseAudio client
// library at runtime and links nothing else.

import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const crate = join(root, "audio-capture");
const output = join(root, "build", "audio-capture");
const hostOnly = process.argv.includes("--host");

type Target = { rust: string; dir: string };

const TARGETS: Partial<Record<NodeJS.Platform, Target[]>> = {
  darwin: [
    { rust: "aarch64-apple-darwin", dir: "mac-arm64" },
    { rust: "x86_64-apple-darwin", dir: "mac-x64" },
  ],
  win32: [
    { rust: "x86_64-pc-windows-msvc", dir: "win-x64" },
    { rust: "aarch64-pc-windows-msvc", dir: "win-arm64" },
  ],
  linux: [
    { rust: "x86_64-unknown-linux-gnu", dir: "linux-x64" },
    { rust: "aarch64-unknown-linux-gnu", dir: "linux-arm64" },
  ],
};

const hostArch = process.arch === "arm64" ? "aarch64" : "x86_64";
const targets = (TARGETS[process.platform] ?? []).filter(
  (target) => !hostOnly || target.rust.startsWith(hostArch),
);
if (targets.length === 0) {
  console.error(
    `No system audio helper for ${process.platform}/${process.arch}.`,
  );
  process.exit(1);
}

function run(command: string[]): void {
  const result = Bun.spawnSync(command, {
    cwd: crate,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    console.error(`failed: ${command.join(" ")}`);
    process.exit(result.exitCode ?? 1);
  }
}

rmSync(output, { recursive: true, force: true });
const executable =
  process.platform === "win32"
    ? "opengeni-audio-capture.exe"
    : "opengeni-audio-capture";
for (const target of targets) {
  run(["rustup", "target", "add", target.rust]);
  if (process.platform === "linux") {
    run([
      "cargo",
      "zigbuild",
      "--release",
      "--locked",
      "--target",
      `${target.rust}.2.28`,
    ]);
  } else {
    run(["cargo", "build", "--release", "--locked", "--target", target.rust]);
  }
  const destination = join(output, target.dir);
  mkdirSync(destination, { recursive: true });
  copyFileSync(
    join(crate, "target", target.rust, "release", executable),
    join(destination, executable),
  );
  chmodSync(join(destination, executable), 0o755);
  console.log(`built ${target.dir}/${executable}`);
}
