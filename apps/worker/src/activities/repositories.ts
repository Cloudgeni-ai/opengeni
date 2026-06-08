import type { Settings } from "@opengeni/config";
import type { ResourceRef } from "@opengeni/contracts";
import { createGitHubAppInstallationToken } from "@opengeni/github";
import type { SandboxRepositoryMaterialization } from "@opengeni/runtime";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

const GIT_CLONE_TIMEOUT_MS = 5 * 60_000;
const COMMIT_REF_PATTERN = /^[0-9a-fA-F]{7,40}$/;

type RepositorySelection = Extract<ResourceRef, { kind: "repository" }> & {
  githubInstallationId: number;
  githubRepositoryId: number;
};

type GitCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type GitCommandRunner = (
  args: string[],
  options: { env?: Record<string, string>; timeoutMs?: number },
) => Promise<GitCommandResult>;

export type GitHubRepositoryMaterializationSet = {
  materializations: SandboxRepositoryMaterialization[];
  cleanup: () => Promise<void>;
};

type MaterializeGitHubRepositoriesOptions = {
  createInstallationToken?: typeof createGitHubAppInstallationToken;
  runGit?: GitCommandRunner;
};

export async function materializeGitHubRepositoriesForRun(
  settings: Settings,
  resources: ResourceRef[],
  options: MaterializeGitHubRepositoriesOptions = {},
): Promise<GitHubRepositoryMaterializationSet> {
  if (settings.sandboxBackend === "none") {
    return emptyMaterializationSet();
  }
  const selected = githubRepositorySelections(resources);
  if (selected.length === 0) {
    return emptyMaterializationSet();
  }
  const installationId = selected[0]!.githubInstallationId;
  if (selected.some((resource) => resource.githubInstallationId !== installationId)) {
    throw new Error("GitHub App repository resources must belong to one installation");
  }

  const repositoryIds = [...new Set(selected.map((resource) => resource.githubRepositoryId))];
  const createInstallationToken = options.createInstallationToken ?? createGitHubAppInstallationToken;
  const token = await createInstallationToken(settings, { installationId, repositoryIds });
  const runGit = options.runGit ?? runGitCommand;
  const tempRoot = await mkdtemp(join(tmpdir(), "opengeni-github-repos-"));
  let cleanupDone = false;
  const cleanup = async () => {
    if (cleanupDone) {
      return;
    }
    cleanupDone = true;
    await rm(tempRoot, { recursive: true, force: true });
  };

  try {
    const materializations: SandboxRepositoryMaterialization[] = [];
    for (const [index, resource] of selected.entries()) {
      const cloneDir = join(tempRoot, `repo-${index}`);
      await cloneRepository(resource, cloneDir, token, runGit);
      const sourcePath = resource.subpath ? join(cloneDir, resource.subpath) : cloneDir;
      if (resource.subpath) {
        await assertPathInside(cloneDir, sourcePath, `GitHub repository subpath escapes cloned repository: ${resource.subpath}`);
      }
      const sourceStat = await stat(sourcePath);
      if (!sourceStat.isDirectory() && !sourceStat.isFile()) {
        throw new Error(`GitHub repository subpath must resolve to a file or directory: ${resource.subpath ?? "."}`);
      }
      materializations.push({
        mountPath: repositoryMountPath(resource),
        sourcePath,
        sourceType: sourceStat.isDirectory() ? "directory" : "file",
      });
    }
    return { materializations, cleanup };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}

function emptyMaterializationSet(): GitHubRepositoryMaterializationSet {
  return {
    materializations: [],
    cleanup: async () => {},
  };
}

function githubRepositorySelections(resources: ResourceRef[]): RepositorySelection[] {
  return resources.flatMap((resource) => {
    if (resource.kind !== "repository") {
      return [];
    }
    const githubInstallationId = positiveInteger(resource.githubInstallationId);
    const githubRepositoryId = positiveInteger(resource.githubRepositoryId);
    if (!githubInstallationId || !githubRepositoryId) {
      return [];
    }
    return [{ ...resource, githubInstallationId, githubRepositoryId }];
  });
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0) {
    return Number(value);
  }
  return null;
}

function repositoryMountPath(resource: Extract<ResourceRef, { kind: "repository" }>): string {
  if (resource.mountPath) {
    return resource.mountPath;
  }
  const url = new URL(resource.uri);
  const repo = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return `repos/${repo}`;
}

async function cloneRepository(
  resource: RepositorySelection,
  destination: string,
  token: string,
  runGit: GitCommandRunner,
): Promise<void> {
  const env = gitAuthEnvironment(token);
  const ref = resource.ref;
  if (COMMIT_REF_PATTERN.test(ref)) {
    const result = await fetchCommitRef(resource.uri, destination, ref, env, runGit);
    if (result.status === 0) {
      return;
    }
    await rm(destination, { recursive: true, force: true });
    const fallback = await cloneNamedRef(resource.uri, destination, ref, env, runGit);
    if (fallback.status === 0) {
      return;
    }
    throw cloneError(resource.uri, fallback);
  }
  const result = await cloneNamedRef(resource.uri, destination, ref, env, runGit);
  if (result.status !== 0) {
    throw cloneError(resource.uri, result);
  }
}

function gitAuthEnvironment(token: string): Record<string, string> {
  const authHeader = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authHeader}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function cloneNamedRef(
  repositoryUrl: string,
  destination: string,
  ref: string,
  env: Record<string, string>,
  runGit: GitCommandRunner,
): Promise<GitCommandResult> {
  const args = ["clone", "--depth", "1", "--no-tags", "--branch", ref, repositoryUrl, destination];
  return await runGit(args, { env, timeoutMs: GIT_CLONE_TIMEOUT_MS });
}

async function fetchCommitRef(
  repositoryUrl: string,
  destination: string,
  ref: string,
  env: Record<string, string>,
  runGit: GitCommandRunner,
): Promise<GitCommandResult> {
  await mkdir(destination, { recursive: true });
  const steps = [
    ["init", destination],
    ["-C", destination, "remote", "add", "origin", repositoryUrl],
    ["-C", destination, "fetch", "--depth", "1", "--no-tags", "origin", ref],
    ["-C", destination, "checkout", "--detach", "FETCH_HEAD"],
  ];
  for (const args of steps) {
    const result = await runGit(args, { env, timeoutMs: GIT_CLONE_TIMEOUT_MS });
    if (result.status !== 0) {
      return result;
    }
  }
  return { status: 0, stdout: "", stderr: "" };
}

async function runGitCommand(args: string[], options: { env?: Record<string, string>; timeoutMs?: number }): Promise<GitCommandResult> {
  const proc = Bun.spawn(["git", ...args], {
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = options.timeoutMs
    ? setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, options.timeoutMs)
    : null;
  try {
    const [status, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return {
      status: timedOut ? 124 : status,
      stdout,
      stderr: timedOut ? `${stderr}\ngit command timed out`.trim() : stderr,
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function assertPathInside(rootPath: string, sourcePath: string, message: string): Promise<void> {
  const root = await realpath(rootPath);
  const source = await realpath(sourcePath);
  const rel = relative(root, source);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    return;
  }
  throw new Error(message);
}

function cloneError(repositoryUrl: string, result: GitCommandResult): Error {
  const details = (result.stderr || result.stdout || `git exited with status ${result.status}`).trim();
  return new Error(`Failed to clone GitHub repository resource ${safeRepositoryUrl(repositoryUrl)}: ${details}`);
}

function safeRepositoryUrl(repositoryUrl: string): string {
  try {
    const url = new URL(repositoryUrl);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return repositoryUrl;
  }
}
