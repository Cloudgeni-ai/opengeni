import { describe, expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir, removeTempDir, runCommand } from "../src/process";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("compose-up", () => {
  test("uses local immutable image IDs before compose starts with pulling disabled", async () => {
    const stub = await createDockerStub();
    try {
      const composeFile = join(stub.tempDir, "compose.yml");
      await writeFile(composeFile, "services: {}\n");
      const result = await runCommand(
        [
          "bun",
          "packages/testing/src/compose-up.ts",
          "opengeni_test_contract",
          composeFile,
          JSON.stringify({ postgres: "example/postgres:1", nats: "example/nats:2" }),
        ],
        {
          cwd: repoRoot,
          env: {
            PATH: `${stub.tempDir}:${process.env.PATH ?? ""}`,
            OPENGENI_COMPOSE_UP_TEST_LOG: stub.logPath,
          },
          timeoutMs: 15_000,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      const calls = await readDockerCalls(stub.logPath);
      expect(calls).toEqual([
        ["rm", "-f", "-v", "opengeni_test_contract-image-pin-0"],
        ["image", "inspect", "--format", "{{.Id}}", "example/postgres:1"],
        [
          "create",
          "--name",
          "opengeni_test_contract-image-pin-0",
          "--label",
          "com.opengeni.test-image-pin=opengeni_test_contract",
          "--entrypoint",
          "/bin/sh",
          "example/postgres:1",
          "-c",
          "while :; do sleep 3600; done",
        ],
        ["start", "opengeni_test_contract-image-pin-0"],
        [
          "inspect",
          "--format",
          "{{.Image}} {{.State.Running}}",
          "opengeni_test_contract-image-pin-0",
        ],
        ["image", "inspect", "--format", "{{.Id}}", imageId(0)],
        ["rm", "-f", "-v", "opengeni_test_contract-image-pin-1"],
        ["image", "inspect", "--format", "{{.Id}}", "example/nats:2"],
        [
          "create",
          "--name",
          "opengeni_test_contract-image-pin-1",
          "--label",
          "com.opengeni.test-image-pin=opengeni_test_contract",
          "--entrypoint",
          "/bin/sh",
          "example/nats:2",
          "-c",
          "while :; do sleep 3600; done",
        ],
        ["start", "opengeni_test_contract-image-pin-1"],
        [
          "inspect",
          "--format",
          "{{.Image}} {{.State.Running}}",
          "opengeni_test_contract-image-pin-1",
        ],
        ["image", "inspect", "--format", "{{.Id}}", imageId(1)],
        ["image", "inspect", "--format", "{{.Id}}", imageId(0)],
        ["image", "inspect", "--format", "{{.Id}}", imageId(1)],
        [
          "compose",
          "-p",
          "opengeni_test_contract",
          "-f",
          composeFile,
          "-f",
          `${composeFile}.images.json`,
          "up",
          "-d",
          "--pull",
          "never",
        ],
      ]);
      expect(await readJsonFile(`${composeFile}.images.json`)).toEqual({
        services: {
          postgres: { image: imageId(0) },
          nats: { image: imageId(1) },
        },
      });
    } finally {
      await removeTempDir(stub.tempDir);
    }
  });

  test("retries when cleanup reaps an image between local inspection and pin creation", async () => {
    const stub = await createDockerStub();
    try {
      const composeFile = join(stub.tempDir, "compose.yml");
      await writeFile(composeFile, "services: {}\n");
      const result = await runCommand(
        [
          "bun",
          "packages/testing/src/compose-up.ts",
          "opengeni_test_retry",
          composeFile,
          JSON.stringify({ postgres: "example/postgres:1" }),
        ],
        {
          cwd: repoRoot,
          env: {
            PATH: `${stub.tempDir}:${process.env.PATH ?? ""}`,
            OPENGENI_COMPOSE_UP_TEST_LOG: stub.logPath,
            OPENGENI_COMPOSE_UP_FAIL_FIRST_CREATE: stub.failurePath,
          },
          timeoutMs: 15_000,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(await readDockerCalls(stub.logPath)).toEqual([
        ["rm", "-f", "-v", "opengeni_test_retry-image-pin-0"],
        ["image", "inspect", "--format", "{{.Id}}", "example/postgres:1"],
        [
          "create",
          "--name",
          "opengeni_test_retry-image-pin-0",
          "--label",
          "com.opengeni.test-image-pin=opengeni_test_retry",
          "--entrypoint",
          "/bin/sh",
          "example/postgres:1",
          "-c",
          "while :; do sleep 3600; done",
        ],
        ["rm", "-f", "-v", "opengeni_test_retry-image-pin-0"],
        ["rm", "-f", "-v", "opengeni_test_retry-image-pin-0"],
        ["image", "inspect", "--format", "{{.Id}}", "example/postgres:1"],
        [
          "create",
          "--name",
          "opengeni_test_retry-image-pin-0",
          "--label",
          "com.opengeni.test-image-pin=opengeni_test_retry",
          "--entrypoint",
          "/bin/sh",
          "example/postgres:1",
          "-c",
          "while :; do sleep 3600; done",
        ],
        ["start", "opengeni_test_retry-image-pin-0"],
        ["inspect", "--format", "{{.Image}} {{.State.Running}}", "opengeni_test_retry-image-pin-0"],
        ["image", "inspect", "--format", "{{.Id}}", imageId(0)],
        ["image", "inspect", "--format", "{{.Id}}", imageId(0)],
        [
          "compose",
          "-p",
          "opengeni_test_retry",
          "-f",
          composeFile,
          "-f",
          `${composeFile}.images.json`,
          "up",
          "-d",
          "--pull",
          "never",
        ],
      ]);
    } finally {
      await removeTempDir(stub.tempDir);
    }
  });

  test("restores image metadata when an in-flight prune commits after the pin starts", async () => {
    const stub = await createDockerStub();
    try {
      const composeFile = join(stub.tempDir, "compose.yml");
      await writeFile(composeFile, "services: {}\n");
      const result = await runCommand(
        [
          "bun",
          "packages/testing/src/compose-up.ts",
          "opengeni_test_restore",
          composeFile,
          JSON.stringify({ postgres: "example/postgres:1" }),
        ],
        {
          cwd: repoRoot,
          env: {
            PATH: `${stub.tempDir}:${process.env.PATH ?? ""}`,
            OPENGENI_COMPOSE_UP_TEST_LOG: stub.logPath,
            OPENGENI_COMPOSE_UP_FAIL_FIRST_IMAGE_INSPECT: stub.imageFailurePath,
          },
          timeoutMs: 15_000,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(await readDockerCalls(stub.logPath)).toEqual([
        ["rm", "-f", "-v", "opengeni_test_restore-image-pin-0"],
        ["image", "inspect", "--format", "{{.Id}}", "example/postgres:1"],
        [
          "create",
          "--name",
          "opengeni_test_restore-image-pin-0",
          "--label",
          "com.opengeni.test-image-pin=opengeni_test_restore",
          "--entrypoint",
          "/bin/sh",
          "example/postgres:1",
          "-c",
          "while :; do sleep 3600; done",
        ],
        ["start", "opengeni_test_restore-image-pin-0"],
        [
          "inspect",
          "--format",
          "{{.Image}} {{.State.Running}}",
          "opengeni_test_restore-image-pin-0",
        ],
        ["image", "inspect", "--format", "{{.Id}}", imageId(0)],
        ["pull", "example/postgres:1"],
        ["image", "inspect", "--format", "{{.Id}}", "example/postgres:1"],
        ["image", "inspect", "--format", "{{.Id}}", imageId(0)],
        [
          "compose",
          "-p",
          "opengeni_test_restore",
          "-f",
          composeFile,
          "-f",
          `${composeFile}.images.json`,
          "up",
          "-d",
          "--pull",
          "never",
        ],
      ]);
    } finally {
      await removeTempDir(stub.tempDir);
    }
  });

  test("retries a transient registry timeout only when the required image is missing", async () => {
    const stub = await createDockerStub();
    try {
      const composeFile = join(stub.tempDir, "compose.yml");
      await writeFile(composeFile, "services: {}\n");
      const result = await runCommand(
        [
          "bun",
          "packages/testing/src/compose-up.ts",
          "opengeni_test_pull_retry",
          composeFile,
          JSON.stringify({ postgres: "example/postgres:1" }),
        ],
        {
          cwd: repoRoot,
          env: {
            PATH: `${stub.tempDir}:${process.env.PATH ?? ""}`,
            OPENGENI_COMPOSE_UP_TEST_LOG: stub.logPath,
            OPENGENI_COMPOSE_UP_FAIL_FIRST_REFERENCE_INSPECT: stub.missingImagePath,
            OPENGENI_COMPOSE_UP_FAIL_FIRST_PULL: stub.pullFailurePath,
          },
          timeoutMs: 15_000,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(await readDockerCalls(stub.logPath)).toEqual([
        ["rm", "-f", "-v", "opengeni_test_pull_retry-image-pin-0"],
        ["image", "inspect", "--format", "{{.Id}}", "example/postgres:1"],
        ["pull", "example/postgres:1"],
        ["pull", "example/postgres:1"],
        [
          "create",
          "--name",
          "opengeni_test_pull_retry-image-pin-0",
          "--label",
          "com.opengeni.test-image-pin=opengeni_test_pull_retry",
          "--entrypoint",
          "/bin/sh",
          "example/postgres:1",
          "-c",
          "while :; do sleep 3600; done",
        ],
        ["start", "opengeni_test_pull_retry-image-pin-0"],
        [
          "inspect",
          "--format",
          "{{.Image}} {{.State.Running}}",
          "opengeni_test_pull_retry-image-pin-0",
        ],
        ["image", "inspect", "--format", "{{.Id}}", imageId(0)],
        ["image", "inspect", "--format", "{{.Id}}", imageId(0)],
        [
          "compose",
          "-p",
          "opengeni_test_pull_retry",
          "-f",
          composeFile,
          "-f",
          `${composeFile}.images.json`,
          "up",
          "-d",
          "--pull",
          "never",
        ],
      ]);
    } finally {
      await removeTempDir(stub.tempDir);
    }
  });

  test("rejects malformed service image maps before invoking Docker", async () => {
    const stub = await createDockerStub();
    try {
      for (const encodedImages of [
        "[]",
        "{}",
        "{",
        '{"bad/name":"example/image:1"}',
        '{"postgres":" example/image:1"}',
        '{"__proto__":"example/image:1"}',
      ]) {
        const result = await runCommand(
          [
            "bun",
            "packages/testing/src/compose-up.ts",
            "opengeni_test_invalid",
            join(stub.tempDir, "compose.yml"),
            encodedImages,
          ],
          {
            cwd: repoRoot,
            env: {
              PATH: `${stub.tempDir}:${process.env.PATH ?? ""}`,
              OPENGENI_COMPOSE_UP_TEST_LOG: stub.logPath,
            },
            timeoutMs: 15_000,
          },
        );
        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(64);
      }
      expect(await Bun.file(stub.logPath).exists()).toBe(false);
    } finally {
      await removeTempDir(stub.tempDir);
    }
  });
});

async function createDockerStub(): Promise<{
  tempDir: string;
  logPath: string;
  failurePath: string;
  imageFailurePath: string;
  missingImagePath: string;
  pullFailurePath: string;
}> {
  const tempDir = await makeTempDir("opengeni-compose-up-test-");
  const dockerStub = join(tempDir, "docker");
  const logPath = join(tempDir, "docker-calls.jsonl");
  const failurePath = join(tempDir, "failed-first-create");
  const imageFailurePath = join(tempDir, "failed-first-image-inspect");
  const missingImagePath = join(tempDir, "failed-first-reference-inspect");
  const pullFailurePath = join(tempDir, "failed-first-pull");
  await writeFile(
    dockerStub,
    [
      "#!/usr/bin/env bun",
      'import { appendFile } from "node:fs/promises";',
      "const logPath = process.env.OPENGENI_COMPOSE_UP_TEST_LOG;",
      'if (!logPath) throw new Error("OPENGENI_COMPOSE_UP_TEST_LOG is required");',
      "const args = Bun.argv.slice(2);",
      "await appendFile(logPath, `${JSON.stringify(args)}\\n`);",
      "const pullFailurePath = process.env.OPENGENI_COMPOSE_UP_FAIL_FIRST_PULL;",
      'if (args[0] === "pull" && pullFailurePath && !(await Bun.file(pullFailurePath).exists())) {',
      '  await Bun.write(pullFailurePath, "failed");',
      '  console.error("Client.Timeout exceeded while awaiting headers");',
      "  process.exit(1);",
      "}",
      "const failurePath = process.env.OPENGENI_COMPOSE_UP_FAIL_FIRST_CREATE;",
      'if (args[0] === "create" && failurePath && !(await Bun.file(failurePath).exists())) {',
      '  await Bun.write(failurePath, "failed");',
      '  console.error("No such image: synthetic reaper race");',
      "  process.exit(1);",
      "}",
      'if (args[0] === "inspect") {',
      '  const pinName = args.at(-1) ?? "";',
      '  const index = Number(pinName.match(/-image-pin-(\\d+)$/)?.[1] ?? "0");',
      "  console.log(`sha256:${String(index + 1).repeat(64)} true`);",
      "}",
      'if (args[0] === "image" && args[1] === "inspect") {',
      '  const reference = args.at(-1) ?? "";',
      "  const missingImagePath = process.env.OPENGENI_COMPOSE_UP_FAIL_FIRST_REFERENCE_INSPECT;",
      '  if (missingImagePath && !reference.startsWith("sha256:") && !(await Bun.file(missingImagePath).exists())) {',
      '    await Bun.write(missingImagePath, "failed");',
      "    console.error(`No such image: ${reference}`);",
      "    process.exit(1);",
      "  }",
      "  const failurePath = process.env.OPENGENI_COMPOSE_UP_FAIL_FIRST_IMAGE_INSPECT;",
      '  if (failurePath && reference.startsWith("sha256:") && !(await Bun.file(failurePath).exists())) {',
      '    await Bun.write(failurePath, "failed");',
      "    console.error(`No such image: ${reference}`);",
      "    process.exit(1);",
      "  }",
      '  if (reference.startsWith("sha256:")) console.log(reference);',
      '  else console.log(`sha256:${reference.includes("nats") ? "2".repeat(64) : "1".repeat(64)}`);',
      "}",
    ].join("\n"),
  );
  await chmod(dockerStub, 0o755);
  return {
    tempDir,
    logPath,
    failurePath,
    imageFailurePath,
    missingImagePath,
    pullFailurePath,
  };
}

function imageId(index: number): string {
  return `sha256:${String(index + 1).repeat(64)}`;
}

async function readJsonFile(path: string): Promise<unknown> {
  const contents = await Bun.file(path).text();
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`expected valid JSON in ${path}`, { cause: error });
  }
}

async function readDockerCalls(logPath: string): Promise<string[][]> {
  return (await Bun.file(logPath).text()).trim().split("\n").map(parseDockerCall);
}

function parseDockerCall(line: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`docker stub emitted invalid JSON: ${line}`, { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error(`docker stub emitted a non-string argument list: ${line}`);
  }
  return parsed;
}
