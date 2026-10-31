import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { computerRuntimeConfig } from "../packages/browserd/src/main";

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
  // The controller is compiled by the distrusted target Bun, and the check
  // after the compile proves the program embeds no distrusted root.
  const targetDistrustedBun = dockerfile.indexOf(
    "FROM oven/bun:${BUN_VERSION} AS browserd-build\nCOPY --from=bun-runtime /out/bun /usr/local/bin/bun\n",
  );
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
    'install -m 0755 "/lightpanda-assets/${lightpanda_native}" /out/lightpanda',
    nativeCompile,
  );
  const nextStage = dockerfile.indexOf("\nFROM ", targetController);
  const compiledCheck = dockerfile.indexOf(
    "distrust-embedded-roots.ts --check \\\n  /opt/opengeni-docker/distrusted-roots.pem /out/opengeni-browserd",
    targetController,
  );
  // The target Bun is patched by the build machine's Bun, never executed.
  const bunRuntime = dockerfile.indexOf(
    "FROM oven/bun:${BUN_VERSION} AS bun-target\n" +
      "FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS bun-runtime\n" +
      "COPY --from=bun-target /usr/local/bin/bun /out/bun\n",
  );
  const targetBunCopy = dockerfile.indexOf(
    "COPY --from=bun-runtime /out/bun /usr/local/bin/bun",
    nextStage,
  );

  return (
    sourceStage >= 0 &&
    install > sourceStage &&
    sourceCopy > install &&
    codemode > sourceCopy &&
    ogtool > codemode &&
    targetStage > ogtool &&
    targetDistrustedBun === targetStage &&
    targetSource > targetStage &&
    targetCodemode > targetSource &&
    targetArchitecture > targetCodemode &&
    nativeCompile > targetArchitecture &&
    targetController > nativeCompile &&
    nextStage > targetController &&
    compiledCheck > targetController &&
    compiledCheck < dockerfile.indexOf("COPY --from=computer-native-build", targetController) &&
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

      // These images copy source packages, not a bundled dependency closure.
      // Every contracts runtime dependency must accompany that source.
      const contracts = JSON.parse(
        await readFile(resolve(root, "packages/contracts/package.json"), "utf8"),
      ) as { dependencies: Record<string, string> };
      for (const dependency of Object.keys(contracts.dependencies)) {
        expect(dockerfile).toContain(
          `cp -aL packages/contracts/node_modules/${dependency} "$runtime/node_modules/${dependency}"`,
        );
      }

      expect(buildsBrowserControllerOnTargetPlatform(dockerfile)).toBe(true);
      expect(dockerfile).toContain('"$runtime/node_modules/@opengeni/tool-gateway"');
      expect(dockerfile).toContain(
        'packages/tool-gateway/package.json "$runtime/node_modules/@opengeni/tool-gateway/package.json"',
      );
      expect(dockerfile).toContain(
        'cp -a packages/tool-gateway/src "$runtime/node_modules/@opengeni/tool-gateway/src"',
      );
      expect(dockerfile).toContain(
        'cp -aL packages/tool-gateway/node_modules/ajv "$runtime/node_modules/ajv"',
      );
      expect(dockerfile).toContain(
        'test -f "$runtime/node_modules/@opengeni/tool-gateway/src/index.ts"',
      );
      expect(dockerfile).toContain(
        'cp -a packages/observability/src "$runtime/node_modules/@opengeni/observability/src"',
      );
      expect(dockerfile).toContain(
        'cp -aL packages/observability/node_modules/prom-client "$runtime/node_modules/prom-client"',
      );
      expect(dockerfile).toContain('"$runtime/node_modules/@opentelemetry/api"');
      expect(dockerfile).toContain('"$runtime/node_modules/tdigest"');
      expect(dockerfile).toContain('"$runtime/node_modules/bintrees"');
      expect(dockerfile).toContain(
        "ln -s /opt/opengeni/codemode-runtime/node_modules /node_modules",
      );
      expect(dockerfile).toContain('await import("@opengeni/codemode")');
      expect(dockerfile).toContain('await import("@opengeni/sdk/site")');

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
      "ADD --checksum=sha256:be1a1e161419f5c8272432f6860912550d8e29985e925913fa800493a0d0c955 https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_156.0.8078.79-1_amd64.deb /google-chrome-stable.deb",
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
      expect(dockerfile).toContain("ARG OPENGENI_CHROMIUM_VERSION=156.0.8078.73-1~deb13u1");
      expect(dockerfile).toContain("ARG OPENGENI_DEBIAN_SECURITY_SNAPSHOT=20261029T020000Z");
      expect(dockerfile).toContain(
        "https://snapshot.debian.org/archive/debian-security/${OPENGENI_DEBIAN_SECURITY_SNAPSHOT} trixie-security main",
      );
      expect(dockerfile).toContain('"chromium-common=${OPENGENI_CHROMIUM_VERSION}"');
      expect(dockerfile.indexOf("opengeni-chromium-snapshot.list")).toBeLessThan(
        dockerfile.indexOf('"chromium=${OPENGENI_CHROMIUM_VERSION}"'),
      );
    }
  });

  for (const imagePath of imagePaths) {
    test(`${imagePath} runs the desktop driver it ships`, async () => {
      const dockerfile = await readFile(resolve(root, imagePath), "utf8");
      const environment: Record<string, string> = {};
      for (const match of dockerfile.matchAll(/^ENV (OPENGENI_BROWSERD_[A-Z_]+)=(\S+)$/gm)) {
        environment[match[1]!] = match[2]!;
      }
      // The images stage no CUA runtime beside the compiled controller, so a
      // CUA default would fail every ComputerSession start.
      expect(computerRuntimeConfig(environment, "linux")).toEqual({
        computerBackend: "native",
        computerEnvironmentMode: "isolated_linux",
      });
      expect(dockerfile).toContain(
        "ENV OPENGENI_BROWSERD_COMPUTER_NATIVE_BINARY=/usr/local/lib/opengeni/opengeni-computer-native",
      );
      expect(dockerfile).not.toContain("stage-cua-runtime");
    });
  }

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
