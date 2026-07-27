import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureRoots = new Set<string>();

type BuilderResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "opengeni-build-cache-"));
  fixtureRoots.add(root);

  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, ".changeset"), { recursive: true });
  mkdirSync(join(root, "packages", "demo"), { recursive: true });
  writeFileSync(join(root, "bun.lock"), "lockfileVersion = 1\n");
  writeFileSync(join(root, "package.json"), '{"name":"fixture","private":true}\n');
  writeFileSync(join(root, "tsconfig.base.json"), "{}\n");
  writeFileSync(join(root, ".changeset", "config.json"), '{"ignore":[]}\n');
  writeFileSync(
    join(root, "scripts", "build-publishable-packages.ts"),
    readFileSync(join(scriptDirectory, "build-publishable-packages.ts")),
  );
  writeFileSync(
    join(root, "scripts", "publishable-workspaces.ts"),
    readFileSync(join(scriptDirectory, "publishable-workspaces.ts")),
  );
  writeFileSync(
    join(root, "packages", "demo", "package.json"),
    JSON.stringify(
      {
        name: "@opengeni/demo",
        version: "1.0.0",
        scripts: { build: "bun build-fixture.ts" },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(root, "packages", "demo", "build-fixture.ts"),
    `import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const packageRoot = import.meta.dir;
const dist = join(packageRoot, "dist");
const variant = process.env.OPENGENI_RACE ?? "BASE";
const gate = process.env.OPE27_RACE_GATE;

if (variant === "B" && gate) {
  writeFileSync(\`${"${gate}"}.b-started\`, "started\\n");
}
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "artifact.txt"), \`${"${variant}"}\\n\`);

if (variant === "A" && gate) {
  writeFileSync(\`${"${gate}"}.a-started\`, "started\\n");
  while (!existsSync(\`${"${gate}"}.release\`)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
`,
  );

  return root;
}

function runBuilder(
  root: string,
  environment: Record<string, string> = {},
): Promise<BuilderResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["scripts/build-publishable-packages.ts"], {
      cwd: root,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForPath(path: string, timeoutMilliseconds = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return existsSync(path);
}

function outputPath(root: string): string {
  return join(root, "packages", "demo", "dist", "artifact.txt");
}

afterEach(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  fixtureRoots.clear();
});

test("invalidates warm builds for complete nested and non-regular dist entries", async () => {
  const root = createFixture();
  const baseEnvironment = { OPENGENI_RACE: "BASE" };

  const cold = await runBuilder(root, baseEnvironment);
  expect(cold.code).toBe(0);
  expect(cold.stdout).not.toContain("cached");

  const warm = await runBuilder(root, baseEnvironment);
  expect(warm.code).toBe(0);
  expect(warm.stdout).toContain("cached @opengeni/demo");

  const dist = join(root, "packages", "demo", "dist");
  for (const directory of ["dist", "node_modules", ".opengeni"]) {
    mkdirSync(join(dist, directory), { recursive: true });
    writeFileSync(join(dist, directory, "reviewer-stale.txt"), "stale\n");
  }
  const nestedExtra = await runBuilder(root, baseEnvironment);
  expect(nestedExtra.code).toBe(0);
  expect(nestedExtra.stdout).not.toContain("cached");
  expect(existsSync(join(dist, "dist", "reviewer-stale.txt"))).toBe(false);

  await runBuilder(root, baseEnvironment);
  symlinkSync("artifact.txt", join(dist, "reviewer-link"));
  const symlinkExtra = await runBuilder(root, baseEnvironment);
  expect(symlinkExtra.code).toBe(0);
  expect(symlinkExtra.stdout).not.toContain("cached");
  expect(existsSync(join(dist, "reviewer-link"))).toBe(false);

  await runBuilder(root, baseEnvironment);
  chmodSync(outputPath(root), 0o755);
  const modeChange = await runBuilder(root, baseEnvironment);
  expect(modeChange.code).toBe(0);
  expect(modeChange.stdout).not.toContain("cached");
});

test("serializes concurrent builders and keeps environment keys bound to their bytes", async () => {
  const root = createFixture();
  const gate = join(root, "race-gate");
  const a = runBuilder(root, { OPENGENI_RACE: "A", OPE27_RACE_GATE: gate });
  expect(await waitForPath(`${gate}.a-started`)).toBe(true);

  const b = runBuilder(root, { OPENGENI_RACE: "B", OPE27_RACE_GATE: gate });
  // A correct lock keeps B outside the package build until A publishes. The
  // unlocked candidate reaches this marker while A is still holding the gate.
  await waitForPath(`${gate}.b-started`);
  writeFileSync(`${gate}.release`, "release\n");

  const [aResult, bResult] = await Promise.all([a, b]);
  expect(aResult.code).toBe(0);
  expect(bResult.code).toBe(0);

  const aAfterRace = await runBuilder(root, { OPENGENI_RACE: "A" });
  expect(aAfterRace.code).toBe(0);
  expect(aAfterRace.stdout).not.toContain("cached");
  expect(readFileSync(outputPath(root), "utf8")).toBe("A\n");

  const aWarm = await runBuilder(root, { OPENGENI_RACE: "A" });
  expect(aWarm.code).toBe(0);
  expect(aWarm.stdout).toContain("cached @opengeni/demo");
});
