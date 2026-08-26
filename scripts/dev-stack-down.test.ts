import { afterEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = new URL("./dev-stack-down.sh", import.meta.url).pathname;
const projectHelperPath = new URL("./dev-stack-project.sh", import.meta.url).pathname;
const backendHelperPath = new URL("./dev-stack-backend.sh", import.meta.url).pathname;
const nativeHelperPath = new URL("./dev-native-infra.sh", import.meta.url).pathname;
const devStackPath = new URL("./dev-stack.sh", import.meta.url).pathname;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * Run the script from a throwaway repository root (the script resolves its root
 * from its own location) with a logging fake `docker` first on PATH, so the
 * test can never touch the real checkout's .env.runtime or Docker state.
 */
async function runWithFakeDocker(
  args: string[],
  fakeDockerBody: string,
  options: {
    runtimeProject?: string;
    runtimeBackend?: "docker" | "native";
    environment?: Record<string, string>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "opengeni-dev-stack-down-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "scripts"));
  await copyFile(scriptPath, join(root, "scripts", "dev-stack-down.sh"));
  await copyFile(projectHelperPath, join(root, "scripts", "dev-stack-project.sh"));
  await copyFile(backendHelperPath, join(root, "scripts", "dev-stack-backend.sh"));
  const runtimeBackend = options.runtimeBackend ?? "docker";
  await writeFile(
    join(root, ".env.runtime"),
    `${options.runtimeProject ? `COMPOSE_PROJECT_NAME=${options.runtimeProject}\n` : ""}OPENGENI_DEV_BACKEND=${runtimeBackend}\n`,
  );
  const bin = join(root, "bin");
  await mkdir(bin);
  const log = join(root, "docker.log");
  await writeFile(
    join(bin, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
${fakeDockerBody}
exit 0
`,
  );
  await chmod(join(bin, "docker"), 0o755);
  const nativeLog = join(root, "native.log");
  await writeFile(
    join(root, "scripts", "dev-native-infra.sh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_NATIVE_LOG"
`,
  );
  await chmod(join(root, "scripts", "dev-native-infra.sh"), 0o755);
  const child = Bun.spawn(["bash", join(root, "scripts", "dev-stack-down.sh"), ...args], {
    env: {
      ...Bun.env,
      PATH: `${bin}:${Bun.env.PATH ?? ""}`,
      FAKE_DOCKER_LOG: log,
      FAKE_NATIVE_LOG: nativeLog,
      OPENGENI_COMPOSE_PROJECT: "Down Test Stack",
      ...options.environment,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const logFile = Bun.file(log);
  const calls = (await logFile.exists()) ? (await logFile.text()).trim().split("\n") : [];
  const nativeLogFile = Bun.file(nativeLog);
  const nativeCalls = (await nativeLogFile.exists())
    ? (await nativeLogFile.text()).trim().split("\n")
    : [];
  const runtimeRemains = await Bun.file(join(root, ".env.runtime")).exists();
  return { exitCode, stdout, stderr, calls, nativeCalls, runtimeRemains };
}

describe("dev-stack-down.sh", () => {
  test("is valid bash and shares the exact project derivation with dev-stack.sh", async () => {
    for (const path of [scriptPath, projectHelperPath, backendHelperPath, nativeHelperPath]) {
      const syntax = Bun.spawn(["bash", "-n", path], { stdout: "pipe", stderr: "pipe" });
      expect(await syntax.exited).toBe(0);
    }
    const devStack = await Bun.file(devStackPath).text();
    const down = await Bun.file(scriptPath).text();
    for (const source of [devStack, down]) {
      expect(source).toContain(". ./scripts/dev-stack-project.sh");
      expect(source).toContain('COMPOSE_PROJECT_NAME="$(resolve_compose_project_name)"');
    }
    expect(devStack).not.toContain("slugify() {");
  });

  test("down stops only this worktree's compose project and its attached sandbox containers", async () => {
    const result = await runWithFakeDocker(
      [],
      `case "$*" in
  "ps -aq --filter network=down-test-stack_default --filter label=openai-agents-sandbox=true") printf 'abc123\\n' ;;
esac`,
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.calls).toEqual([
      "ps -aq --filter network=down-test-stack_default --filter label=openai-agents-sandbox=true",
      "rm -f abc123",
      "compose --profile minio down --remove-orphans",
    ]);
    expect(result.stdout).toContain("project=down-test-stack backend=docker (down)");
  });

  test("prefers the project recorded by the last `bun run dev`", async () => {
    const result = await runWithFakeDocker([], "", { runtimeProject: "recorded-stack" });
    expect(result.exitCode).toBe(0);
    expect(result.calls).toEqual([
      "ps -aq --filter network=recorded-stack_default --filter label=openai-agents-sandbox=true",
      "compose --profile minio down --remove-orphans",
    ]);
    expect(result.runtimeRemains).toBe(true);
  });

  test("clean removes volumes, .env.runtime, and only this project's source-tagged images", async () => {
    const result = await runWithFakeDocker(
      ["--clean", "--yes"],
      `case "$*" in
  "image ls --format {{.Repository}}:{{.Tag}} opengeni-sandbox")
    printf '%s\\n' \\
      opengeni-sandbox:local-aaaaaaaaaaaa-down-test-stack \\
      opengeni-sandbox:local-bbbbbbbbbbbb-other-stack \\
      opengeni-sandbox:local-cccccccccccc-down-test-stack-2 \\
      opengeni-sandbox:local ;;
esac`,
      { runtimeProject: "down-test-stack" },
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.calls).toEqual([
      "ps -aq --filter network=down-test-stack_default --filter label=openai-agents-sandbox=true",
      "compose --profile minio down --remove-orphans --volumes",
      "image ls --format {{.Repository}}:{{.Tag}} opengeni-sandbox",
      "image rm opengeni-sandbox:local-aaaaaaaaaaaa-down-test-stack",
    ]);
    expect(result.calls.join("\n")).not.toContain("prune");
    expect(result.runtimeRemains).toBe(false);
  });

  test("native down never touches Docker and clean delegates exact project data removal", async () => {
    const result = await runWithFakeDocker(["--clean", "--yes"], "", {
      runtimeProject: "native-test-stack",
      runtimeBackend: "native",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.calls).toEqual([]);
    expect(result.nativeCalls).toEqual(["down --clean"]);
    expect(result.runtimeRemains).toBe(false);
    expect(result.stdout).toContain("project=native-test-stack backend=native (clean)");
  });

  test("rejects unknown arguments before touching Docker", async () => {
    const result = await runWithFakeDocker(["--all"], "");
    expect(result.exitCode).toBe(2);
    expect(result.calls).toEqual([]);
  });
});
