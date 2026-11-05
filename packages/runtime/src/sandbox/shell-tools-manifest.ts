/**
 * The exact ripgrep and jq release binaries Opengeni ships with its own runtime
 * tools, so the agent's shell has `rg` and `jq` on every placement even when
 * the image or machine lacks them. They are appended to the end of PATH, so a
 * system `rg` or `jq` always wins.
 *
 * Every entry is an official upstream release asset. `sha256` pins the
 * downloaded asset and `binarySha256` the executable inside it (the same value
 * for jq, which publishes bare executables). They were checked against the
 * publishers' own checksum files (ripgrep's `<asset>.sha256`, jq's
 * `sha256sum.txt`) and GitHub's asset digests.
 *
 * Consumers: the machine agent's release builds (`scripts/fetch-shell-tools.ts`
 * and `agent/crates/opengeni-agent/build.rs`), the managed sandbox delivery in
 * `shell-tools.ts`, and the image builds in `docker/`, whose `ADD --checksum`
 * pins `scripts/shell-tools.test.ts` keeps equal to this file.
 */

export type ShellToolName = "rg" | "jq";

export type ShellToolAsset = {
  /** Official release download. */
  url: string;
  /** SHA-256 of the downloaded asset. */
  sha256: string;
  /** Path of the executable inside a `.tar.gz` or `.zip`; absent for a bare executable. */
  member?: string;
  /** SHA-256 of the executable itself. */
  binarySha256: string;
};

export type ShellToolsTarget =
  | "x86_64-unknown-linux-musl"
  | "aarch64-unknown-linux-musl"
  | "x86_64-apple-darwin"
  | "aarch64-apple-darwin"
  | "x86_64-pc-windows-msvc"
  | "aarch64-pc-windows-msvc";

export const SHELL_TOOLS_VERSIONS = {
  rg: { project: "ripgrep", version: "15.2.0", license: "MIT OR Unlicense" },
  jq: { project: "jq", version: "1.8.2", license: "MIT" },
} as const satisfies Record<ShellToolName, { project: string; version: string; license: string }>;

const RG = `https://github.com/BurntSushi/ripgrep/releases/download/${SHELL_TOOLS_VERSIONS.rg.version}`;
const JQ = `https://github.com/jqlang/jq/releases/download/jq-${SHELL_TOOLS_VERSIONS.jq.version}`;

function ripgrep(target: string, archive: "tar.gz" | "zip", sha256: string, binarySha256: string) {
  const stem = `ripgrep-${SHELL_TOOLS_VERSIONS.rg.version}-${target}`;
  const executable = archive === "zip" ? "rg.exe" : "rg";
  return {
    url: `${RG}/${stem}.${archive}`,
    sha256,
    member: `${stem}/${executable}`,
    binarySha256,
  } satisfies ShellToolAsset;
}

function jq(asset: string, sha256: string) {
  return { url: `${JQ}/${asset}`, sha256, binarySha256: sha256 } satisfies ShellToolAsset;
}

export const SHELL_TOOLS_TARGETS: Record<
  ShellToolsTarget,
  Record<ShellToolName, ShellToolAsset>
> = {
  "x86_64-unknown-linux-musl": {
    rg: ripgrep(
      "x86_64-unknown-linux-musl",
      "tar.gz",
      "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
      "e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849",
    ),
    jq: jq("jq-linux-amd64", "b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f"),
  },
  "aarch64-unknown-linux-musl": {
    rg: ripgrep(
      "aarch64-unknown-linux-musl",
      "tar.gz",
      "800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915",
      "c14cdb389f34e504d69e386cfc67d5c5d9a730a990de03ca6910b2a15e30386a",
    ),
    jq: jq("jq-linux-arm64", "8b85c817833814ddca00a144c33705546355afccf0cf39b188f3cdb48b852309"),
  },
  "x86_64-apple-darwin": {
    rg: ripgrep(
      "x86_64-apple-darwin",
      "tar.gz",
      "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
      "0c9a0066db0d26b640777db88045b0ccdd58509a746700e43e1c4ff8707a5ed0",
    ),
    jq: jq("jq-macos-amd64", "e94b266e3c26690550006abe63152b782280f4e14374accdf04cbde844f00bc0"),
  },
  "aarch64-apple-darwin": {
    rg: ripgrep(
      "aarch64-apple-darwin",
      "tar.gz",
      "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
      "a326a1fb48074202e9ad41e4cd1e389eeea372c8c6f7d7e80da81176d5d9430e",
    ),
    jq: jq("jq-macos-arm64", "2d75340ba57a4b4b4c8708a21c2dc8e958a48aaa8bba13b27f77f6e4c0eca07e"),
  },
  "x86_64-pc-windows-msvc": {
    rg: ripgrep(
      "x86_64-pc-windows-msvc",
      "zip",
      "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
      "14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680",
    ),
    jq: jq(
      "jq-windows-amd64.exe",
      "a6fc67fedaf9128a3309a1e2ebb8b986aeccf70122ee46d2cb4849e423f0c627",
    ),
  },
  "aarch64-pc-windows-msvc": {
    rg: ripgrep(
      "aarch64-pc-windows-msvc",
      "zip",
      "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f",
      "d33a29a9ef03c9f4c03be9e8d88498e6e2d2e566d64cdbdef97f9afc8f13120c",
    ),
    jq: jq(
      "jq-windows-arm64.exe",
      "083b5377392bc57cf27052b6d20a2d927770683bca844632901ff38b4b7b0ac7",
    ),
  },
};

/** Executable file name of a tool on a target. */
export function shellToolFileName(target: ShellToolsTarget, tool: ShellToolName): string {
  return target.endsWith("-windows-msvc") ? `${tool}.exe` : tool;
}

/** Licence notices shipped beside the executables wherever they are installed. */
export const SHELL_TOOLS_NOTICES_FILE = "THIRD-PARTY-NOTICES.txt";

/** Linux targets managed sandboxes can run, keyed by `uname -m`'s canonical name. */
export const MANAGED_SHELL_TOOLS_TARGETS = {
  x86_64: "x86_64-unknown-linux-musl",
  aarch64: "aarch64-unknown-linux-musl",
} as const satisfies Record<string, ShellToolsTarget>;
