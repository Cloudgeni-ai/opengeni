import { blake3 } from "@noble/hashes/blake3";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Mirrors protocol/build.rs using source bytes only; never runs checkout code. */
export async function artifactKernelSourceIdentity(repositoryRoot: string): Promise<string> {
  const root = join(repositoryRoot, "packages/artifact-tool/kernel");
  const files = [
    "Cargo.toml",
    "Cargo.lock",
    "bindings/protocol/Cargo.toml",
    "bindings/protocol/Cargo.lock",
    "bindings/protocol/build.rs",
  ];
  const collect = async (directory: string): Promise<void> => {
    if (!(await lstat(join(root, directory))).isDirectory())
      throw new Error("Invalid kernel source directory");
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("Linked kernel source is unsupported");
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile() && entry.name.endsWith(".rs")) files.push(path);
    }
  };
  await collect("src");
  await collect("bindings/protocol/src");
  const hash = blake3.create({});
  for (const path of files.sort()) {
    if (!(await lstat(join(root, path))).isFile()) throw new Error("Invalid kernel source file");
    hash.update(new TextEncoder().encode(path));
    hash.update(new Uint8Array([0]));
    hash.update(await readFile(join(root, path)));
    hash.update(new Uint8Array([255]));
  }
  return Buffer.from(hash.digest()).toString("hex");
}

export function assertKernelSourceIdentity(buildIdentity: string, expectedSource: string): void {
  if (
    !/^[a-f0-9]{64}$/.test(expectedSource) ||
    !buildIdentity.includes(`;source=${expectedSource};toolchain=`)
  )
    throw new Error("Runtime receipt does not match the checkout kernel source");
}
