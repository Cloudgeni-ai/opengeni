// Functional shell-semantics tests for the lifecycle scripts, in their OWN file:
// they spawn real `sh` (multi-second wall time), and runtime.test.ts's MCP
// connect-failure tests leak retrying rejections that bun would attribute to
// whatever slow test is running — cross-file isolation contains that flake.

import { describe, expect, test } from "bun:test";
import { azureCliLoginCommand, repositoryCloneCommand } from "../src/index";

describe("lifecycle scripts — real sh execution semantics", () => {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, statSync, readFileSync, readdirSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");

  /** The generated clone script minus the /workspace-hardcoded invocations, plus a
   *  test-controlled `clone_repository` call. */
  function cloneScriptWithTarget(
    target: string,
    uri: string,
    resource: Parameters<typeof repositoryCloneCommand>[0][number] = {
      kind: "repository",
      uri,
      ref: "main",
      githubInstallationId: 123,
      githubRepositoryId: 456,
    },
  ): string {
    const generated = repositoryCloneCommand([resource]);
    const withoutInvocations = generated.split("\n").filter((line) => !line.startsWith("clone_repository '")).join("\n");
    return `${withoutInvocations}\nclone_repository '${target}' '${uri}' 'main' ''`;
  }

  function makeOrigin(root: string): string {
    const origin = join(root, "origin");
    mkdirSync(origin, { recursive: true });
    execFileSync("git", ["init", "-b", "main", origin]);
    writeFileSync(join(origin, "README.md"), "hello\n");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    };
    execFileSync("git", ["-C", origin, "add", "."], { env: gitEnv });
    execFileSync("git", ["-C", origin, "commit", "-m", "init"], { env: gitEnv });
    // file:// partial clone (--filter=blob:none) needs the origin to allow it.
    execFileSync("git", ["-C", origin, "config", "uploadpack.allowfilter", "true"]);
    return origin;
  }

  function runScript(script: string, env: Record<string, string>): { status: number; output: string } {
    try {
      // merge stderr into stdout so diagnostics like "Re-materializing..." are visible
      const output = execFileSync("sh", ["-c", `{\n${script}\n} 2>&1`], {
        env: { ...process.env, ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, output };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  test("seed block: provider token files 600 + askpass/wrappers 755, atomic, askpass reads current provider token", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-clone-"));
    try {
      const origin = makeOrigin(root);
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const target = join(root, "ws", "repos", "acme", "private");
      const env = {
        HOME: home,
        OPENGENI_GIT_TOKEN_SEED: "tok-atomic-123",
        OPENGENI_GIT_GITLAB_TOKEN_SEED: "glpat-atomic-456",
        OPENGENI_GIT_AZURE_DEVOPS_TOKEN_SEED: "azdo-atomic-789",
      };
      const run = runScript(cloneScriptWithTarget(target, `file://${origin}`), env);
      expect(run.status).toBe(0);
      const tokenFile = join(home, ".opengeni", "git-token");
      const credentialDir = join(home, ".opengeni", "git-credentials");
      const askpass = join(home, ".opengeni", "askpass");
      expect(readFileSync(tokenFile, "utf8")).toBe("tok-atomic-123");
      expect(readFileSync(join(credentialDir, "github-token"), "utf8")).toBe("tok-atomic-123");
      expect(readFileSync(join(credentialDir, "gitlab-token"), "utf8")).toBe("glpat-atomic-456");
      expect(readFileSync(join(credentialDir, "azure_devops-token"), "utf8")).toBe("azdo-atomic-789");
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
      expect(statSync(join(credentialDir, "github-token")).mode & 0o777).toBe(0o600);
      expect(statSync(join(credentialDir, "gitlab-token")).mode & 0o777).toBe(0o600);
      expect(statSync(join(credentialDir, "azure_devops-token")).mode & 0o777).toBe(0o600);
      expect(statSync(askpass).mode & 0o777).toBe(0o755);
      for (const tool of ["gh", "glab", "az"]) {
        expect(statSync(join(home, ".opengeni", "bin", tool)).mode & 0o777).toBe(0o755);
      }
      // atomic install: no pid temp files left behind
      expect(readdirSync(join(home, ".opengeni")).filter((f) => f.includes(".tmp."))).toEqual([]);
      expect(readdirSync(credentialDir).filter((f) => f.includes(".tmp."))).toEqual([]);
      expect(readdirSync(join(home, ".opengeni", "bin")).filter((f) => f.includes(".tmp."))).toEqual([]);
      // the askpass Password branch reads the token file
      const askOut = execFileSync("sh", [askpass, "Password for host"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
      expect(askOut).toBe("tok-atomic-123");
      const gitlabOut = execFileSync("sh", [askpass, "Password for https://gitlab.com"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
      expect(gitlabOut).toBe("glpat-atomic-456");
      const azureOut = execFileSync("sh", [askpass, "Password for https://dev.azure.com/acme"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
      expect(azureOut).toBe("azdo-atomic-789");
      // and the clone landed as a real work tree
      expect(existsSync(join(target, "README.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("askpass maps custom GitLab hosts from repository resources before fallback heuristics", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-custom-git-host-"));
    try {
      const origin = makeOrigin(root);
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const target = join(root, "ws", "repos", "acme", "private");
      const resource = {
        kind: "repository" as const,
        uri: "https://git.company.com/acme/private.git",
        ref: "main",
        provider: "gitlab" as const,
      };
      const run = runScript(cloneScriptWithTarget(target, `file://${origin}`, resource), {
        HOME: home,
        OPENGENI_GIT_TOKEN_SEED: "github-fallback-token",
        OPENGENI_GIT_GITLAB_TOKEN_SEED: "glpat-custom-domain",
      });
      expect(run.status).toBe(0);

      const askpass = join(home, ".opengeni", "askpass");
      const askEnv = { ...process.env, HOME: home };
      expect(execFileSync("sh", [askpass, "Username for 'https://git.company.com':"], { env: askEnv, encoding: "utf8" })).toBe("oauth2\n");
      expect(execFileSync("sh", [askpass, "Password for 'https://git.company.com':"], { env: askEnv, encoding: "utf8" })).toBe("glpat-custom-domain");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("provider CLI wrappers read current token files and pass through when files are absent", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-wrappers-"));
    try {
      const origin = makeOrigin(root);
      const home = join(root, "home");
      const realbin = join(root, "realbin");
      mkdirSync(home, { recursive: true });
      mkdirSync(realbin, { recursive: true });
      const target = join(root, "ws", "repos", "acme", "private");
      const script = cloneScriptWithTarget(target, `file://${origin}`);
      const env = {
        HOME: home,
        OPENGENI_GIT_TOKEN_SEED: "ghs-wrapper-1",
        OPENGENI_GIT_GITLAB_TOKEN_SEED: "glpat-wrapper-1",
        OPENGENI_GIT_AZURE_DEVOPS_TOKEN_SEED: "azdo-wrapper-1",
      };
      expect(runScript(script, env).status).toBe(0);

      writeFileSync(join(realbin, "gh"), "#!/usr/bin/env sh\nprintf 'GH=%s\\n' \"${GH_TOKEN-unset}\"\n", { mode: 0o755 });
      writeFileSync(join(realbin, "glab"), "#!/usr/bin/env sh\nprintf 'GL=%s\\n' \"${GITLAB_TOKEN-unset}\"\n", { mode: 0o755 });
      writeFileSync(join(realbin, "az"), "#!/usr/bin/env sh\nprintf 'AZ=%s\\n' \"${AZURE_DEVOPS_EXT_PAT-unset}\"\n", { mode: 0o755 });

      const wrapperPath = join(home, ".opengeni", "bin");
      const wrapperEnv = { ...process.env, HOME: home, PATH: `${wrapperPath}:${realbin}:${process.env.PATH ?? "/usr/bin:/bin"}` };
      delete wrapperEnv.GH_TOKEN;
      delete wrapperEnv.GITLAB_TOKEN;
      delete wrapperEnv.AZURE_DEVOPS_EXT_PAT;
      expect(execFileSync("gh", [], { env: wrapperEnv, encoding: "utf8" })).toBe("GH=ghs-wrapper-1\n");
      expect(execFileSync("glab", [], { env: wrapperEnv, encoding: "utf8" })).toBe("GL=glpat-wrapper-1\n");
      expect(execFileSync("az", [], { env: wrapperEnv, encoding: "utf8" })).toBe("AZ=azdo-wrapper-1\n");

      rmSync(join(home, ".opengeni", "git-token"), { force: true });
      rmSync(join(home, ".opengeni", "git-credentials", "gitlab-token"), { force: true });
      rmSync(join(home, ".opengeni", "git-credentials", "azure_devops-token"), { force: true });
      expect(execFileSync("gh", [], { env: wrapperEnv, encoding: "utf8" })).toBe("GH=unset\n");
      expect(execFileSync("glab", [], { env: wrapperEnv, encoding: "utf8" })).toBe("GL=unset\n");
      expect(execFileSync("az", [], { env: wrapperEnv, encoding: "utf8" })).toBe("AZ=unset\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clone is idempotent on a valid work tree and RE-MATERIALIZES a partial (interrupted) tree", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-clone-"));
    try {
      const origin = makeOrigin(root);
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const target = join(root, "ws", "repos", "acme", "private");
      const script = cloneScriptWithTarget(target, `file://${origin}`);
      const env = { HOME: home, OPENGENI_GIT_TOKEN_SEED: "tok" };

      // fresh clone into a pre-created EMPTY dir (the manifest dir() mount skeleton)
      mkdirSync(target, { recursive: true });
      expect(runScript(script, env).status).toBe(0);
      expect(existsSync(join(target, ".git"))).toBe(true);

      // second run: skip, agent work preserved
      writeFileSync(join(target, "WORK.md"), "agent work\n");
      const second = runScript(script, env);
      expect(second.status).toBe(0);
      expect(second.output).toContain("already present");
      expect(readFileSync(join(target, "WORK.md"), "utf8")).toBe("agent work\n");

      // partial tree (interrupted materialization: files but no .git) -> rebuilt
      rmSync(join(target, ".git"), { recursive: true, force: true });
      const third = runScript(script, env);
      expect(third.status).toBe(0);
      expect(third.output).toContain("Re-materializing partial repository resource");
      expect(existsSync(join(target, ".git"))).toBe(true);
      expect(existsSync(join(target, "README.md"))).toBe(true);
      // no tmp clone leaked beside the target
      expect(readdirSync(join(root, "ws", "repos", "acme")).filter((f) => f.includes(".tmp."))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clone failure (bad ref/uri) exits non-zero and leaks no tmp clone", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-clone-"));
    try {
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const target = join(root, "ws", "repos", "acme", "private");
      const run = runScript(cloneScriptWithTarget(target, `file://${join(root, "nonexistent")}`), { HOME: home });
      expect(run.status).not.toBe(0);
      expect(existsSync(target)).toBe(false);
      expect(existsSync(`${target}.tmp.`)).toBe(false);
      const parent = join(root, "ws", "repos", "acme");
      expect(existsSync(parent) ? readdirSync(parent).filter((f) => f.includes(".tmp.")) : []).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("az-login script exits 0 for a no-subscription service principal (previously exit 1 -> failed the turn)", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-az-"));
    try {
      // stub az that always succeeds
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "az"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const base = { HOME: home, PATH: `${bin}:${process.env.PATH}` };

      // SP creds, NO subscription id: must exit 0 (az login passes --allow-no-subscriptions)
      const noSub = runScript(azureCliLoginCommand(), {
        ...base, ARM_CLIENT_ID: "cid", ARM_CLIENT_SECRET: "sec", ARM_TENANT_ID: "tid",
      });
      expect(noSub.status).toBe(0);

      // with subscription id: still 0
      const withSub = runScript(azureCliLoginCommand(), {
        ...base, ARM_CLIENT_ID: "cid", ARM_CLIENT_SECRET: "sec", ARM_TENANT_ID: "tid", ARM_SUBSCRIPTION_ID: "sub",
      });
      expect(withSub.status).toBe(0);

      // no creds at all: no-op, exit 0
      expect(runScript(azureCliLoginCommand(), base).status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
