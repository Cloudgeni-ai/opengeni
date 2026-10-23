import { afterEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ThisComputer, type ThisComputerDeps } from "../src/this-computer";

const SERVER = "https://agents.example.test";
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MACHINE = "11111111-1111-4111-8111-111111111111";
const ASSET = "opengeni-agent-x86_64-unknown-linux-musl";

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

/** A connected stand-in agent that reports `version`. */
function agentScript(version: string): string {
  return [
    "#!/bin/sh",
    'case "$1" in',
    `  --version) echo "opengeni-agent ${version}" ;;`,
    `  connections) echo "  c1  ${SERVER}  workspace=${WORKSPACE}  agent=${MACHINE}" ;;`,
    "esac",
    'case "$3" in run) sleep 30 ;; esac',
    "",
  ].join("\n");
}

/** A minisign key pair and signer, the way the release signs agent files. */
function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const keyId = Buffer.from("0123456789abcdef", "hex");
  const publicLine = Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64");
  const signFile = (bytes: Buffer) => {
    const comment = `timestamp:1\tfile:${ASSET}\tprehashed`;
    const hash = createHash("blake2b512").update(bytes).digest();
    const signature = sign(null, hash, privateKey);
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    return [
      "untrusted comment: signature from rsign secret key",
      Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64"),
      `trusted comment: ${comment}`,
      global.toString("base64"),
      "",
    ].join("\n");
  };
  return { publicLine, signFile };
}

/**
 * A computer whose downloaded agent is `installed`, connected to a server that
 * serves the agent versions in `releases` ("latest" or "v1.2.3").
 */
async function computerWithAgent(
  installed: string,
  releases: Record<string, string>,
  minimumAgentVersion?: string,
) {
  const dir = await mkdtemp(join(tmpdir(), "og-this-computer-min-"));
  const agentPath = join(dir, "agent");
  await writeFile(agentPath, agentScript(installed));
  await chmod(agentPath, 0o755);
  const { publicLine, signFile } = signer();
  const fetched: string[] = [];
  const computer = new ThisComputer({
    platform: "linux",
    arch: "x64",
    home: dir,
    env: {},
    agentSigningKey: publicLine,
    fetch: (url: string) => {
      fetched.push(url);
      const match = new RegExp(`^${SERVER}/agent/([^/]+)/${ASSET}(\\.minisig)?$`).exec(url);
      const version = match ? releases[match[1]!] : undefined;
      if (!version) return Promise.resolve(new Response("missing", { status: 404 }));
      const bytes = Buffer.from(agentScript(version));
      return Promise.resolve(new Response(match![2] ? signFile(bytes) : bytes));
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
  const installedVersion = async () =>
    /opengeni-agent ([0-9.]+)/.exec(await readFile(agentPath, "utf8"))?.[1];
  /** The log line the background replacement leaves once it is done. */
  const replacement = async () => {
    for (let tries = 0; tries < 200; tries += 1) {
      const log = await readFile(join(dir, "agent.log"), "utf8").catch(() => "");
      const line = /app: (.*)/.exec(log)?.[1];
      if (line) return line;
      await Bun.sleep(10);
    }
    throw new Error("the old agent was never replaced");
  };
  return { computer, fetched, installedVersion, replacement };
}

const url = (release: string) => `${SERVER}/agent/${release}/${ASSET}`;

test("a too old agent keeps working while the release the app needs replaces it", async () => {
  const { computer, fetched, installedVersion, replacement } = await computerWithAgent(
    "0.1.54",
    { latest: "0.1.54", "v0.1.124": "0.1.124" },
    "0.1.124",
  );
  await computer.boot();
  expect((await computer.summary()).connected).toBe(true);
  expect(await replacement()).toBe("replaced the old agent with 0.1.124");
  expect(await installedVersion()).toBe("0.1.124");
  // The server's stable agent comes first; the pinned one only because it was too old.
  expect(fetched.filter((each) => !each.endsWith(".minisig"))).toEqual([
    url("latest"),
    url("v0.1.124"),
  ]);
});

test("a server's stable agent newer than the minimum is the one taken", async () => {
  const { computer, fetched, installedVersion, replacement } = await computerWithAgent(
    "0.1.54",
    { latest: "0.1.200" },
    "0.1.124",
  );
  await computer.boot();
  expect(await replacement()).toBe("replaced the old agent with 0.1.200");
  expect(await installedVersion()).toBe("0.1.200");
  expect(fetched.filter((each) => !each.endsWith(".minisig"))).toEqual([url("latest")]);
});

test("without a newer agent to be had the old one stays and the reason is logged", async () => {
  const { computer, installedVersion, replacement } = await computerWithAgent(
    "0.1.54",
    { latest: "0.1.54" },
    "0.1.124",
  );
  await computer.boot();
  expect(await replacement()).toStartWith("couldn't replace the old agent:");
  expect(await installedVersion()).toBe("0.1.54");
  expect((await computer.summary()).connected).toBe(true);
});

test("an agent at or past the minimum stays", async () => {
  const { computer, fetched } = await computerWithAgent("0.1.200", {}, "0.1.124");
  await computer.boot();
  expect(fetched).toEqual([]);
});

test("without a minimum any working agent stays", async () => {
  const { computer, fetched } = await computerWithAgent("0.1.54", {});
  await computer.boot();
  expect(fetched).toEqual([]);
});
