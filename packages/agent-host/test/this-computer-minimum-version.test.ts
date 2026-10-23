import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ThisComputer, type ThisComputerDeps } from "../src/this-computer";

const SERVER = "https://agents.example.test";
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MACHINE = "11111111-1111-4111-8111-111111111111";

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

/** A connected stand-in agent of `version`, and every URL the app fetched. */
async function computerWithAgent(version: string, minimumAgentVersion?: string) {
  const dir = await mkdtemp(join(tmpdir(), "og-this-computer-min-"));
  const agentPath = join(dir, "agent");
  await writeFile(
    agentPath,
    [
      "#!/bin/sh",
      'case "$1" in',
      `  --version) echo "opengeni-agent ${version}" ;;`,
      `  connections) echo "  c1  ${SERVER}  workspace=${WORKSPACE}  agent=${MACHINE}" ;;`,
      "esac",
      'case "$3" in run) sleep 30 ;; esac',
      "",
    ].join("\n"),
  );
  await chmod(agentPath, 0o755);
  const fetched: string[] = [];
  const computer = new ThisComputer({
    platform: "linux",
    arch: "x64",
    home: dir,
    env: {},
    agentSigningKey: "",
    fetch: (url: string) => {
      fetched.push(url);
      return Promise.reject(new Error("offline"));
    },
    dataDir: dir,
    logDir: dir,
    agentPath,
    ...(minimumAgentVersion ? { minimumAgentVersion } : {}),
    mintEnrollToken: () => Promise.reject(new Error("unused")),
    allowAgents: () => Promise.resolve(),
    disallowAgents: () => Promise.resolve(),
    openSystemSettings: () => undefined,
    trash: () => Promise.resolve(),
    onChange: () => undefined,
  } as unknown as ThisComputerDeps);
  // The app connected this computer before.
  await writeFile(join(dir, "this-computer.json"), JSON.stringify({ adopted: true }));
  cleanup = async () => {
    await computer.shutdown();
    await rm(dir, { recursive: true, force: true });
  };
  return { computer, fetched };
}

test("an agent older than the app needs is replaced with that release from its server", async () => {
  const { computer, fetched } = await computerWithAgent("0.1.54", "0.1.124");
  await computer.boot();
  expect(fetched).toEqual([
    `${SERVER}/agent/v0.1.124/opengeni-agent-x86_64-unknown-linux-musl`,
    `${SERVER}/agent/v0.1.124/opengeni-agent-x86_64-unknown-linux-musl.minisig`,
  ]);
  // A failed replacement keeps the old agent working.
  expect((await computer.summary()).connected).toBe(true);
});

test("an agent at or past the minimum stays", async () => {
  const { computer, fetched } = await computerWithAgent("0.1.200", "0.1.124");
  await computer.boot();
  expect(fetched).toEqual([]);
});

test("without a minimum any working agent stays", async () => {
  const { computer, fetched } = await computerWithAgent("0.1.54");
  await computer.boot();
  expect(fetched).toEqual([]);
});
