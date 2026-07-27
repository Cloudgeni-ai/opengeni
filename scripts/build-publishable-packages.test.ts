import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
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

type BuilderHandle = {
  child: ChildProcess;
  result: Promise<BuilderResult>;
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
        scripts: { build: `${process.execPath} build-fixture.ts` },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(root, "packages", "demo", "target-a.txt"), "A\n");
  writeFileSync(join(root, "packages", "demo", "target-b.txt"), "B\n");
  writeFileSync(join(root, "packages", "demo", "mode-input.txt"), "mode\n");
  chmodSync(join(root, "packages", "demo", "mode-input.txt"), 0o644);
  symlinkSync("target-a.txt", join(root, "packages", "demo", "input-link.txt"));
  writeFileSync(
    join(root, "packages", "demo", "build-fixture.ts"),
    `import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const packageRoot = import.meta.dir;
const dist = join(packageRoot, "dist");
const variant = process.env.OPENGENI_BUILD_VARIANT ?? "BASE";
const gate = process.env.BUILD_FIXTURE_GATE;
const countPath = process.env.BUILD_FIXTURE_COUNT;
const orphanProbe = process.env.BUILD_FIXTURE_ORPHAN;
const marker = (name: string): string => join(gate ?? packageRoot, name);
const linkedInput = readFileSync(join(packageRoot, "input-link.txt"), "utf8").trim();
const modeInput = (lstatSync(join(packageRoot, "mode-input.txt")).mode & 0o7777).toString(8);

if (countPath) {
  appendFileSync(countPath, variant + "\\n");
}
if (variant === "B" && gate) {
  writeFileSync(marker("b-started"), "started\\n");
}
if (variant === "A" && gate) {
  writeFileSync(marker(orphanProbe ? "a-child-started" : "a-started"), "started\\n");
}
if (variant === "A" && gate) {
  while (!existsSync(marker("release"))) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (orphanProbe) {
    writeFileSync(marker("a-finished"), "finished\\n");
  }
}
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "artifact.txt"), variant + "|" + linkedInput + "|" + modeInput + "\\n");
if (variant === "B" && gate) {
  writeFileSync(marker("b-built"), "built\\n");
}
`,
  );

  return root;
}

function startBuilder(root: string, environment: Record<string, string> = {}): BuilderHandle {
  const child = spawn(process.execPath, ["scripts/build-publishable-packages.ts"], {
    cwd: root,
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = new Promise<BuilderResult>((resolve, reject) => {
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
  return { child, result };
}

function runBuilder(
  root: string,
  environment: Record<string, string> = {},
): Promise<BuilderResult> {
  return startBuilder(root, environment).result;
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
  const baseEnvironment = { OPENGENI_BUILD_VARIANT: "BASE" };

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
  const gate = join(root, "build-gate");
  mkdirSync(gate);
  const a = startBuilder(root, { OPENGENI_BUILD_VARIANT: "A", BUILD_FIXTURE_GATE: gate });
  expect(await waitForPath(join(gate, "a-started"))).toBe(true);

  const b = startBuilder(root, { OPENGENI_BUILD_VARIANT: "B", BUILD_FIXTURE_GATE: gate });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(existsSync(join(gate, "b-started"))).toBe(false);
  writeFileSync(join(gate, "release"), "release\n");

  const [aResult, bResult] = await Promise.all([a.result, b.result]);
  expect(aResult.code).toBe(0);
  expect(bResult.code).toBe(0);

  const aAfterRace = await runBuilder(root, { OPENGENI_BUILD_VARIANT: "A" });
  expect(aAfterRace.code).toBe(0);
  expect(aAfterRace.stdout).not.toContain("cached");
  expect(readFileSync(outputPath(root), "utf8")).toBe("A|A|644\n");

  const aWarm = await runBuilder(root, { OPENGENI_BUILD_VARIANT: "A" });
  expect(aWarm.code).toBe(0);
  expect(aWarm.stdout).toContain("cached @opengeni/demo");
});

test("does not expose an ownerless lock while initializer publication is paused", async () => {
  const root = createFixture();
  const pausePath = join(root, "initializer-pause");
  const countPath = join(root, "initializer-count.txt");
  const first = startBuilder(root, {
    OPENGENI_BUILD_VARIANT: "BASE",
    OPENGENI_BUILD_CACHE_PAUSE_AFTER_CANDIDATE: pausePath,
  });
  expect(await waitForPath(`${pausePath}.ready`)).toBe(true);

  const successor = await runBuilder(root, {
    OPENGENI_BUILD_VARIANT: "BASE",
    BUILD_FIXTURE_COUNT: countPath,
  });
  expect(successor.code).toBe(0);
  expect(readFileSync(countPath, "utf8").trim().split("\n")).toEqual(["BASE"]);

  writeFileSync(`${pausePath}.release`, "release\n");
  const firstResult = await first.result;
  expect(firstResult.code).toBe(0);
  expect(firstResult.stdout).toContain("[build:packages] @opengeni/demo");
  expect(readFileSync(countPath, "utf8").trim().split("\n")).toEqual(["BASE"]);
});

test("keeps the supervisor alive through atomic lock publication", async () => {
  const root = createFixture();
  const pausePath = join(root, "supervisor-publication-pause");
  const builder = startBuilder(root, {
    OPENGENI_BUILD_VARIANT: "BASE",
    OPENGENI_BUILD_CACHE_PAUSE_AFTER_SUPERVISOR_SPAWN: pausePath,
  });
  expect(await waitForPath(`${pausePath}.ready`)).toBe(true);

  const lockPath = join(root, ".opengeni", "build-cache", "packages", "_opengeni_demo.json.lock");
  expect(existsSync(lockPath)).toBe(false);

  writeFileSync(`${pausePath}.release`, "release\n");
  const result = await builder.result;
  expect(result.code).toBe(0);
  expect(readFileSync(outputPath(root), "utf8")).toBe("BASE|A|644\n");
});

test("rejects an A-B-A input mutation instead of publishing B under A", async () => {
  const root = createFixture();
  const fixturePath = join(root, "packages", "demo", "build-fixture.ts");
  let fixture = readFileSync(fixturePath, "utf8");
  fixture = fixture
    .replace(
      'if (variant === "A" && gate) {\n  while (!existsSync(marker("release"))) {',
      'if (variant === "A" && gate) {\n  while (!existsSync(marker("source-release"))) {',
    )
    .replace(
      "rmSync(dist, { recursive: true, force: true });",
      'const lateInput = readFileSync(join(packageRoot, "target-a.txt"), "utf8").trim();\nif (variant === "A" && gate) {\n  writeFileSync(marker("source-read"), "read\\n");\n  while (!existsSync(marker("release"))) {\n    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);\n  }\n}\nrmSync(dist, { recursive: true, force: true });',
    )
    .replace(
      'variant + "|" + linkedInput + "|" + modeInput',
      'variant + "|" + lateInput + "|" + modeInput',
    );
  writeFileSync(fixturePath, fixture);

  const gate = join(root, "aba-gate");
  mkdirSync(gate);
  const builder = startBuilder(root, {
    OPENGENI_BUILD_VARIANT: "A",
    BUILD_FIXTURE_GATE: gate,
  });
  expect(await waitForPath(join(gate, "a-started"))).toBe(true);
  writeFileSync(join(root, "packages", "demo", "target-a.txt"), "B\n");
  writeFileSync(join(gate, "source-release"), "release\n");
  expect(await waitForPath(join(gate, "source-read"))).toBe(true);
  writeFileSync(join(root, "packages", "demo", "target-a.txt"), "A\n");
  writeFileSync(join(gate, "release"), "release\n");

  const result = await builder.result;
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("source changed during @opengeni/demo");
  expect(readFileSync(outputPath(root), "utf8")).toBe("A|A|644\n");

  const warm = await runBuilder(root, { OPENGENI_BUILD_VARIANT: "A" });
  expect(warm.code).toBe(0);
  expect(warm.stdout).toContain("cached @opengeni/demo");
  expect(readFileSync(outputPath(root), "utf8")).toBe("A|A|644\n");
});

test("invalidates warm builds when an input symlink retargets or a mode changes", async () => {
  const root = createFixture();
  const environment = { OPENGENI_BUILD_VARIANT: "BASE" };

  const cold = await runBuilder(root, environment);
  expect(cold.code).toBe(0);
  expect(readFileSync(outputPath(root), "utf8")).toBe("BASE|A|644\n");
  const warm = await runBuilder(root, environment);
  expect(warm.stdout).toContain("cached @opengeni/demo");

  rmSync(join(root, "packages", "demo", "input-link.txt"));
  symlinkSync("target-b.txt", join(root, "packages", "demo", "input-link.txt"));
  const retargeted = await runBuilder(root, environment);
  expect(retargeted.code).toBe(0);
  expect(retargeted.stdout).not.toContain("cached");
  expect(readFileSync(outputPath(root), "utf8")).toBe("BASE|B|644\n");

  chmodSync(join(root, "packages", "demo", "mode-input.txt"), 0o755);
  const modeChanged = await runBuilder(root, environment);
  expect(modeChanged.code).toBe(0);
  expect(modeChanged.stdout).not.toContain("cached");
  expect(readFileSync(outputPath(root), "utf8")).toBe("BASE|B|755\n");
});

test("reclaims an ownerless stale lock without waiting for the lock deadline", async () => {
  const root = createFixture();
  const lockPath = join(root, ".opengeni", "build-cache", "packages", "_opengeni_demo.json.lock");
  mkdirSync(lockPath, { recursive: true });
  const staleReclaimerPath = join(lockPath, "reclaim");
  mkdirSync(staleReclaimerPath);
  const staleTime = new Date(Date.now() - 2_000);
  utimesSync(lockPath, staleTime, staleTime);
  utimesSync(staleReclaimerPath, staleTime, staleTime);

  const startedAt = Date.now();
  const result = await runBuilder(root, { OPENGENI_BUILD_VARIANT: "BASE" });
  expect(Date.now() - startedAt).toBeLessThan(2_000);
  expect(result.code).toBe(0);
  expect(readFileSync(outputPath(root), "utf8")).toBe("BASE|A|644\n");
});

test("admits one builder when many waiters reclaim a dead-owner lock", async () => {
  const root = createFixture();
  const lockPath = join(root, ".opengeni", "build-cache", "packages", "_opengeni_demo.json.lock");
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(
    join(lockPath, "owner"),
    `${JSON.stringify({
      token: "dead-owner",
      pid: 2_147_483_647,
      buildPid: null,
      processGroupId: null,
      state: "building",
      createdAt: Date.now() - 60_000,
    })}\n`,
  );
  const countPath = join(root, "build-count.txt");
  const environment = {
    OPENGENI_BUILD_VARIANT: "BASE",
    BUILD_FIXTURE_COUNT: countPath,
  };

  const builders = Array.from({ length: 24 }, () => runBuilder(root, environment));
  const results = await Promise.all(builders);
  expect(results.every((result) => result.code === 0)).toBe(true);
  expect(readFileSync(countPath, "utf8").trim().split("\n")).toEqual(["BASE"]);
  expect(readFileSync(outputPath(root), "utf8")).toBe("BASE|A|644\n");
});

test("drains a killed builder's detached child before admitting its successor", async () => {
  const root = createFixture();
  const gate = join(root, "orphan-gate");
  mkdirSync(gate);
  const a = startBuilder(root, {
    OPENGENI_BUILD_VARIANT: "A",
    BUILD_FIXTURE_GATE: gate,
    BUILD_FIXTURE_ORPHAN: "1",
  });
  expect(await waitForPath(join(gate, "a-child-started"))).toBe(true);

  const b = startBuilder(root, {
    OPENGENI_BUILD_VARIANT: "B",
    BUILD_FIXTURE_GATE: gate,
    BUILD_FIXTURE_ORPHAN: "1",
  });
  expect(a.child.kill("SIGKILL")).toBe(true);

  const aResult = await a.result;
  const bResult = await b.result;
  expect(aResult.code).not.toBe(0);
  expect(bResult.code).toBe(0);
  expect(existsSync(join(gate, "b-built"))).toBe(true);

  writeFileSync(join(gate, "release"), "release\n");
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(existsSync(join(gate, "a-finished"))).toBe(false);
  expect(readFileSync(outputPath(root), "utf8")).toBe("B|A|644\n");
});

test("restores a successor generation after a stale reclaimer loses the ABA race", async () => {
  const root = createFixture();
  const lockPath = join(root, ".opengeni", "build-cache", "packages", "_opengeni_demo.json.lock");
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(
    join(lockPath, "owner"),
    `${JSON.stringify({
      token: "dead-owner",
      pid: 2_147_483_647,
      buildPid: null,
      processGroupId: null,
      state: "building",
      createdAt: Date.now() - 60_000,
    })}\n`,
  );

  const pausePath = join(root, "reclaimer-pause");
  const builder = startBuilder(root, {
    OPENGENI_BUILD_VARIANT: "BASE",
    OPENGENI_BUILD_CACHE_PAUSE_BEFORE_RECLAIM_QUARANTINE: pausePath,
  });
  expect(await waitForPath(`${pausePath}.ready`)).toBe(true);

  rmSync(lockPath, { recursive: true, force: true });
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(
    join(lockPath, "owner"),
    `${JSON.stringify({
      token: "successor-generation",
      pid: process.pid,
      requesterPid: process.pid,
      buildPid: null,
      processGroupId: null,
      state: "publishing",
      createdAt: Date.now(),
    })}\n`,
  );
  writeFileSync(`${pausePath}.release`, "release\n");

  expect(await waitForPath(join(lockPath, "owner"))).toBe(true);
  expect(JSON.parse(readFileSync(join(lockPath, "owner"), "utf8"))).toMatchObject({
    token: "successor-generation",
  });
  rmSync(lockPath, { recursive: true, force: true });

  const result = await builder.result;
  expect(result.code).toBe(0);
  expect(readFileSync(outputPath(root), "utf8")).toBe("BASE|A|644\n");
});

test("drains the build group when the wrapper dies during supervisor spawn publication", async () => {
  const root = createFixture();
  const gate = join(root, "spawn-window-gate");
  const pausePath = join(root, "spawn-window-pause");
  mkdirSync(gate);
  const builder = startBuilder(root, {
    OPENGENI_BUILD_VARIANT: "A",
    BUILD_FIXTURE_GATE: gate,
    BUILD_FIXTURE_ORPHAN: "1",
    OPENGENI_BUILD_CACHE_PAUSE_AFTER_BUILD_SPAWN: pausePath,
  });
  expect(await waitForPath(`${pausePath}.ready`)).toBe(true);

  const lockPath = join(root, ".opengeni", "build-cache", "packages", "_opengeni_demo.json.lock");
  const owner = JSON.parse(readFileSync(join(lockPath, "owner"), "utf8"));
  expect(owner.buildPid).toBeNull();
  expect(owner.processGroupId).toBe(owner.pid);
  expect(builder.child.kill("SIGKILL")).toBe(true);
  writeFileSync(`${pausePath}.release`, "release\n");
  const deadWrapper = await builder.result;
  expect(deadWrapper.code).not.toBe(0);

  const successor = await runBuilder(root, {
    OPENGENI_BUILD_VARIANT: "B",
    BUILD_FIXTURE_GATE: gate,
    BUILD_FIXTURE_ORPHAN: "1",
  });
  expect(successor.code).toBe(0);
  expect(readFileSync(outputPath(root), "utf8")).toBe("B|A|644\n");
});
