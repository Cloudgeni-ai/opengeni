import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const imagePaths = ["docker/sandbox.Dockerfile", "docker/desktop.Dockerfile"] as const;
const startupScriptPath = "docker/desktop/opengeni-browserd-up.sh";

function buildsBrowserControllerOnTargetPlatform(dockerfile: string): boolean {
  const sourceStage = dockerfile.indexOf(
    "FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS browserd-source-build",
  );
  // Manifests are staged first so the frozen install layer survives source
  // edits; the full tree lands after it and before any source-dependent step.
  const install = dockerfile.indexOf("bun install --frozen-lockfile", sourceStage);
  const sourceCopy = dockerfile.indexOf("COPY . .", install);
  const codemode = dockerfile.indexOf("runtime=/out/codemode-runtime", sourceCopy);
  const ogtool = dockerfile.indexOf("RUN cd packages/ogtool && bun run build", codemode);
  const targetStage = dockerfile.indexOf("FROM oven/bun:${BUN_VERSION} AS browserd-build", ogtool);
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
  const bunRuntime = dockerfile.indexOf("FROM oven/bun:${BUN_VERSION} AS bun-runtime");
  const targetBunCopy = dockerfile.indexOf(
    "COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun",
    nextStage,
  );

  return (
    sourceStage >= 0 &&
    install > sourceStage &&
    sourceCopy > install &&
    codemode > sourceCopy &&
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
        "FROM oven/bun:${BUN_VERSION} AS browserd-build",
        "FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS browserd-build",
      );
      const missingPreparedSource = dockerfile.replace(
        "COPY --from=browserd-source-build /src /src",
        "COPY . .",
      );

      expect(buildsBrowserControllerOnTargetPlatform(crossCompiled)).toBe(false);
      expect(buildsBrowserControllerOnTargetPlatform(missingPreparedSource)).toBe(false);
    });
  }

  test("desktop image installs the pinned Chrome artifact without a mutable apt index", async () => {
    const dockerfile = await readFile(resolve(root, "docker/desktop.Dockerfile"), "utf8");

    expect(dockerfile).toContain("FROM scratch AS chrome-assets");
    expect(dockerfile).toContain(
      "ADD --checksum=sha256:bfb6e6d345055eb481a50db423256fa2732ce010f785a56c327e213a638efdef https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_151.0.7922.108-1_amd64.deb /google-chrome-stable.deb",
    );
    expect(dockerfile).toContain("/tmp/google-chrome-stable.deb");
    expect(dockerfile).not.toContain("google-chrome-stable=${OPENGENI_GOOGLE_CHROME_VERSION}");
    expect(dockerfile).not.toContain("https://dl.google.com/linux/chrome/deb/ stable main");
    expect(dockerfile).toContain("at-spi2-core libgtk-3-bin python3-gi gir1.2-gtk-3.0");
  });

  test("Debian Chromium remains available from one retained security snapshot", async () => {
    const dockerfiles = await Promise.all(
      imagePaths.map((imagePath) => readFile(resolve(root, imagePath), "utf8")),
    );

    for (const dockerfile of dockerfiles) {
      expect(dockerfile).toContain("ARG OPENGENI_CHROMIUM_VERSION=151.0.7922.108-1~deb13u1");
      expect(dockerfile).toContain("ARG OPENGENI_DEBIAN_SECURITY_SNAPSHOT=20260809T010020Z");
      expect(dockerfile).toContain(
        "https://snapshot.debian.org/archive/debian-security/${OPENGENI_DEBIAN_SECURITY_SNAPSHOT} trixie-security main",
      );
      expect(dockerfile).toContain('"chromium-common=${OPENGENI_CHROMIUM_VERSION}"');
      expect(dockerfile.indexOf("opengeni-chromium-snapshot.list")).toBeLessThan(
        dockerfile.indexOf('"chromium=${OPENGENI_CHROMIUM_VERSION}"'),
      );
    }
  });

  test("startup distinguishes a live setsid/env child from a completed browserd exec", async () => {
    const source = await readFile(resolve(root, startupScriptPath), "utf8");
    const startupBudget = source.indexOf(
      'STARTUP_TIMEOUT_SECONDS="${OPENGENI_BROWSERD_STARTUP_TIMEOUT_SECONDS:-30}"',
    );
    const startupLoop = source.indexOf('for _ in $(seq 1 "$STARTUP_ATTEMPTS"); do');
    const processAlive = source.indexOf('if ! kill -0 "$PID" 2>/dev/null; then', startupLoop);
    const browserdExecComplete = source.indexOf('if ! same_process "$PID"; then', processAlive);
    const readiness = source.indexOf("if admin_ready; then", browserdExecComplete);

    expect(startupBudget).toBeGreaterThan(-1);
    expect(startupLoop).toBeGreaterThan(-1);
    expect(processAlive).toBeGreaterThan(startupLoop);
    expect(browserdExecComplete).toBeGreaterThan(processAlive);
    expect(readiness).toBeGreaterThan(browserdExecComplete);
    expect(source).toContain("print_startup_log");
    expect(source).toContain('tail -c 16384 "$LOG_FILE" | tail -n 80');
  });
});
