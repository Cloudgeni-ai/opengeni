#!/usr/bin/env bun

import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type ComponentDigests = {
  browserd: string;
  agentBrowser: string;
  computerNative: string;
};

type PreparedRuntime = {
  buildId: string;
  directory: string;
  agentPath: string;
  manifestPath: string;
};

const repositoryRoot = resolve(import.meta.dir, "..");
const agentRoot = join(repositoryRoot, "agent");
const browserdRoot = join(repositoryRoot, "packages", "browserd");
const executableSuffix = process.platform === "win32" ? ".exe" : "";

async function run(command: string[], cwd: string, environment?: Record<string, string>) {
  const child = Bun.spawn(command, {
    cwd,
    env: environment ? { ...process.env, ...environment } : process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit code ${exitCode}`);
  }
}

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await readFile(path));
  return hasher.digest("hex");
}

export function localRuntimeBuildId(identityDigest: string): string {
  return `local-${process.platform}-${process.arch}-${identityDigest.slice(0, 20)}`;
}

async function gitOutput(args: string[]): Promise<Uint8Array> {
  const child = Bun.spawn(["git", ...args], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "inherit",
  });
  const value = new Uint8Array(await new Response(child.stdout).arrayBuffer());
  if ((await child.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return value;
}

async function sourceIdentity(): Promise<{ commit: string; digest: string }> {
  const commit = new TextDecoder().decode(await gitOutput(["rev-parse", "HEAD"])).trim();
  const diff = await gitOutput(["diff", "--binary", "HEAD", "--"]);
  const untrackedOutput = await gitOutput(["ls-files", "--others", "--exclude-standard", "-z"]);
  const untracked = new TextDecoder()
    .decode(untrackedOutput)
    .split("\0")
    .filter(Boolean)
    .sort();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(commit);
  hasher.update(diff);
  for (const path of untracked) {
    hasher.update(`\0${path}\0`);
    hasher.update(await readFile(join(repositoryRoot, path)));
  }
  return { commit, digest: hasher.digest("hex") };
}

/**
 * Build one host-native, source-coherent Connected Machine runtime. The final
 * agent embeds browserd, the pinned agent-browser driver, and computer-native,
 * so starting this one file cannot accidentally discover stale companions from
 * another worktree or release.
 */
export async function prepareLocalAgentRuntime(): Promise<PreparedRuntime> {
  const source = await sourceIdentity();
  const buildId = localRuntimeBuildId(source.digest);
  await run(["bun", "run", "build:binary"], browserdRoot, {
    OPENGENI_RUNTIME_BUILD_ID: buildId,
  });
  await run(["cargo", "build", "--release", "-p", "opengeni-computer-native"], agentRoot);

  const browserd = join(browserdRoot, "dist", `opengeni-browserd${executableSuffix}`);
  const agentBrowser = join(browserdRoot, "dist", `agent-browser${executableSuffix}`);
  const computerNative = join(
    agentRoot,
    "target",
    "release",
    `opengeni-computer-native${executableSuffix}`,
  );
  const digests: ComponentDigests = {
    browserd: await sha256File(browserd),
    agentBrowser: await sha256File(agentBrowser),
    computerNative: await sha256File(computerNative),
  };
  const agentBuild = ["cargo", "build", "--release", "-p", "opengeni-agent"];
  if (process.platform === "darwin") agentBuild.push("--features", "macos-desktop");
  await run(agentBuild, agentRoot, {
    OPENGENI_EMBEDDED_BROWSERD: browserd,
    OPENGENI_EMBEDDED_AGENT_BROWSER: agentBrowser,
    OPENGENI_EMBEDDED_COMPUTER_NATIVE: computerNative,
    OPENGENI_RUNTIME_BUILD_ID: buildId,
  });

  const directory = join(repositoryRoot, ".agent", "local-runtime", buildId);
  const agentPath = join(directory, `opengeni-agent${executableSuffix}`);
  const manifestPath = join(directory, "manifest.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await copyFile(
    join(agentRoot, "target", "release", `opengeni-agent${executableSuffix}`),
    agentPath,
  );
  if (process.platform !== "win32") await chmod(agentPath, 0o700);
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        buildId,
        sourceSha: source.commit,
        sourceIdentity: source.digest,
        agentSha256: await sha256File(agentPath),
        components: digests,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { buildId, directory, agentPath, manifestPath };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const shouldRun = args[0] === "--run";
  const childArgs = shouldRun ? (args.slice(1).length > 0 ? args.slice(1) : ["run"]) : [];
  const prepared = await prepareLocalAgentRuntime();
  process.stdout.write(`${JSON.stringify(prepared)}\n`);
  if (shouldRun) {
    await run([prepared.agentPath, ...childArgs], prepared.directory);
  }
}
