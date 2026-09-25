// Functional shell-semantics tests for the lifecycle scripts, in their OWN file:
// they spawn real `sh` (multi-second wall time), and runtime.test.ts's MCP
// connect-failure tests leak retrying rejections that bun would attribute to
// whatever slow test is running — cross-file isolation contains that flake.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  azureCliLoginCommand,
  gitCredentialBindingHash,
  gitCredentialBindingTokenRefreshCommand,
  gitProviderTokenRefreshCommand,
  refreshGitCredentialBindingTokenFiles,
  refreshGitProviderTokenFiles,
  repositoryCloneCommand,
  runRepositoryCloneHook,
} from "../src/index";
import { hostShellSession, isolatedGitEnvironment } from "./isolated-git-home-fixture";

describe("lifecycle scripts — real sh execution semantics", () => {
  const childProcess = require("node:child_process") as typeof import("node:child_process");
  const {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    existsSync,
    rmSync,
    statSync,
    readFileSync,
    readdirSync,
  } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");

  // These scripts rewrite `$HOME/.opengeni` and the global Git config of whoever
  // runs them. Every child process below therefore runs against an isolated
  // temporary HOME (with GIT_CONFIG_GLOBAL and XDG_CONFIG_HOME pinned inside it),
  // never the developer's: a test that omits HOME gets this harness home.
  let harnessHome = "";
  beforeAll(() => {
    harnessHome = mkdtempSync(join(tmpdir(), "opengeni-lifecycle-home-"));
  });
  afterAll(() => {
    if (harnessHome) rmSync(harnessHome, { recursive: true, force: true });
  });

  type ChildEnvironment = Record<string, string | undefined>;

  /** A sandbox-like environment: isolated HOME plus the sandbox provisioning
   *  target the runtime's lifecycle hooks set. `undefined` removes a name. */
  function isolatedProcessEnv(overrides: ChildEnvironment = {}): NodeJS.ProcessEnv {
    return isolatedGitEnvironment(
      { HOME: harnessHome, ...overrides },
      { sandboxGitProvisioning: true },
    );
  }

  /** `execFileSync` for every git/sh/wrapper invocation in this file: always an
   *  isolated environment, always UTF-8 output. */
  function execFileSync(
    file: string,
    args: readonly string[],
    options: Omit<import("node:child_process").ExecFileSyncOptions, "env" | "encoding"> & {
      env?: ChildEnvironment;
      encoding?: "utf8";
    } = {},
  ): string {
    return childProcess.execFileSync(file, args, {
      ...options,
      env: isolatedProcessEnv(options.env),
      encoding: "utf8",
    });
  }

  /** The generated clone script minus the /workspace-hardcoded invocations, plus a
   *  test-controlled `clone_repository` call. */
  function cloneScriptWithTarget(
    target: string,
    uri: string,
    resource: Parameters<typeof repositoryCloneCommand>[0][number] = {
      kind: "repository",
      uri: "https://github.com/opengeni/test-fixture.git",
      ref: "main",
      githubInstallationId: 123,
      githubRepositoryId: 456,
    },
    ref = resource.ref,
  ): string {
    const generated = repositoryCloneCommand([
      { ...resource, mountPath: resource.mountPath ?? "repos/test/repository" },
    ]);
    const withoutInvocations = generated
      .split("\n")
      .filter(
        (line) =>
          !line.startsWith("start_repository_clone '") && line !== "wait_repository_clone_batch",
      )
      .join("\n");
    return `${withoutInvocations}\nclone_repository '${target}' '${uri}' '${ref}' '' '${resource.expectedCommitSha ?? ""}'`;
  }

  function setupScript(
    resources: Parameters<typeof repositoryCloneCommand>[0],
    bindings: NonNullable<Parameters<typeof repositoryCloneCommand>[1]>,
  ): string {
    return repositoryCloneCommand(resources, bindings)
      .split("\n")
      .filter(
        (line) =>
          !line.startsWith("start_repository_clone '") && line !== "wait_repository_clone_batch",
      )
      .join("\n");
  }

  function makeOrigin(root: string): string {
    const origin = join(root, "origin");
    mkdirSync(origin, { recursive: true });
    execFileSync("git", ["init", "-b", "main", origin]);
    writeFileSync(join(origin, "README.md"), "hello\n");
    const gitEnv = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    execFileSync("git", ["-C", origin, "add", "."], { env: gitEnv });
    execFileSync("git", ["-C", origin, "commit", "-m", "init"], {
      env: gitEnv,
    });
    // file:// partial clone (--filter=blob:none) needs the origin to allow it.
    execFileSync("git", ["-C", origin, "config", "uploadpack.allowfilter", "true"]);
    return origin;
  }

  function runScript(script: string, env: ChildEnvironment): { status: number; output: string } {
    try {
      // merge stderr into stdout so diagnostics like "Re-materializing..." are visible
      const output = childProcess.execFileSync("sh", ["-c", `{\n${script}\n} 2>&1`], {
        env: isolatedProcessEnv(env),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, output };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: e.status ?? 1,
        output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
      };
    }
  }

  test("rejects one remote claimed by two credential bindings before sandbox execution", () => {
    expect(() =>
      repositoryCloneCommand([
        {
          kind: "repository",
          uri: "https://github.com/acme/repo.git",
          ref: "main",
          mountPath: "repos/test/one",
          provider: "github",
          credentialBindingId: "one",
        },
        {
          kind: "repository",
          uri: "https://github.com/acme/repo",
          ref: "feature",
          mountPath: "repos/test/two",
          provider: "github",
          credentialBindingId: "two",
        },
      ]),
    ).toThrow("claimed by multiple credential bindings");
  });

  test("fails closed when a repository ref does not resolve to the expected immutable commit", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-exact-head-"));
    try {
      const origin = makeOrigin(root);
      const actual = execFileSync("git", ["-C", origin, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const target = join(root, "workspace", "repo");
      const resource = {
        kind: "repository" as const,
        uri: "https://github.com/opengeni/exact-head-fixture.git",
        ref: "main",
        expectedCommitSha: "f".repeat(40),
      };
      const mismatch = runScript(cloneScriptWithTarget(target, `file://${origin}`, resource), {});
      expect(mismatch.status).not.toBe(0);
      expect(mismatch.output).toContain("resolved to an unexpected commit");
      expect(existsSync(target)).toBe(false);

      const matched = runScript(
        cloneScriptWithTarget(target, `file://${origin}`, {
          ...resource,
          ref: actual,
          expectedCommitSha: actual,
        }),
        {},
      );
      expect(matched.status).toBe(0);
      expect(
        execFileSync("git", ["-C", target, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
      ).toBe(actual);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Git credential provisioning leaves a host HOME and its global Git config untouched unless a sandbox lifecycle command targets it", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-host-home-guard-"));
    try {
      const origin = makeOrigin(root);
      // A developer-like HOME whose credential helpers the provisioning must not replace.
      const home = join(root, "developer-home");
      const gitconfig =
        '[credential "https://github.com"]\n\thelper = \n\thelper = !gh auth git-credential\n';
      const xdgConfig = "[user]\n\tname = Developer\n";
      mkdirSync(join(home, ".config", "git"), { recursive: true });
      writeFileSync(join(home, ".gitconfig"), gitconfig);
      writeFileSync(join(home, ".config", "git", "config"), xdgConfig);
      const target = join(root, "workspace", "repo");
      const resource = {
        kind: "repository" as const,
        uri: "https://github.com/opengeni/exact-head-fixture.git",
        ref: "main",
        provider: "github" as const,
        credentialBindingId: "host-guard",
      };
      const bindings = [
        { credentialBindingId: "host-guard", provider: "github" as const, token: "host-token" },
      ];
      const scripts = {
        clone: cloneScriptWithTarget(target, `file://${origin}`, resource),
        providerRefresh: gitProviderTokenRefreshCommand({ github: "host-token" }),
        bindingRefresh: gitCredentialBindingTokenRefreshCommand(bindings),
      };
      // Exactly how a developer or a careless test would run an exported builder:
      // on the host, without the sandbox lifecycle target.
      const hostEnvironment = isolatedGitEnvironment({ HOME: home, GIT_TERMINAL_PROMPT: "0" });
      expect(hostEnvironment.OPENGENI_GIT_PROVISIONING_TARGET).toBeUndefined();
      for (const [name, script] of Object.entries(scripts)) {
        let status = 0;
        let output = "";
        try {
          childProcess.execFileSync("sh", ["-c", `{\n${script}\n} 2>&1`], {
            env: {
              ...hostEnvironment,
              OPENGENI_GIT_TOKEN_SEED: "host-token",
              [`OPENGENI_GIT_BINDING_${gitCredentialBindingHash("host-guard").toUpperCase()}_TOKEN_SEED`]:
                "host-token",
            },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          const failure = error as { status?: number; stdout?: string };
          status = failure.status ?? 1;
          output = failure.stdout ?? "";
        }
        expect({ name, status }).toEqual({ name, status: 78 });
        expect(output).toContain("Refusing to provision OpenGeni Git credentials");
        expect(readFileSync(join(home, ".gitconfig"), "utf8")).toBe(gitconfig);
        expect(readFileSync(join(home, ".config", "git", "config"), "utf8")).toBe(xdgConfig);
        expect(existsSync(join(home, ".opengeni"))).toBe(false);
        expect(existsSync(target)).toBe(false);
      }

      // The same clone script provisions once a sandbox lifecycle command targets
      // it, so the refusal above came from the guard and not a broken script.
      const admitted = runScript(scripts.clone, { HOME: home });
      expect(admitted.status).toBe(0);
      expect(readFileSync(join(home, ".gitconfig"), "utf8")).toContain(
        join(home, ".opengeni", "git-credentials", "helper"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runtime clone and renewal hooks provision through an unmarked shell session, while the bare builders refuse it", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-hook-command-"));
    try {
      const origin = makeOrigin(root);
      const workspace = join(root, "workspace");
      mkdirSync(workspace, { recursive: true });
      const remote = "https://github.com/opengeni/hooked-fixture.git";
      const resources = [
        { kind: "repository" as const, uri: remote, ref: "main", mountPath: "repos/test/hooked" },
      ];
      const bindings = [
        { credentialBindingId: "hooked", provider: "github" as const, token: "hook-token" },
      ];
      const tokenDirectory = (home: string) => join(home, ".opengeni");
      const bindingTokenFile = (home: string) =>
        join(
          tokenDirectory(home),
          "git-credentials",
          `${gitCredentialBindingHash("hooked")}-token`,
        );
      // A sandbox-shaped session: the virtual /workspace maps onto a temporary
      // directory, the HTTPS remote resolves to the local origin through
      // command-scoped Git config, and HOME is an isolated fixture home. Nothing in
      // its environment carries the sandbox provisioning target, so only the marker
      // the runtime hooks put in the command text can admit the provisioning scripts.
      const sandboxSession = (home: string) =>
        hostShellSession(home, {
          cwd: workspace,
          env: {
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
            GIT_CONFIG_VALUE_0: remote,
          },
          rewriteCommand: (cmd) => cmd.replaceAll("'/workspace/", `'${workspace}/`),
        });

      // The exact builders the hooks wrap, run on their own through the same kind
      // of session, stop at the guard and leave their HOME untouched.
      const bareHome = join(root, "bare-home");
      const bareSession = sandboxSession(bareHome);
      for (const command of [
        repositoryCloneCommand(resources),
        gitCredentialBindingTokenRefreshCommand(bindings),
        gitProviderTokenRefreshCommand({ github: "renewed-provider-token" }),
      ]) {
        const refused = await bareSession.exec({ cmd: command });
        expect(refused.exitCode).toBe(78);
        expect(refused.stderr).toContain("Refusing to provision OpenGeni Git credentials");
      }
      expect(readdirSync(bareHome)).toEqual([]);
      expect(existsSync(join(workspace, "repos"))).toBe(false);

      // The production hooks: repository clone, then both renewal paths.
      const home = join(root, "sandbox-home");
      const session = sandboxSession(home);
      await runRepositoryCloneHook(session as never, resources, {
        environment: {},
        gitTokenSeeds: { github: "hook-token" },
        gitCredentialBindings: bindings,
      });
      expect(readFileSync(join(workspace, "repos", "test", "hooked", "README.md"), "utf8")).toBe(
        "hello\n",
      );
      expect(readFileSync(join(home, ".gitconfig"), "utf8")).toContain(
        join(tokenDirectory(home), "git-credentials", "helper"),
      );
      expect(readFileSync(bindingTokenFile(home), "utf8")).toBe("hook-token");
      expect(readFileSync(join(tokenDirectory(home), "git-token"), "utf8")).toBe("hook-token");

      await refreshGitCredentialBindingTokenFiles(session as never, [
        { ...bindings[0]!, token: "renewed-binding-token" },
      ]);
      expect(readFileSync(bindingTokenFile(home), "utf8")).toBe("renewed-binding-token");

      await refreshGitProviderTokenFiles(session as never, { github: "renewed-provider-token" });
      expect(readFileSync(join(tokenDirectory(home), "git-token"), "utf8")).toBe(
        "renewed-provider-token",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps exact-path provider remotes distinct when one name ends in .git", () => {
    const command = repositoryCloneCommand([
      {
        kind: "repository",
        uri: "https://dev.azure.com/acme/project/_git/repo",
        ref: "main",
        provider: "azure_devops",
        credentialBindingId: "azure-one",
      },
      {
        kind: "repository",
        uri: "https://dev.azure.com/acme/project/_git/repo.git",
        ref: "main",
        provider: "azure_devops",
        credentialBindingId: "azure-two",
      },
    ]);

    expect(command).toContain("https://dev.azure.com/acme/project/_git/repo");
    expect(command).toContain("https://dev.azure.com/acme/project/_git/repo.git");
  });

  test("keeps provider-neutral credential-helper paths exact", () => {
    const command = repositoryCloneCommand([
      {
        kind: "repository",
        uri: "https://git.example/acme/repo",
        ref: "main",
        mountPath: "repos/plain",
      },
      {
        kind: "repository",
        uri: "https://git.example/acme/repo.git",
        ref: "main",
        mountPath: "repos/dot-git",
      },
    ]);
    const lines = command.split("\n");

    expect(
      lines.filter((line) =>
        line.includes("'https|git.example|acme/repo') username='x-access-token'"),
      ),
    ).toHaveLength(1);
    expect(
      lines.filter((line) =>
        line.includes("'https|git.example|acme/repo.git') username='x-access-token'"),
      ),
    ).toHaveLength(1);
  });

  test("fails closed on an unsupported credential transport", () => {
    expect(() =>
      repositoryCloneCommand(
        [
          {
            kind: "repository",
            uri: "https://gitlab.com/acme/repo.git",
            ref: "main",
            provider: "gitlab",
            credentialBindingId: "gitlab-primary",
          },
        ],
        [
          {
            credentialBindingId: "gitlab-primary",
            provider: "gitlab",
            token: "must-not-be-treated-as-provider-token",
            transport: { kind: "future_transport" } as never,
          },
        ],
      ),
    ).toThrow("uses an unsupported transport");
  });

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
      expect(readFileSync(join(credentialDir, "azure_devops-token"), "utf8")).toBe(
        "azdo-atomic-789",
      );
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
      expect(
        readdirSync(join(home, ".opengeni", "bin")).filter((f) => f.includes(".tmp.")),
      ).toEqual([]);
      // the askpass Password branch reads the token file
      const askOut = execFileSync("sh", [askpass, "Password for host"], {
        env: { HOME: home },
        encoding: "utf8",
      });
      expect(askOut).toBe("tok-atomic-123");
      const gitlabOut = execFileSync("sh", [askpass, "Password for https://gitlab.com"], {
        env: { HOME: home },
        encoding: "utf8",
      });
      expect(gitlabOut).toBe("glpat-atomic-456");
      const azureOut = execFileSync("sh", [askpass, "Password for https://dev.azure.com/acme"], {
        env: { HOME: home },
        encoding: "utf8",
      });
      expect(azureOut).toBe("azdo-atomic-789");
      // and the clone landed as a real work tree
      expect(existsSync(join(target, "README.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refresh command atomically replaces every provider token behind stable paths", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-git-refresh-"));
    try {
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const first = runScript(
        gitProviderTokenRefreshCommand({
          github: "gh-old",
          gitlab: "gl-old",
          azure_devops: "az-old",
        }),
        { HOME: home },
      );
      expect(first.status).toBe(0);

      const second = runScript(
        gitProviderTokenRefreshCommand({
          github: "gh-new",
          gitlab: "gl-new",
          azure_devops: "az-new",
        }),
        { HOME: home },
      );
      expect(second.status).toBe(0);

      const credentialDir = join(home, ".opengeni", "git-credentials");
      expect(readFileSync(join(home, ".opengeni", "git-token"), "utf8")).toBe("gh-new");
      expect(readFileSync(join(credentialDir, "github-token"), "utf8")).toBe("gh-new");
      expect(readFileSync(join(credentialDir, "gitlab-token"), "utf8")).toBe("gl-new");
      expect(readFileSync(join(credentialDir, "azure_devops-token"), "utf8")).toBe("az-new");
      expect(readdirSync(join(home, ".opengeni")).filter((f) => f.includes(".tmp."))).toEqual([]);
      expect(readdirSync(credentialDir).filter((f) => f.includes(".tmp."))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("path-aware Git helper keeps two credentials for the same provider and host isolated", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-git-bindings-"));
    try {
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const resources = [
        {
          kind: "repository" as const,
          uri: "https://github.com/acme/one.git",
          ref: "main",
          provider: "github" as const,
          credentialBindingId: "installation/one",
        },
        {
          kind: "repository" as const,
          uri: "https://github.com/acme/two.git",
          ref: "main",
          provider: "github" as const,
          credentialBindingId: "../../installation two",
        },
      ];
      const bindings = [
        {
          credentialBindingId: "installation/one",
          provider: "github" as const,
          token: "gh-one",
          providerBindingCount: 2,
        },
        {
          credentialBindingId: "../../installation two",
          provider: "github" as const,
          token: "gh-two",
          providerBindingCount: 2,
        },
      ];
      const run = runScript(
        `${gitCredentialBindingTokenRefreshCommand(bindings)}\n${setupScript(resources, bindings)}`,
        { HOME: home },
      );
      expect(run.status).toBe(0);

      const credentialDir = join(home, ".opengeni", "git-credentials");
      expect(
        readFileSync(
          join(credentialDir, `${gitCredentialBindingHash("installation/one")}-token`),
          "utf8",
        ),
      ).toBe("gh-one");
      expect(
        readFileSync(
          join(credentialDir, `${gitCredentialBindingHash("../../installation two")}-token`),
          "utf8",
        ),
      ).toBe("gh-two");
      expect(readdirSync(credentialDir).some((name) => name.includes("installation"))).toBe(false);
      expect(existsSync(join(home, ".opengeni", "git-token"))).toBe(false);
      expect(existsSync(join(credentialDir, "github-token"))).toBe(false);

      const fill = (path: string) =>
        execFileSync("git", ["credential", "fill"], {
          env: {
            HOME: home,
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: join(home, ".opengeni", "askpass"),
          },
          input: `protocol=https\nhost=github.com\npath=${path}\n\n`,
          encoding: "utf8",
        });
      expect(fill("acme/one.git")).toContain("password=gh-one");
      expect(fill("acme/two.git")).toContain("password=gh-two");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("HTTPS broker rewrites only selected remotes, rotates its bearer, and never authenticates provider CLIs", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-git-http-broker-"));
    try {
      const home = join(root, "home");
      const realbin = join(root, "realbin");
      const repo = join(root, "repo");
      mkdirSync(home, { recursive: true });
      mkdirSync(realbin, { recursive: true });
      mkdirSync(repo, { recursive: true });
      execFileSync("git", ["init", repo]);
      execFileSync("git", [
        "-C",
        repo,
        "remote",
        "add",
        "origin",
        "https://gitlab.com/acme/private.git",
      ]);
      writeFileSync(
        join(realbin, "glab"),
        "#!/usr/bin/env sh\nprintf 'GL=%s\\n' \"${GITLAB_TOKEN-unset}\"\n",
        { mode: 0o755 },
      );

      const resources = [
        {
          kind: "repository" as const,
          uri: "https://gitlab.com/acme/private.git",
          ref: "main",
          provider: "gitlab" as const,
          credentialBindingId: "gitlab/account-wide",
        },
      ];
      const transport = {
        kind: "http_broker" as const,
        repositories: [
          {
            repositoryUri: "https://gitlab.com/acme/private.git",
            brokerUri: "https://broker.example.test/git/session/binding/private.git",
          },
        ],
      };
      const initialBindings = [
        {
          credentialBindingId: "gitlab/account-wide",
          provider: "gitlab" as const,
          token: "broker-bearer-one",
          transport,
          providerBindingCount: 1,
        },
      ];
      const initialSeedPath = join(root, "broker-seed-one");
      writeFileSync(initialSeedPath, "broker-bearer-one", { mode: 0o600 });
      const initialRefresh = gitCredentialBindingTokenRefreshCommand(initialBindings, [
        {
          bindingHash: gitCredentialBindingHash(initialBindings[0]!.credentialBindingId),
          path: initialSeedPath,
        },
      ]);
      expect(initialRefresh).not.toContain("broker-bearer-one");
      expect(
        runScript(`${initialRefresh}\n${setupScript(resources, initialBindings)}`, { HOME: home })
          .status,
      ).toBe(0);
      expect(existsSync(initialSeedPath)).toBe(false);

      expect(
        execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], {
          env: { HOME: home },
          encoding: "utf8",
        }).trim(),
      ).toBe("https://broker.example.test/git/session/binding/private.git");
      const fill = (host = "broker.example.test", path = "git/session/binding/private.git") =>
        execFileSync("git", ["credential", "fill"], {
          env: {
            HOME: home,
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: join(home, ".opengeni", "askpass"),
          },
          input: `protocol=https\nhost=${host}\npath=${path}\n\n`,
          encoding: "utf8",
        });
      expect(fill()).toContain("password=broker-bearer-one");
      expect(existsSync(join(home, ".opengeni", "git-credentials", "gitlab-token"))).toBe(false);
      expect(
        readFileSync(join(home, ".opengeni", "git-credentials", "http-broker.gitconfig"), "utf8"),
      ).not.toContain("broker-bearer-one");

      expect(() =>
        execFileSync("glab", [], {
          cwd: repo,
          env: {
            HOME: home,
            GITLAB_TOKEN: "ambient-token-must-not-pass",
            PATH: `${join(home, ".opengeni", "bin")}:${realbin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          },
          encoding: "utf8",
        }),
      ).toThrow();

      const renewedBindings = [
        {
          ...initialBindings[0]!,
          token: "broker-bearer-two",
        },
      ];
      const renewedSeedPath = join(root, "broker-seed-two");
      writeFileSync(renewedSeedPath, "broker-bearer-two", { mode: 0o600 });
      const renewedRefresh = gitCredentialBindingTokenRefreshCommand(renewedBindings, [
        {
          bindingHash: gitCredentialBindingHash(renewedBindings[0]!.credentialBindingId),
          path: renewedSeedPath,
        },
      ]);
      expect(renewedRefresh).not.toContain("broker-bearer-two");
      expect(runScript(renewedRefresh, { HOME: home }).status).toBe(0);
      expect(existsSync(renewedSeedPath)).toBe(false);
      expect(fill()).toContain("password=broker-bearer-two");
      expect(
        execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], {
          env: { HOME: home },
          encoding: "utf8",
        }).trim(),
      ).toBe("https://broker.example.test/git/session/binding/private.git");

      const directBindings = [
        {
          credentialBindingId: "gitlab/account-wide",
          provider: "gitlab" as const,
          token: "direct-contained-token",
          providerBindingCount: 1,
        },
      ];
      expect(
        runScript(
          `${gitCredentialBindingTokenRefreshCommand(directBindings)}\n${setupScript(resources, directBindings)}`,
          { HOME: home },
        ).status,
      ).toBe(0);
      expect(
        execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], {
          env: { HOME: home },
          encoding: "utf8",
        }).trim(),
      ).toBe("https://gitlab.com/acme/private.git");
      expect(
        readFileSync(join(home, ".opengeni", "git-credentials", "http-broker.gitconfig"), "utf8"),
      ).toBe("");
      expect(fill("gitlab.com", "acme/private.git")).toContain("password=direct-contained-token");
      const staleBrokerFill = fill();
      expect(staleBrokerFill).toContain("password=\n");
      expect(staleBrokerFill).not.toContain("broker-bearer-one");
      expect(staleBrokerFill).not.toContain("broker-bearer-two");
      expect(staleBrokerFill).not.toContain("direct-contained-token");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mixed direct and broker bindings for one provider select Git and provider CLI authority independently", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-git-http-broker-mixed-"));
    try {
      const home = join(root, "home");
      const realbin = join(root, "realbin");
      const directRepo = join(root, "direct");
      const brokeredRepo = join(root, "brokered");
      mkdirSync(home, { recursive: true });
      mkdirSync(realbin, { recursive: true });
      mkdirSync(directRepo, { recursive: true });
      mkdirSync(brokeredRepo, { recursive: true });
      execFileSync("git", ["init", directRepo]);
      execFileSync("git", ["init", brokeredRepo]);
      execFileSync("git", [
        "-C",
        directRepo,
        "remote",
        "add",
        "origin",
        "https://gitlab.com/acme/direct.git",
      ]);
      execFileSync("git", [
        "-C",
        brokeredRepo,
        "remote",
        "add",
        "origin",
        "https://gitlab.com/acme/brokered.git",
      ]);
      writeFileSync(
        join(realbin, "glab"),
        '#!/usr/bin/env sh\nprintf \'GL=%s\\nOAUTH=%s\\nOAUTH2=%s\\n\' "${GITLAB_TOKEN-unset}" "${OAUTH_TOKEN-unset}" "${GLAB_IS_OAUTH2-unset}"\n',
        { mode: 0o755 },
      );

      const resources = [
        {
          kind: "repository" as const,
          uri: "https://gitlab.com/acme/direct.git",
          ref: "main",
          provider: "gitlab" as const,
          credentialBindingId: "gitlab/direct",
        },
        {
          kind: "repository" as const,
          uri: "https://gitlab.com/acme/brokered.git",
          ref: "main",
          provider: "gitlab" as const,
          credentialBindingId: "gitlab/brokered",
        },
      ];
      const bindings = [
        {
          credentialBindingId: "gitlab/direct",
          provider: "gitlab" as const,
          token: "direct-token",
          providerBindingCount: 2,
        },
        {
          credentialBindingId: "gitlab/brokered",
          provider: "gitlab" as const,
          token: "broker-bearer",
          providerBindingCount: 2,
          transport: {
            kind: "http_broker" as const,
            repositories: [
              {
                repositoryUri: "https://gitlab.com/acme/brokered.git",
                brokerUri: "https://broker.example.test/git/session/brokered.git",
              },
            ],
          },
        },
      ];
      const brokerSeedPath = join(root, "mixed-broker-seed");
      writeFileSync(brokerSeedPath, "broker-bearer", { mode: 0o600 });
      const refresh = gitCredentialBindingTokenRefreshCommand(bindings, [
        {
          bindingHash: gitCredentialBindingHash(bindings[1]!.credentialBindingId),
          path: brokerSeedPath,
        },
      ]);
      expect(refresh).not.toContain("broker-bearer");
      expect(
        runScript(`${refresh}\n${setupScript(resources, bindings)}`, { HOME: home }).status,
      ).toBe(0);
      expect(existsSync(brokerSeedPath)).toBe(false);

      const fill = (host: string, path: string) =>
        execFileSync("git", ["credential", "fill"], {
          env: {
            HOME: home,
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: join(home, ".opengeni", "askpass"),
          },
          input: `protocol=https\nhost=${host}\npath=${path}\n\n`,
          encoding: "utf8",
        });
      expect(fill("gitlab.com", "acme/direct.git")).toContain("password=direct-token");
      expect(fill("broker.example.test", "git/session/brokered.git")).toContain(
        "password=broker-bearer",
      );
      expect(existsSync(join(home, ".opengeni", "git-credentials", "gitlab-token"))).toBe(false);

      const env = {
        HOME: home,
        GITLAB_TOKEN: "ambient-token-must-not-win",
        PATH: `${join(home, ".opengeni", "bin")}:${realbin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      };
      expect(execFileSync("glab", [], { cwd: directRepo, env, encoding: "utf8" })).toBe(
        "GL=unset\nOAUTH=direct-token\nOAUTH2=true\n",
      );
      expect(() =>
        execFileSync("glab", [], {
          cwd: brokeredRepo,
          env,
          encoding: "utf8",
        }),
      ).toThrow();
      expect(() =>
        execFileSync("glab", [], {
          cwd: root,
          env: { ...env, OPENGENI_GIT_BINDING: "gitlab/brokered" },
          encoding: "utf8",
        }),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("path-aware Git helper treats custom ports as distinct remote hosts", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-git-binding-ports-"));
    try {
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const resources = [
        {
          kind: "repository" as const,
          uri: "https://git.example.com:8443/acme/repo.git",
          ref: "main",
          provider: "gitlab" as const,
          credentialBindingId: "port-8443",
        },
        {
          kind: "repository" as const,
          uri: "https://git.example.com:9443/acme/repo.git",
          ref: "main",
          provider: "gitlab" as const,
          credentialBindingId: "port-9443",
        },
      ];
      const bindings = [
        {
          credentialBindingId: "port-8443",
          provider: "gitlab" as const,
          token: "token-8443",
          providerBindingCount: 2,
        },
        {
          credentialBindingId: "port-9443",
          provider: "gitlab" as const,
          token: "token-9443",
          providerBindingCount: 2,
        },
      ];
      expect(
        runScript(
          `${gitCredentialBindingTokenRefreshCommand(bindings)}\n${setupScript(resources, bindings)}`,
          { HOME: home },
        ).status,
      ).toBe(0);
      const fill = (host: string) =>
        execFileSync("git", ["credential", "fill"], {
          env: {
            HOME: home,
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: join(home, ".opengeni", "askpass"),
          },
          input: `protocol=https\nhost=${host}\npath=acme/repo.git\n\n`,
          encoding: "utf8",
        });
      expect(fill("git.example.com:8443")).toContain("password=token-8443");
      expect(fill("git.example.com:9443")).toContain("password=token-9443");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("provider CLI wrapper selects by origin, then explicit binding, and fails closed when ambiguous", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-git-wrapper-bindings-"));
    try {
      const home = join(root, "home");
      const realbin = join(root, "realbin");
      const repoOne = join(root, "one");
      mkdirSync(home, { recursive: true });
      mkdirSync(realbin, { recursive: true });
      mkdirSync(repoOne, { recursive: true });
      execFileSync("git", ["init", repoOne]);
      execFileSync("git", [
        "-C",
        repoOne,
        "remote",
        "add",
        "origin",
        "https://github.com/acme/one.git",
      ]);
      writeFileSync(
        join(realbin, "gh"),
        "#!/usr/bin/env sh\nprintf 'GH=%s\\n' \"${GH_TOKEN-unset}\"\n",
        { mode: 0o755 },
      );

      const resources = [
        {
          kind: "repository" as const,
          uri: "https://github.com/acme/one.git",
          ref: "main",
          provider: "github" as const,
          credentialBindingId: "one",
        },
        {
          kind: "repository" as const,
          uri: "https://github.com/acme/two.git",
          ref: "main",
          provider: "github" as const,
          credentialBindingId: "two",
        },
      ];
      const bindings = [
        {
          credentialBindingId: "one",
          provider: "github" as const,
          token: "gh-one",
          providerBindingCount: 2,
        },
        {
          credentialBindingId: "two",
          provider: "github" as const,
          token: "gh-two",
          providerBindingCount: 2,
        },
      ];
      expect(
        runScript(
          `${gitCredentialBindingTokenRefreshCommand(bindings)}\n${setupScript(resources, bindings)}`,
          { HOME: home },
        ).status,
      ).toBe(0);
      const env = {
        HOME: home,
        PATH: `${join(home, ".opengeni", "bin")}:${realbin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        GH_TOKEN: undefined,
      };
      expect(execFileSync("gh", [], { cwd: repoOne, env, encoding: "utf8" })).toBe("GH=gh-one\n");
      expect(
        execFileSync("gh", [], {
          cwd: root,
          env: { ...env, OPENGENI_GIT_BINDING: "two" },
          encoding: "utf8",
        }),
      ).toBe("GH=gh-two\n");
      const inventory = JSON.parse(
        readFileSync(join(home, ".opengeni", "git-bindings.json"), "utf8"),
      );
      expect(inventory).toEqual({
        version: 1,
        bindings: [
          {
            credentialBindingId: "one",
            provider: "github",
            transport: "direct_token",
            repositories: [
              {
                uri: "https://github.com/acme/one.git",
                mountPath: "/workspace/repos/github.com/acme/one",
              },
            ],
          },
          {
            credentialBindingId: "two",
            provider: "github",
            transport: "direct_token",
            repositories: [
              {
                uri: "https://github.com/acme/two.git",
                mountPath: "/workspace/repos/github.com/acme/two",
              },
            ],
          },
        ],
      });
      try {
        execFileSync("gh", [], { cwd: root, env, encoding: "utf8" });
        throw new Error("expected ambiguous GitHub binding selection to fail");
      } catch (error) {
        expect(String((error as { stderr?: string | Buffer }).stderr ?? error)).toContain(
          ".opengeni/git-bindings.json",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Azure CLI wrapper gives the selected brokered PAT precedence over an ambient PAT", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-az-wrapper-binding-"));
    try {
      const home = join(root, "home");
      const realbin = join(root, "realbin");
      mkdirSync(home, { recursive: true });
      mkdirSync(realbin, { recursive: true });
      writeFileSync(
        join(realbin, "az"),
        "#!/usr/bin/env sh\nprintf 'AZ=%s\\n' \"${AZURE_DEVOPS_EXT_PAT-unset}\"\n",
        { mode: 0o755 },
      );
      const resources = [
        {
          kind: "repository" as const,
          uri: "https://dev.azure.com/acme/project/_git/repo",
          ref: "main",
          provider: "azure_devops" as const,
          credentialBindingId: "ado-connection",
        },
      ];
      const bindings = [
        {
          credentialBindingId: "ado-connection",
          provider: "azure_devops" as const,
          token: "brokered-ado-pat",
          providerBindingCount: 1,
        },
      ];
      expect(
        runScript(
          `${gitCredentialBindingTokenRefreshCommand(bindings)}\n${setupScript(resources, bindings)}`,
          { HOME: home },
        ).status,
      ).toBe(0);
      expect(
        execFileSync("az", [], {
          env: {
            HOME: home,
            AZURE_DEVOPS_EXT_PAT: "ambient-pat-must-not-win",
            PATH: `${join(home, ".opengeni", "bin")}:${realbin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          },
          encoding: "utf8",
        }),
      ).toBe("AZ=brokered-ado-pat\n");
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
      const askEnv = { HOME: home };
      expect(
        execFileSync("sh", [askpass, "Username for 'https://git.company.com':"], {
          env: askEnv,
          encoding: "utf8",
        }),
      ).toBe("oauth2\n");
      expect(
        execFileSync("sh", [askpass, "Password for 'https://git.company.com':"], {
          env: askEnv,
          encoding: "utf8",
        }),
      ).toBe("glpat-custom-domain");

      // Renewal must update only token files. Rebuilding askpass without the
      // original repository list would erase this custom-host mapping.
      expect(
        runScript(
          gitProviderTokenRefreshCommand({
            github: "github-refreshed",
            gitlab: "glpat-custom-refreshed",
          }),
          { HOME: home },
        ).status,
      ).toBe(0);
      expect(
        execFileSync("sh", [askpass, "Username for 'https://git.company.com':"], {
          env: askEnv,
          encoding: "utf8",
        }),
      ).toBe("oauth2\n");
      expect(
        execFileSync("sh", [askpass, "Password for 'https://git.company.com':"], {
          env: askEnv,
          encoding: "utf8",
        }),
      ).toBe("glpat-custom-refreshed");
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

      writeFileSync(
        join(realbin, "gh"),
        "#!/usr/bin/env sh\nprintf 'GH=%s\\n' \"${GH_TOKEN-unset}\"\n",
        { mode: 0o755 },
      );
      writeFileSync(
        join(realbin, "glab"),
        "#!/usr/bin/env sh\nprintf 'GL=%s\\n' \"${GITLAB_TOKEN-unset}\"\n",
        { mode: 0o755 },
      );
      writeFileSync(
        join(realbin, "az"),
        "#!/usr/bin/env sh\nprintf 'AZ=%s\\n' \"${AZURE_DEVOPS_EXT_PAT-unset}\"\n",
        { mode: 0o755 },
      );

      const wrapperPath = join(home, ".opengeni", "bin");
      const wrapperEnv = {
        HOME: home,
        PATH: `${wrapperPath}:${realbin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        GH_TOKEN: undefined,
        GITLAB_TOKEN: undefined,
        AZURE_DEVOPS_EXT_PAT: undefined,
      };
      expect(execFileSync("gh", [], { env: wrapperEnv, encoding: "utf8" })).toBe(
        "GH=ghs-wrapper-1\n",
      );
      expect(execFileSync("glab", [], { env: wrapperEnv, encoding: "utf8" })).toBe(
        "GL=glpat-wrapper-1\n",
      );
      expect(execFileSync("az", [], { env: wrapperEnv, encoding: "utf8" })).toBe(
        "AZ=azdo-wrapper-1\n",
      );

      rmSync(join(home, ".opengeni", "git-token"), { force: true });
      rmSync(join(home, ".opengeni", "git-credentials", "gitlab-token"), {
        force: true,
      });
      rmSync(join(home, ".opengeni", "git-credentials", "azure_devops-token"), {
        force: true,
      });
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
      expect(
        readdirSync(join(root, "ws", "repos", "acme")).filter((f) => f.includes(".tmp.")),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("abbreviated commit fetch explains the remedy while a hexadecimal branch remains valid", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-clone-ref-"));
    try {
      const origin = makeOrigin(root);
      const sha = execFileSync("git", ["-C", origin, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      const short = sha.slice(0, 8);
      const home = join(root, "home");
      mkdirSync(home);
      const target = join(root, "checkout");
      const resource = {
        kind: "repository" as const,
        uri: "https://github.com/opengeni/test-fixture.git",
        ref: short,
      };
      const missing = runScript(cloneScriptWithTarget(target, `file://${origin}`, resource), {
        HOME: home,
      });
      expect(missing.status).not.toBe(0);
      expect(missing.output).toContain("couldn't find remote ref");
      expect(missing.output).toContain("full commit SHA");
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(root).filter((entry) => entry.startsWith("checkout.tmp."))).toEqual([]);
      execFileSync("git", ["-C", origin, "branch", short]);
      const valid = runScript(cloneScriptWithTarget(target, `file://${origin}`, resource), {
        HOME: home,
      });
      expect(valid.status).toBe(0);
      expect(readFileSync(join(target, "README.md"), "utf8")).toBe("hello\n");
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
      const run = runScript(cloneScriptWithTarget(target, `file://${join(root, "nonexistent")}`), {
        HOME: home,
      });
      expect(run.status).not.toBe(0);
      expect(existsSync(target)).toBe(false);
      expect(existsSync(`${target}.tmp.`)).toBe(false);
      const parent = join(root, "ws", "repos", "acme");
      expect(
        existsSync(parent) ? readdirSync(parent).filter((f) => f.includes(".tmp.")) : [],
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clone script guards origin/HEAD behind the remote-tracking ref check and keeps fetch + checkout failure-gated", () => {
    const command = repositoryCloneCommand([
      {
        kind: "repository",
        uri: "https://github.com/acme/repo.git",
        ref: "pull/1720/head",
        mountPath: "repos/github.com/acme/repo",
      },
    ]);
    const lines = command.split("\n");
    const fetchIndex = lines.findIndex((line) =>
      line.includes('git -C "$tmp" fetch --depth 1 --no-tags --filter=blob:none origin "$ref"'),
    );
    const guardIndex = lines.findIndex((line) =>
      line.includes('if git -C "$tmp" rev-parse --verify --quiet "refs/remotes/origin/$ref"'),
    );
    const setHeadIndex = lines.findIndex((line) =>
      line.includes('git -C "$tmp" remote set-head origin "$ref" >/dev/null || true'),
    );
    const checkoutIndex = lines.findIndex((line) =>
      line.includes('if ! git -C "$tmp" checkout --detach FETCH_HEAD'),
    );

    expect(fetchIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(fetchIndex);
    expect(setHeadIndex).toBe(guardIndex + 1);
    expect(lines[setHeadIndex + 1]).toBe("  fi");
    expect(checkoutIndex).toBeGreaterThan(setHeadIndex);
    // set-head never shares the failure gate with fetch or checkout, and an
    // unexpected set-head failure after the guard cannot exit the set -e shell.
    expect(lines[setHeadIndex].trim().endsWith("|| true")).toBe(true);
    expect(lines[fetchIndex]).not.toContain("set-head");
    expect(lines[checkoutIndex]).not.toContain("set-head");
    expect(lines[setHeadIndex]).not.toContain("exit 1");
    expect(
      lines.filter((line) =>
        line.includes('echo "Repository resource fetch failed for $target" >&2'),
      ),
    ).toHaveLength(2);
  });

  test("clone by branch sets origin/HEAD; PR ref, tag, and commit SHA clone without origin/HEAD (previously set-head failed the clone)", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-clone-"));
    try {
      const origin = makeOrigin(root);
      const sha = execFileSync("git", ["-C", origin, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      // GitHub-style PR ref outside refs/heads/: fetchable, never remote-tracked.
      execFileSync("git", ["-C", origin, "update-ref", "refs/pull/1/head", sha]);
      // Lightweight tag: fetched by short name, never under refs/remotes/origin/.
      execFileSync("git", ["-C", origin, "tag", "v1.0", sha]);
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const env = { HOME: home };
      const cases: { ref: string; expectOriginHead: boolean }[] = [
        { ref: "main", expectOriginHead: true },
        { ref: "pull/1/head", expectOriginHead: false },
        { ref: "v1.0", expectOriginHead: false },
        { ref: sha, expectOriginHead: false },
      ];
      for (const [index, { ref, expectOriginHead }] of cases.entries()) {
        const target = join(root, "ws", "repos", "acme", `repo-${index}`);
        const run = runScript(
          cloneScriptWithTarget(target, `file://${origin}`, undefined, ref),
          env,
        );
        expect({ ref, status: run.status, output: run.output }).toEqual({
          ref,
          status: 0,
          output: expect.stringContaining(`Repository resource ready at ${target}`),
        });
        expect(existsSync(join(target, "README.md"))).toBe(true);
        expect(
          execFileSync("git", ["-C", target, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        ).toBe(sha);
        const originHead = (() => {
          try {
            return execFileSync(
              "git",
              ["-C", target, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD"],
              { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
            ).trim();
          } catch {
            return null;
          }
        })();
        expect({ ref, originHead }).toEqual({ ref, originHead: expectOriginHead ? sha : null });
        expect(
          readdirSync(join(root, "ws", "repos", "acme")).filter((f) => f.includes(".tmp.")),
        ).toEqual([]);
      }
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
        ...base,
        ARM_CLIENT_ID: "cid",
        ARM_CLIENT_SECRET: "sec",
        ARM_TENANT_ID: "tid",
      });
      expect(noSub.status).toBe(0);

      // with subscription id: still 0
      const withSub = runScript(azureCliLoginCommand(), {
        ...base,
        ARM_CLIENT_ID: "cid",
        ARM_CLIENT_SECRET: "sec",
        ARM_TENANT_ID: "tid",
        ARM_SUBSCRIPTION_ID: "sub",
      });
      expect(withSub.status).toBe(0);

      // no creds at all: no-op, exit 0
      expect(runScript(azureCliLoginCommand(), base).status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
