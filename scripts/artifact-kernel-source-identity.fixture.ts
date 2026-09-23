import { cp, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { artifactKernelSourceIdentity } from "./artifact-kernel-source-identity";

export async function copyKernelSourceFixture(repositoryRoot: string): Promise<string> {
  const prefix = "packages/artifact-tool/kernel";
  for (const path of [
    "Cargo.toml",
    "Cargo.lock",
    "src",
    "bindings/protocol/Cargo.toml",
    "bindings/protocol/Cargo.lock",
    "bindings/protocol/build.rs",
    "bindings/protocol/src",
  ]) {
    const destination = join(repositoryRoot, prefix, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(import.meta.dir, "..", prefix, path), destination, { recursive: true });
  }
  return artifactKernelSourceIdentity(repositoryRoot);
}
