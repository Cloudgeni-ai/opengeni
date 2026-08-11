import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const imagePaths = ["docker/sandbox.Dockerfile", "docker/desktop.Dockerfile"] as const;

function buildsBrowserControllerOnBuildPlatform(dockerfile: string): boolean {
  const buildStage = dockerfile.indexOf(
    "FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS browserd-build",
  );
  const sourceCopy = dockerfile.indexOf("COPY . .", buildStage);
  const install = dockerfile.indexOf("RUN bun install --frozen-lockfile", buildStage);
  const codemode = dockerfile.indexOf("runtime=/out/codemode-runtime", buildStage);
  const ogtool = dockerfile.indexOf("RUN cd packages/ogtool && bun run build", buildStage);
  const targetArchitecture = dockerfile.indexOf("\nARG TARGETARCH\n", buildStage);
  const targetCompiler = dockerfile.indexOf(
    "COPY --from=bun-runtime /usr/local/bin/bun /tmp/opengeni-target-bun",
    targetArchitecture,
  );
  const crossCompile = dockerfile.indexOf(
    "bun build --compile --compile-executable-path=/tmp/opengeni-target-bun",
    targetCompiler,
  );
  const nextStage = dockerfile.indexOf("\nFROM ", crossCompile);
  const bunRuntime = dockerfile.indexOf("FROM oven/bun:1.3.14 AS bun-runtime");
  const targetBunCopy = dockerfile.indexOf(
    "COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun",
    nextStage,
  );

  return (
    buildStage >= 0 &&
    sourceCopy > buildStage &&
    install > sourceCopy &&
    codemode > install &&
    ogtool > codemode &&
    targetArchitecture > ogtool &&
    targetCompiler > targetArchitecture &&
    crossCompile > targetCompiler &&
    nextStage > crossCompile &&
    bunRuntime >= 0 &&
    bunRuntime < buildStage &&
    targetBunCopy > nextStage &&
    !dockerfile.includes("COPY --from=browserd-build /usr/local/bin/bun /usr/local/bin/bun")
  );
}

describe("browser controller image build contract", () => {
  for (const imagePath of imagePaths) {
    test(`${imagePath} shares build-platform work before target-specific compilation`, async () => {
      const dockerfile = await readFile(resolve(root, imagePath), "utf8");

      expect(buildsBrowserControllerOnBuildPlatform(dockerfile)).toBe(true);

      const targetSpecificInstall = dockerfile.replace(
        "FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS browserd-build\n\nWORKDIR /src",
        "FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS browserd-build\n\nARG TARGETARCH\nWORKDIR /src",
      );
      const emulatedBuilder = dockerfile.replace(
        "FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS browserd-build",
        "FROM oven/bun:1.3.14 AS browserd-build",
      );

      expect(buildsBrowserControllerOnBuildPlatform(targetSpecificInstall)).toBe(false);
      expect(buildsBrowserControllerOnBuildPlatform(emulatedBuilder)).toBe(false);
    });
  }
});
