import { createHash } from "node:crypto";
import { chmod, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

export const AGENT_BROWSER_VERSION = "0.33.2" as const;
export const AGENT_BROWSER_PACKAGE_INTEGRITY =
  "sha512-e+TZ0G04uw2rs+lVB8gn0IWTT7ErfiAl3jQ4zNNwyqDhgXWJKhqxYKkyibjuBGXLzx/APlzU3IWAsOVdRwh0DA==" as const;

/** Digests of the native binaries shipped in agent-browser@0.33.2. */
export const AGENT_BROWSER_BINARY_SHA256 = {
  "agent-browser-darwin-arm64": "cbb517902bcaa3b7a6384fd9f25dd274da3df2bb6a3ba9c3e85806d78213c26b",
  "agent-browser-darwin-x64": "a6bb1c10124f624a9b1fd0eecabf774477cdb710e3552fb843f1f7f664b8f326",
  "agent-browser-linux-arm64": "6ccaba1eb26a0e6f5c23c59d2c63e6e0237fde82713cfdb543ba506490cac9c1",
  "agent-browser-linux-musl-arm64":
    "eec7d0a27e32b96a4f9b9fbdd0c070d058e5b4eaa1bd6be1fffe926321c5d01c",
  "agent-browser-linux-musl-x64":
    "ca7e6589158fd9276897ec66367105704a215f95b1df4c4abb193244d0260eda",
  "agent-browser-linux-x64": "b7bc3dfcf0a7326c1f5a60423163259ba2349eebfa5bd2e70e111af743da4a49",
  "agent-browser-win32-x64.exe": "291f0c33c2fbcbf159b5868065ab412dfd8722d6299821e010cf0715964f2cba",
} as const;

export type AgentBrowserBinaryName = keyof typeof AGENT_BROWSER_BINARY_SHA256;

export type ResolvedAgentBrowserBinary = {
  path: string;
  name: AgentBrowserBinaryName;
  version: typeof AGENT_BROWSER_VERSION;
  sha256: string;
};

export async function resolvePinnedAgentBrowserBinary(
  options: {
    binaryPath?: string;
    packageRoot?: string;
    platform?: NodeJS.Platform;
    architecture?: string;
    musl?: boolean;
  } = {},
): Promise<ResolvedAgentBrowserBinary> {
  const name = binaryName(
    options.platform ?? process.platform,
    options.architecture ?? process.arch,
    options.musl ?? detectMusl(),
  );
  if (options.binaryPath && options.packageRoot) {
    throw new Error("binaryPath and packageRoot are mutually exclusive");
  }
  let path: string;
  if (options.binaryPath) {
    path = resolve(options.binaryPath);
  } else {
    const packageRoot = options.packageRoot ?? resolveAgentBrowserPackageRoot();
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (manifest.version !== AGENT_BROWSER_VERSION) {
      throw new Error(
        `Expected agent-browser ${AGENT_BROWSER_VERSION}; installed ${String(manifest.version)}`,
      );
    }
    path = join(packageRoot, "bin", name);
  }
  const bytes = await readFile(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== AGENT_BROWSER_BINARY_SHA256[name]) {
    throw new Error(`agent-browser native binary digest mismatch for ${name}`);
  }
  if (process.platform !== "win32" && ((await stat(path)).mode & 0o111) === 0) {
    await chmod(path, 0o755);
  }
  return { path, name, version: AGENT_BROWSER_VERSION, sha256 };
}

function resolveAgentBrowserPackageRoot(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("agent-browser/package.json"));
}

function binaryName(
  platform: NodeJS.Platform,
  architecture: string,
  musl: boolean,
): AgentBrowserBinaryName {
  if (platform === "darwin" && architecture === "arm64") {
    return "agent-browser-darwin-arm64";
  }
  if (platform === "darwin" && architecture === "x64") return "agent-browser-darwin-x64";
  if (platform === "linux" && architecture === "arm64") {
    return musl ? "agent-browser-linux-musl-arm64" : "agent-browser-linux-arm64";
  }
  if (platform === "linux" && architecture === "x64") {
    return musl ? "agent-browser-linux-musl-x64" : "agent-browser-linux-x64";
  }
  if (platform === "win32" && architecture === "x64") return "agent-browser-win32-x64.exe";
  throw new Error(`agent-browser does not ship a binary for ${platform}-${architecture}`);
}

function detectMusl(): boolean {
  if (process.platform !== "linux") return false;
  return ["/lib/ld-musl-x86_64.so.1", "/lib/ld-musl-aarch64.so.1"].some((path) => existsSync(path));
}
