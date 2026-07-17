import { describe, expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir, removeTempDir, runCommand } from "../src/process";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("compose-up", () => {
  test("pulls required images sequentially before compose starts with pulling disabled", async () => {
    const stub = await createDockerStub();
    try {
      const result = await runCommand(
        [
          "bun",
          "packages/testing/src/compose-up.ts",
          "opengeni_test_contract",
          "/tmp/compose.yml",
          JSON.stringify(["example/postgres:1", "example/nats:2"]),
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
        ["pull", "example/postgres:1"],
        [
          "create",
          "--name",
          "opengeni_test_contract-image-pin-0",
          "--label",
          "com.opengeni.test-image-pin=opengeni_test_contract",
          "example/postgres:1",
        ],
        ["pull", "example/nats:2"],
        [
          "create",
          "--name",
          "opengeni_test_contract-image-pin-1",
          "--label",
          "com.opengeni.test-image-pin=opengeni_test_contract",
          "example/nats:2",
        ],
        [
          "compose",
          "-p",
          "opengeni_test_contract",
          "-f",
          "/tmp/compose.yml",
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

  test("re-pulls when host cleanup reaps an image before its pin is created", async () => {
    const stub = await createDockerStub();
    try {
      const result = await runCommand(
        [
          "bun",
          "packages/testing/src/compose-up.ts",
          "opengeni_test_retry",
          "/tmp/compose.yml",
          JSON.stringify(["example/postgres:1"]),
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
        ["pull", "example/postgres:1"],
        [
          "create",
          "--name",
          "opengeni_test_retry-image-pin-0",
          "--label",
          "com.opengeni.test-image-pin=opengeni_test_retry",
          "example/postgres:1",
        ],
        ["pull", "example/postgres:1"],
        [
          "create",
          "--name",
          "opengeni_test_retry-image-pin-0",
          "--label",
          "com.opengeni.test-image-pin=opengeni_test_retry",
          "example/postgres:1",
        ],
        [
          "compose",
          "-p",
          "opengeni_test_retry",
          "-f",
          "/tmp/compose.yml",
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
});

async function createDockerStub(): Promise<{
  tempDir: string;
  logPath: string;
  failurePath: string;
}> {
  const tempDir = await makeTempDir("opengeni-compose-up-test-");
  const dockerStub = join(tempDir, "docker");
  const logPath = join(tempDir, "docker-calls.jsonl");
  const failurePath = join(tempDir, "failed-first-create");
  await writeFile(
    dockerStub,
    [
      "#!/usr/bin/env bun",
      'import { appendFile } from "node:fs/promises";',
      "const logPath = process.env.OPENGENI_COMPOSE_UP_TEST_LOG;",
      'if (!logPath) throw new Error("OPENGENI_COMPOSE_UP_TEST_LOG is required");',
      "const args = Bun.argv.slice(2);",
      "await appendFile(logPath, `${JSON.stringify(args)}\\n`);",
      "const failurePath = process.env.OPENGENI_COMPOSE_UP_FAIL_FIRST_CREATE;",
      'if (args[0] === "create" && failurePath && !(await Bun.file(failurePath).exists())) {',
      '  await Bun.write(failurePath, "failed");',
      '  console.error("No such image: synthetic reaper race");',
      "  process.exit(1);",
      "}",
    ].join("\n"),
  );
  await chmod(dockerStub, 0o755);
  return { tempDir, logPath, failurePath };
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
