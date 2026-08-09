import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ARTIFACT_RUNTIME_CONTAINER_TARGETS,
  assembleArtifactRuntimeContainerInputs,
} from "./assemble-artifact-runtime-container-inputs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artifact runtime container inputs", () => {
  test("maps OCI architectures to exact glibc targets and promotes only a complete staging tree", async () => {
    expect(ARTIFACT_RUNTIME_CONTAINER_TARGETS).toEqual({
      amd64: "linux-x64-gnu",
      arm64: "linux-arm64-gnu",
    });
    const root = await temporaryRoot();
    const outputRoot = join(root, "runtime");
    const calls: Array<Readonly<{ target: string; packageRoot: string }>> = [];
    await assembleArtifactRuntimeContainerInputs(options(root, outputRoot), async (input) => {
      calls.push({ target: input.target, packageRoot: input.kernelPackageRoot });
      await mkdir(input.outputRoot, { recursive: true });
      await writeFile(join(input.outputRoot, "installation.json"), input.target);
      return {} as never;
    });
    expect(calls).toEqual([
      {
        target: "linux-x64-gnu",
        packageRoot: join(root, "packages", "artifact-kernel-linux-x64-gnu"),
      },
      {
        target: "linux-arm64-gnu",
        packageRoot: join(root, "packages", "artifact-kernel-linux-arm64-gnu"),
      },
    ]);
    expect(await readFile(join(outputRoot, "amd64", "installation.json"), "utf8")).toBe(
      "linux-x64-gnu",
    );
    expect(await readFile(join(outputRoot, "arm64", "installation.json"), "utf8")).toBe(
      "linux-arm64-gnu",
    );
  });

  test("preserves the previous complete tree when either architecture fails", async () => {
    const root = await temporaryRoot();
    const outputRoot = join(root, "runtime");
    await mkdir(outputRoot, { recursive: true });
    await writeFile(join(outputRoot, "accepted"), "previous");
    await expect(
      assembleArtifactRuntimeContainerInputs(options(root, outputRoot), async (input) => {
        if (input.target === "linux-arm64-gnu") throw new Error("missing exact arm64 receipt");
        await mkdir(input.outputRoot, { recursive: true });
        return {} as never;
      }),
    ).rejects.toThrow("missing exact arm64 receipt");
    expect(await readFile(join(outputRoot, "accepted"), "utf8")).toBe("previous");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "artifact-runtime-containers-"));
  roots.push(root);
  return root;
}

function options(root: string, outputRoot: string) {
  return {
    releaseManifestPath: join(root, "release.json"),
    materializedPackagesRoot: join(root, "packages"),
    artifactToolTarballPath: join(root, "artifact-tool.tgz"),
    outputRoot,
  };
}
