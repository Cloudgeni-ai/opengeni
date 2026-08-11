import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const imagePaths = ["docker/sandbox.Dockerfile", "docker/desktop.Dockerfile"] as const;

function buildsBrowserControllerOnTargetPlatform(dockerfile: string): boolean {
  const sourceStage = dockerfile.indexOf(
    "FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS browserd-source-build",
  );
  const sourceCopy = dockerfile.indexOf("COPY . .", sourceStage);
  const install = dockerfile.indexOf("RUN bun install --frozen-lockfile", sourceCopy);
  const codemode = dockerfile.indexOf("runtime=/out/codemode-runtime", install);
  const ogtool = dockerfile.indexOf("RUN cd packages/ogtool && bun run build", codemode);
  const targetStage = dockerfile.indexOf("FROM oven/bun:1.3.14 AS browserd-build", ogtool);
  const targetSource = dockerfile.indexOf(
    "COPY --from=browserd-source-build /src /src",
    targetStage,
  );
  const targetCodemode = dockerfile.indexOf(
    "COPY --from=browserd-source-build /out/codemode-runtime /out/codemode-runtime",
    targetSource,
  );
  const targetArchitecture = dockerfile.indexOf("\nARG TARGETARCH\n", targetCodemode);
  const nativeCompile = dockerfile.indexOf("bun build --compile \\", targetArchitecture);
  const targetController = dockerfile.indexOf(
    'install -m 0755 "packages/browserd/node_modules/agent-browser/bin/${native}"',
    nativeCompile,
  );
  const nextStage = dockerfile.indexOf("\nFROM ", targetController);
  const bunRuntime = dockerfile.indexOf("FROM oven/bun:1.3.14 AS bun-runtime");
  const targetBunCopy = dockerfile.indexOf(
    "COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun",
    nextStage,
  );

  return (
    sourceStage >= 0 &&
    sourceCopy > sourceStage &&
    install > sourceCopy &&
    codemode > install &&
    ogtool > codemode &&
    targetStage > ogtool &&
    targetSource > targetStage &&
    targetCodemode > targetSource &&
    targetArchitecture > targetCodemode &&
    nativeCompile > targetArchitecture &&
    targetController > nativeCompile &&
    nextStage > targetController &&
    bunRuntime >= 0 &&
    bunRuntime < sourceStage &&
    targetBunCopy > nextStage &&
    !dockerfile.includes("--compile-executable-path") &&
    !dockerfile.includes("COPY --from=browserd-build /usr/local/bin/bun /usr/local/bin/bun")
  );
}

describe("browser controller image build contract", () => {
  for (const imagePath of imagePaths) {
    test(`${imagePath} prepares shared inputs once and compiles natively for the target`, async () => {
      const dockerfile = await readFile(resolve(root, imagePath), "utf8");

      expect(buildsBrowserControllerOnTargetPlatform(dockerfile)).toBe(true);

      const crossCompiled = dockerfile.replace(
        "FROM oven/bun:1.3.14 AS browserd-build",
        "FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS browserd-build",
      );
      const missingPreparedSource = dockerfile.replace(
        "COPY --from=browserd-source-build /src /src",
        "COPY . .",
      );

      expect(buildsBrowserControllerOnTargetPlatform(crossCompiled)).toBe(false);
      expect(buildsBrowserControllerOnTargetPlatform(missingPreparedSource)).toBe(false);
    });
  }
});
