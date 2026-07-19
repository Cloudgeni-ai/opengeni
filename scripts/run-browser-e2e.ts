import { spawnSync } from "node:child_process";

const requestedTestFiles = process.argv.slice(2);
const testFiles =
  requestedTestFiles.length > 0
    ? requestedTestFiles
    : [
        "./test/e2e/browser.e2e.ts",
        "./test/e2e/machines.browser.e2e.ts",
        "./test/e2e/session-pins.browser.e2e.ts",
        "./test/e2e/workbench.browser.e2e.ts",
      ];

for (const testFile of testFiles) {
  const status = runTestFile(testFile);
  if (status !== 0) process.exit(status);
}

function runTestFile(testFile: string): number {
  const testArgs = ["test", "--max-concurrency=1", testFile];
  const first = spawnSync("bun", testArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (first.status === 0) {
    process.stdout.write(first.stdout);
    process.stderr.write(first.stderr);
    return 0;
  }

  const output = `${first.stdout}\n${first.stderr}`;
  if (!output.includes("error while loading shared libraries") || !commandExists("nix")) {
    process.stdout.write(first.stdout);
    process.stderr.write(first.stderr);
    return first.status ?? 1;
  }

  const libraryPath = nixLibraryPath([
    "glib",
    "nss",
    "nspr",
    "dbus",
    "atk",
    "at-spi2-core",
    "cups",
    "libdrm",
    "expat",
    "libxkbcommon",
    "xorg.libX11",
    "xorg.libXcomposite",
    "xorg.libXdamage",
    "xorg.libXext",
    "xorg.libXfixes",
    "xorg.libXrandr",
    "xorg.libxcb",
    "mesa",
    "pango",
    "cairo",
    "alsa-lib",
    "libgbm",
    "gtk3",
    "gdk-pixbuf",
  ]);

  if (!libraryPath) {
    process.stdout.write(first.stdout);
    process.stderr.write(first.stderr);
    return first.status ?? 1;
  }

  process.stderr.write(`Retrying ${testFile} with Nix-provided Playwright runtime libraries.\n`);
  const retry = spawnSync("bun", testArgs, {
    encoding: "utf8",
    stdio: "inherit",
    env: {
      ...process.env,
      LD_LIBRARY_PATH: [libraryPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
    },
  });
  return retry.status ?? 1;
}

function commandExists(command: string): boolean {
  return spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function nixLibraryPath(attributes: string[]): string {
  const paths = new Set<string>();
  for (const attribute of attributes) {
    for (const suffix of [".out.outPath", ".lib.outPath", ".outPath"]) {
      const result = spawnSync("nix", ["eval", "--raw", `nixpkgs#${attribute}${suffix}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const outPath = result.stdout.trim();
      if (result.status === 0 && outPath) {
        paths.add(`${outPath}/lib`);
      }
    }
  }
  return [...paths].join(":");
}
