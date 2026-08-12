import { createHash } from "node:crypto";
import { access, lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

export const LIGHTPANDA_VERSION = "0.3.5" as const;

/** Digests of the upstream Lightpanda 0.3.5 release assets. */
export const LIGHTPANDA_BINARY_SHA256 = {
  "lightpanda-aarch64-linux": "8d7b3a1d7b9024beef94e7fc7ce854030ee4d6def5f802b8e0e8824731c3d93a",
  "lightpanda-x86_64-linux": "5713d49d06e8d4948d3358b6ce859ecca8e6f07dc312134d9f54999fb6e66c52",
  "lightpanda-aarch64-macos": "b84e67e4f06f173b1d78aa4952ef441eae8a0052924e80784e8f202db59a45ae",
  "lightpanda-x86_64-macos": "d2271bf24810bc5875afac0335ba804add8f0a36dd55e6d4b99c20657d3afc5e",
} as const;

export type LightpandaBinaryName = keyof typeof LIGHTPANDA_BINARY_SHA256;

export type ResolvedLightpandaBinary = {
  path: string;
  name: LightpandaBinaryName;
  version: typeof LIGHTPANDA_VERSION;
  sha256: string;
};

export async function resolvePinnedLightpandaBinary(options: {
  binaryPath: string;
  platform?: NodeJS.Platform;
  architecture?: string;
}): Promise<ResolvedLightpandaBinary> {
  const name = lightpandaBinaryName(
    options.platform ?? process.platform,
    options.architecture ?? process.arch,
  );
  const path = resolve(options.binaryPath);
  const pathMetadata = await lstat(path);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    throw new Error("Lightpanda binary must be an exact regular file");
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  let sha256: string;
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino
    ) {
      throw new Error("Lightpanda binary changed while it was being verified");
    }
    sha256 = createHash("sha256")
      .update(await handle.readFile())
      .digest("hex");
  } finally {
    await handle.close();
  }
  if (sha256 !== LIGHTPANDA_BINARY_SHA256[name]) {
    throw new Error(`Lightpanda native binary digest mismatch for ${name}`);
  }
  await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  return { path, name, version: LIGHTPANDA_VERSION, sha256 };
}

function lightpandaBinaryName(
  platform: NodeJS.Platform,
  architecture: string,
): LightpandaBinaryName {
  if (platform === "linux" && architecture === "arm64") return "lightpanda-aarch64-linux";
  if (platform === "linux" && architecture === "x64") return "lightpanda-x86_64-linux";
  if (platform === "darwin" && architecture === "arm64") return "lightpanda-aarch64-macos";
  if (platform === "darwin" && architecture === "x64") return "lightpanda-x86_64-macos";
  throw new Error(`Lightpanda does not publish a binary for ${platform}-${architecture}`);
}
