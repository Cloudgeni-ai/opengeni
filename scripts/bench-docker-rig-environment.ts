#!/usr/bin/env bun

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getSettings, type Settings } from "@opengeni/config";
import { createSandboxClient, terminateManagedSandboxSession } from "@opengeni/runtime";

const image = stringArgument("--image", "opengeni-sandbox:local");
const cases = [
  { name: "one-max-value", entries: 1, valueChars: 32_768, encoding: "ascii" },
  { name: "24-max-values", entries: 24, valueChars: 32_768, encoding: "ascii" },
  { name: "28-max-values", entries: 28, valueChars: 32_768, encoding: "ascii" },
  { name: "30-max-values", entries: 30, valueChars: 32_768, encoding: "ascii" },
  { name: "31-max-values", entries: 31, valueChars: 32_768, encoding: "ascii" },
  { name: "32-max-values", entries: 32, valueChars: 32_768, encoding: "ascii" },
  { name: "8-max-three-byte-values", entries: 8, valueChars: 32_768, encoding: "utf8_3" },
  { name: "10-max-three-byte-values", entries: 10, valueChars: 32_768, encoding: "utf8_3" },
  {
    name: "one-full-variable-set",
    entries: 100,
    valueChars: 32_768,
    encoding: "ascii",
  },
  { name: "500-medium-values", entries: 500, valueChars: 4_096, encoding: "ascii" },
  {
    name: "all-rig-variable-names-small",
    entries: 2_500,
    valueChars: 16,
    encoding: "ascii",
  },
] as const;

const settings: Settings = {
  ...getSettings(),
  sandboxBackend: "docker",
  dockerImage: image,
};

const receipts: Array<Record<string, unknown>> = [];
for (const scenario of cases) {
  const workspaceBaseDir = await mkdtemp(join(tmpdir(), "opengeni-rig-env-bench-"));
  const environment = Object.fromEntries(
    Array.from({ length: scenario.entries }, (_, index) => [
      `RIG_BENCH_${String(index).padStart(4, "0")}`,
      value(index, scenario.valueChars, scenario.encoding),
    ]),
  );
  const expectedValueBytes = Buffer.byteLength(environment.RIG_BENCH_0000!);
  const environmentBytes = Object.entries(environment).reduce(
    (total, [name, contents]) =>
      total + Buffer.byteLength(name) + 1 + Buffer.byteLength(contents) + 1,
    0,
  );
  const client = createSandboxClient({ ...settings, dockerWorkspaceBaseDir: workspaceBaseDir }) as {
    create?: (options: { manifest: { environment: Record<string, string> } }) => Promise<unknown>;
  };
  if (!client.create) throw new Error("Docker sandbox client has no create operation");
  const envFileControl = await runDockerEnvFileControl(
    workspaceBaseDir,
    environment,
    expectedValueBytes,
  );
  let session: unknown;
  const startedAt = performance.now();
  try {
    session = await client.create({ manifest: { environment } });
    const createMs = performance.now() - startedAt;
    const probe = await exec(
      session,
      `test "$(printf %s "${"$"}RIG_BENCH_0000" | wc -c | tr -d ' ')" -eq ${expectedValueBytes} && printf verified`,
    );
    receipts.push({
      ...scenario,
      environmentBytes,
      envFileControl,
      createMs,
      outcome: probe.includes("verified") ? "created_and_verified" : "probe_failed",
      error: probe.includes("verified") ? null : probe.slice(0, 500),
    });
  } catch (error) {
    receipts.push({
      ...scenario,
      environmentBytes,
      envFileControl,
      createMs: performance.now() - startedAt,
      outcome: "create_failed",
      error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
    });
  } finally {
    if (session) {
      await terminateManagedSandboxSession(
        client,
        (session as { state?: unknown }).state,
        session,
      ).catch(() => undefined);
    }
    await rm(workspaceBaseDir, { recursive: true, force: true });
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      modelCalls: 0,
      image,
      invariant:
        "The exact Docker sandbox provider receives every generated environment value through the same create manifest used by a turn; successful cases verify one maximum-length value inside the container.",
      receipts,
    },
    null,
    2,
  )}\n`,
);

function value(index: number, chars: number, encoding: "ascii" | "utf8_3"): string {
  const prefix = `${String(index).padStart(6, "0")}:`;
  return `${prefix}${(encoding === "ascii" ? "x" : "界").repeat(chars - prefix.length)}`;
}

async function runDockerEnvFileControl(
  workspaceBaseDir: string,
  environment: Record<string, string>,
  expectedValueBytes: number,
): Promise<{ outcome: string; elapsedMs: number; error: string | null }> {
  const path = join(workspaceBaseDir, "environment.list");
  await writeFile(
    path,
    `${Object.entries(environment)
      .map(([name, contents]) => `${name}=${contents}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
  const startedAt = performance.now();
  const process = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "--env-file",
      path,
      image,
      "/bin/sh",
      "-c",
      `test "${"$"}{#RIG_BENCH_0000}" -eq ${expectedValueBytes} && printf verified`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  const elapsedMs = performance.now() - startedAt;
  return {
    outcome: exitCode === 0 && stdout.includes("verified") ? "created_and_verified" : "failed",
    elapsedMs,
    error: exitCode === 0 ? null : stderr.trim().slice(0, 1_000),
  };
}

async function exec(session: unknown, cmd: string): Promise<string> {
  const target = session as {
    exec?: (args: {
      cmd: string;
      yieldTimeMs: number;
      maxOutputTokens: number;
    }) => Promise<unknown>;
    execCommand?: (args: {
      cmd: string;
      yieldTimeMs: number;
      maxOutputTokens: number;
    }) => Promise<unknown>;
  };
  const run = target.exec ?? target.execCommand;
  if (!run) throw new Error("Docker sandbox session has no exec operation");
  const result = await run.call(target, { cmd, yieldTimeMs: 30_000, maxOutputTokens: 1_000 });
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return String(result ?? "");
  const record = result as { output?: unknown; stdout?: unknown; stderr?: unknown };
  return [record.output, record.stdout, record.stderr]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

function stringArgument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const candidate = index < 0 ? "" : (process.argv[index + 1] ?? "").trim();
  return candidate || fallback;
}
