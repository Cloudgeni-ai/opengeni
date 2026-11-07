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
    utimesSync,
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
    subpath = "",
    credentialSource?: "connection" | "provider",
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
    return `${withoutInvocations}\nclone_repository '${target}' '${uri}' '${ref}' '${subpath}' '${resource.expectedCommitSha ?? ""}'${credentialSource ? ` '${credentialSource}'` : ""}`;
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
        expect(output).toContain("Refusing to provision Opengeni Git credentials");
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
          shell: "bash",
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
        expect(refused.stderr).toContain("Refusing to provision Opengeni Git credentials");
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

  test("a box that already holds the verified clone program re-runs setup in one command", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-staged-clone-"));
    try {
      const origin = makeOrigin(root);
      const workspace = join(root, "workspace");
      mkdirSync(workspace, { recursive: true });
      const remote = "https://github.com/opengeni/staged.git";
      const inner = hostShellSession(join(root, "home"), {
        shell: "bash",
        cwd: workspace,
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
          GIT_CONFIG_VALUE_0: remote,
        },
        rewriteCommand: (cmd) => cmd.replaceAll("'/workspace/", `'${workspace}/`),
      });
      const commands: string[] = [];
      let withoutGzip = false;
      const session = {
        ...inner,
        exec: async (args: { cmd: string }) => {
          commands.push(args.cmd);
          const cmd = withoutGzip
            ? args.cmd.replaceAll("command -v gzip >/dev/null 2>&1", "false")
            : args.cmd;
          return await inner.exec({ ...args, cmd } as never);
        },
      };
      const resources = [
        {
          kind: "repository" as const,
          uri: remote,
          ref: "main",
          mountPath: "repos/test/staged",
        },
      ];
      const runHook = async (token: string) => {
        commands.length = 0;
        await runRepositoryCloneHook(session as never, resources, {
          environment: {},
          gitTokenSeeds: { github: token },
        });
        return [...commands];
      };

      // Fresh box: the launcher carries the compressed program, installs it
      // under its content hash and clones, all in one command.
      const first = await runHook("first-token");
      expect(first).toHaveLength(1);
      expect(readFileSync(join(workspace, "repos", "test", "staged", "README.md"), "utf8")).toBe(
        "hello\n",
      );
      const programDirs = readdirSync(join(workspace, ".opengeni")).filter((name) =>
        name.startsWith("setup-programs-"),
      );
      expect(programDirs).toHaveLength(1);
      const programDir = join(workspace, ".opengeni", programDirs[0]!);
      const programs = readdirSync(programDir).filter((name) => name.endsWith(".sh"));
      expect(programs).toHaveLength(1);
      expect(programs[0]).toMatch(/^[0-9a-f]{64}\.sh$/u);
      const programFile = join(programDir, programs[0]!);
      // No secret is written into the reusable program.
      expect(readFileSync(programFile, "utf8")).not.toContain("first-token");

      // Next turn on the same box: exactly one command, carrying this turn's seed.
      // A day-old program from an earlier repository set is pruned in passing.
      const staleProgram = join(programDir, `${"0".repeat(64)}.sh`);
      writeFileSync(staleProgram, "exit 0\n");
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      utimesSync(staleProgram, twoDaysAgo, twoDaysAgo);
      const second = await runHook("second-token");
      expect(second).toHaveLength(1);
      expect(second[0]).toContain("second-token");
      expect(existsSync(staleProgram)).toBe(false);
      expect(existsSync(programFile)).toBe(true);
      expect(readFileSync(join(join(root, "home", ".opengeni"), "git-token"), "utf8")).toBe(
        "second-token",
      );

      // A modified program is never executed: it is reinstalled and verified
      // again by the same single command.
      writeFileSync(programFile, "echo tampered; exit 0\n");
      const third = await runHook("third-token");
      expect(third).toHaveLength(1);
      expect(third[0]).not.toContain("tampered");
      expect(readFileSync(programFile, "utf8")).toContain("clone_repository");
      expect(readFileSync(join(join(root, "home", ".opengeni"), "git-token"), "utf8")).toBe(
        "third-token",
      );

      // A box without gzip cannot unpack the embedded program; the launcher
      // reports it missing and the program is staged uncompressed instead.
      rmSync(programFile);
      withoutGzip = true;
      const fourth = await runHook("fourth-token");
      expect(fourth.length).toBeGreaterThan(2);
      expect(readFileSync(programFile, "utf8")).toContain("clone_repository");
      expect(readFileSync(join(join(root, "home", ".opengeni"), "git-token"), "utf8")).toBe(
        "fourth-token",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an optional repository that cannot be cloned is skipped with a warning while a required one stays fatal", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-optional-clone-"));
    try {
      const origin = makeOrigin(root);
      // A repository that does not exist: its fetch fails like an inaccessible
      // GitHub repository. (An empty repository is attachable; see below.)
      const missing = join(root, "missing");
      // A freshly created repository with no commits is attachable, optional or not.
      const empty = join(root, "empty");
      execFileSync("git", ["init", "--bare", "-b", "main", empty]);
      const workspace = join(root, "workspace");
      mkdirSync(workspace, { recursive: true });
      const remote = (name: string) => `https://github.com/opengeni/${name}.git`;
      const session = hostShellSession(join(root, "home"), {
        shell: "bash",
        cwd: workspace,
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "4",
          GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
          GIT_CONFIG_VALUE_0: remote("required"),
          GIT_CONFIG_KEY_1: `url.file://${origin}.insteadOf`,
          GIT_CONFIG_VALUE_1: remote("recent"),
          GIT_CONFIG_KEY_2: `url.file://${missing}.insteadOf`,
          GIT_CONFIG_VALUE_2: remote("missing"),
          GIT_CONFIG_KEY_3: `url.file://${empty}.insteadOf`,
          GIT_CONFIG_VALUE_3: remote("empty"),
        },
        rewriteCommand: (cmd) => cmd.replaceAll("'/workspace/", `'${workspace}/`),
      });
      const repository = (name: string, optional: boolean) => ({
        kind: "repository" as const,
        uri: remote(name),
        ref: "main",
        mountPath: `repos/test/${name}`,
        ...(optional ? { optional: true } : {}),
      });
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const warnings: unknown[][] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args);
      };
      try {
        await runRepositoryCloneHook(
          session as never,
          [
            repository("required", false),
            repository("missing", true),
            repository("empty", true),
            repository("recent", true),
          ],
          {
            environment: {},
            onRuntimeEvent: async (event) => {
              events.push(event as never);
            },
          },
        );
      } finally {
        console.warn = warn;
      }
      expect(readFileSync(join(workspace, "repos", "test", "required", "README.md"), "utf8")).toBe(
        "hello\n",
      );
      expect(readFileSync(join(workspace, "repos", "test", "recent", "README.md"), "utf8")).toBe(
        "hello\n",
      );
      expect(
        execFileSync("git", [
          "-C",
          join(workspace, "repos", "test", "empty"),
          "symbolic-ref",
          "HEAD",
        ]),
      ).toBe("refs/heads/main\n");
      // The failed optional clone leaves no partial tree or temporary clone.
      expect(
        existsSync(join(workspace, "repos", "test", "missing")) &&
          readdirSync(join(workspace, "repos", "test", "missing")).length > 0,
      ).toBe(false);
      expect(
        readdirSync(join(workspace, "repos", "test")).filter((name) => name.includes(".tmp.")),
      ).toEqual([]);
      expect(events.map((event) => event.type)).toEqual([
        "sandbox.operation.started",
        "sandbox.operation.completed",
      ]);
      expect(events[1]!.payload).toMatchObject({
        name: "repository-clone",
        repositoryCount: 4,
        skippedOptionalRepositories: ["repos/test/missing"],
      });
      expect(warnings).toEqual([
        [
          "[sandbox] optional repository resources were not cloned",
          { skippedCount: 1, repositoryCount: 4 },
        ],
      ]);

      // The same unreachable repository attached explicitly stays strict: the
      // hook fails and reports the failure.
      const strictEvents: string[] = [];
      await expect(
        runRepositoryCloneHook(session as never, [repository("missing", false)], {
          environment: {},
          onRuntimeEvent: async (event) => {
            strictEvents.push(event.type);
          },
        }),
      ).rejects.toThrow("Repository resource fetch failed");
      expect(strictEvents).toEqual(["sandbox.operation.started", "sandbox.operation.failed"]);

      // An explicitly attached empty repository no longer fails the turn.
      const emptyEvents: string[] = [];
      await runRepositoryCloneHook(
        session as never,
        [{ ...repository("empty", false), mountPath: "repos/test/empty-required" }],
        {
          environment: {},
          onRuntimeEvent: async (event) => {
            emptyEvents.push(event.type);
          },
        },
      );
      expect(emptyEvents).toEqual(["sandbox.operation.started", "sandbox.operation.completed"]);
      expect(
        execFileSync("git", [
          "-C",
          join(workspace, "repos", "test", "empty-required"),
          "symbolic-ref",
          "HEAD",
        ]),
      ).toBe("refs/heads/main\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an optional repository whose fetch hangs is skipped after its bound while a required one still clones", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-optional-clone-timeout-"));
    // A server that accepts the connection and never answers: a hung fetch.
    const sockets: Array<{ end: () => void }> = [];
    const hanging = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => {
          sockets.push(socket);
        },
        data: () => undefined,
      },
    });
    try {
      const origin = makeOrigin(root);
      const workspace = join(root, "workspace");
      mkdirSync(workspace, { recursive: true });
      const remote = (name: string) => `https://github.com/opengeni/${name}.git`;
      const session = hostShellSession(join(root, "home"), {
        shell: "bash",
        cwd: workspace,
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
          GIT_CONFIG_VALUE_0: remote("required"),
          GIT_CONFIG_KEY_1: `url.http://127.0.0.1:${hanging.port}/hung.git.insteadOf`,
          GIT_CONFIG_VALUE_1: remote("hung"),
        },
        rewriteCommand: (cmd) => cmd.replaceAll("'/workspace/", `'${workspace}/`),
      });
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const warn = console.warn;
      console.warn = () => undefined;
      const started = Date.now();
      try {
        await runRepositoryCloneHook(
          session as never,
          [
            {
              kind: "repository",
              uri: remote("required"),
              ref: "main",
              mountPath: "repos/test/required",
            },
            {
              kind: "repository",
              uri: remote("hung"),
              ref: "main",
              mountPath: "repos/test/hung",
              optional: true,
            },
          ],
          {
            environment: {},
            onRuntimeEvent: async (event) => {
              events.push(event as never);
            },
          },
          { optionalCloneTimeoutSeconds: 2 },
        );
      } finally {
        console.warn = warn;
      }
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(readFileSync(join(workspace, "repos", "test", "required", "README.md"), "utf8")).toBe(
        "hello\n",
      );
      expect(events[1]!.payload).toMatchObject({
        name: "repository-clone",
        repositoryCount: 2,
        skippedOptionalRepositories: ["repos/test/hung"],
      });
      // The timed-out fetch leaves no partial tree or temporary clone behind.
      expect(
        existsSync(join(workspace, "repos", "test", "hung")) &&
          readdirSync(join(workspace, "repos", "test", "hung")).length > 0,
      ).toBe(false);
      expect(
        readdirSync(join(workspace, "repos", "test")).filter((name) => name.includes(".tmp.")),
      ).toEqual([]);
    } finally {
      for (const socket of sockets) socket.end();
      hanging.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

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
      lines.filter(
        (line) =>
          line.includes("'https|git.example|acme/repo') ") &&
          line.includes("username='x-access-token'"),
      ),
    ).toHaveLength(1);
    expect(
      lines.filter(
        (line) =>
          line.includes("'https|git.example|acme/repo.git') ") &&
          line.includes("username='x-access-token'"),
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

  test("broker insteadOf rewrites leave repositories that only share a URL prefix untouched", () => {
    // Regression: a brokered `https://github.com/acme/app` rewrite captured the
    // app-installation repository `https://github.com/acme/app-demos.git` too,
    // because Git matches insteadOf by plain prefix. Its fetch then went to
    // `<broker>-demos.git` and failed with "Git repository route not found".
    const root = mkdtempSync(join(tmpdir(), "opengeni-git-http-broker-siblings-"));
    try {
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const appBroker = "https://broker.example.test/v1/git/personal/route-app";
      const opsBroker = "https://broker.example.test/v1/git/personal/route-app-ops";
      const resources = [
        {
          kind: "repository" as const,
          uri: "https://github.com/acme/app",
          ref: "main",
          provider: "github" as const,
          connectionType: "github_personal" as const,
          credentialBindingId: "personal-binding",
          repositoryId: "101",
          access: "write" as const,
        },
        {
          kind: "repository" as const,
          uri: "https://github.com/acme/app-ops",
          ref: "main",
          provider: "github" as const,
          connectionType: "github_personal" as const,
          credentialBindingId: "personal-binding",
          repositoryId: "102",
          access: "read" as const,
        },
        {
          kind: "repository" as const,
          uri: "https://github.com/acme/app-demos.git",
          ref: "main",
          provider: "github" as const,
          githubInstallationId: 7,
          githubRepositoryId: 103,
        },
      ];
      const bindings = [
        {
          credentialBindingId: "personal-binding",
          provider: "github" as const,
          token: "broker-bearer",
          providerBindingCount: 2,
          transport: {
            kind: "http_broker" as const,
            repositories: [
              { repositoryUri: "https://github.com/acme/app", brokerUri: appBroker },
              { repositoryUri: "https://github.com/acme/app-ops", brokerUri: opsBroker },
            ],
          },
        },
        {
          credentialBindingId: "github-installation:7",
          provider: "github" as const,
          token: "installation-token",
          providerBindingCount: 2,
        },
      ];
      const brokerSeedPath = join(root, "sibling-broker-seed");
      writeFileSync(brokerSeedPath, "broker-bearer", { mode: 0o600 });
      const refresh = gitCredentialBindingTokenRefreshCommand(bindings, [
        {
          bindingHash: gitCredentialBindingHash(bindings[0]!.credentialBindingId),
          path: brokerSeedPath,
        },
      ]);
      const setup = runScript(`${refresh}\n${setupScript(resources, bindings)}`, { HOME: home });
      expect(setup.output).toBe("");
      expect(setup.status).toBe(0);

      const effectiveUrl = (url: string) =>
        execFileSync("git", ["ls-remote", "--get-url", url], {
          cwd: root,
          env: { HOME: home },
          encoding: "utf8",
        }).trim();
      // The brokered repositories, and paths below them, still reach the broker.
      expect(effectiveUrl("https://github.com/acme/app")).toBe(appBroker);
      expect(effectiveUrl("https://github.com/acme/app/")).toBe(`${appBroker}/`);
      expect(effectiveUrl("https://github.com/acme/app-ops")).toBe(opsBroker);
      // The `.git` clone URL GitHub shows is the same repository and reaches
      // the same broker route.
      expect(effectiveUrl("https://github.com/acme/app.git")).toBe(appBroker);
      expect(effectiveUrl("https://github.com/acme/app.git/")).toBe(`${appBroker}/`);
      expect(effectiveUrl("https://github.com/acme/app-ops.git")).toBe(opsBroker);
      // Repositories whose URL merely starts with a brokered one stay put,
      // whether attached through another binding or cloned by hand.
      for (const sibling of [
        "https://github.com/acme/app-demos.git",
        "https://github.com/acme/app-demos",
        "https://github.com/acme/app.github.io",
        "https://github.com/acme/app.git-tools",
        "https://github.com/acme/app_tools",
        "https://github.com/acme/app2",
        "https://github.com/acme/app-ops-archive",
        'https://github.com/acme/app"quoted\\name',
      ]) {
        expect(effectiveUrl(sibling)).toBe(sibling);
      }

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
      expect(fill("github.com", "acme/app-demos.git")).toContain("password=installation-token");
      expect(fill("broker.example.test", "v1/git/personal/route-app")).toContain(
        "password=broker-bearer",
      );
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
      // A credential profile that delivered GH_TOKEN to the command wins over
      // the binding token file; one that delivered other names does not.
      expect(
        execFileSync("gh", [], {
          env: {
            ...wrapperEnv,
            GH_TOKEN: "profile-fake-token",
            OPENGENI_CREDENTIAL_PROFILE_VARS: "AZURE_CLIENT_ID,GH_TOKEN",
          },
          encoding: "utf8",
        }),
      ).toBe("GH=profile-fake-token\n");
      expect(
        execFileSync("gh", [], {
          env: {
            ...wrapperEnv,
            GH_TOKEN: "stale-ambient-token",
            OPENGENI_CREDENTIAL_PROFILE_VARS: "AZURE_CLIENT_ID,GH_TOKENS",
          },
          encoding: "utf8",
        }),
      ).toBe("GH=ghs-wrapper-1\n");

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

  test("clone is idempotent on a valid work tree and moves a partial (interrupted) tree aside before re-cloning", () => {
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

      // partial tree (interrupted materialization: files but no .git) -> moved
      // aside, never deleted, and rebuilt
      rmSync(join(target, ".git"), { recursive: true, force: true });
      const third = runScript(script, env);
      expect(third.status).toBe(0);
      expect(third.output).toContain("Re-materializing partial repository resource");
      expect(existsSync(join(target, ".git"))).toBe(true);
      expect(existsSync(join(target, "README.md"))).toBe(true);
      expect(existsSync(join(target, "WORK.md"))).toBe(false);
      const [recovered] = recoveredSiblings(target);
      expect(recovered).toBeDefined();
      expect(readFileSync(join(recovered!, "WORK.md"), "utf8")).toBe("agent work\n");
      expect(third.output).toContain(
        `Notice: moved repository folder aside []: ${target}\t${recovered}\tunreadable`,
      );
      // no tmp clone leaked beside the target
      expect(
        readdirSync(join(root, "ws", "repos", "acme")).filter((f) => f.includes(".tmp.")),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  /** The `<target>.opengeni-recovered-*` siblings of a repository folder. */
  function recoveredSiblings(target: string): string[] {
    const parent = join(target, "..");
    const name = target.slice(target.lastIndexOf("/") + 1);
    return readdirSync(parent)
      .filter((entry) => entry.startsWith(`${name}.opengeni-recovered-`))
      .sort()
      .map((entry) => join(parent, entry));
  }

  /** Every copy of the target, in place or moved aside, still holding `file`. */
  function copiesHolding(target: string, file: string): string[] {
    return [target, ...recoveredSiblings(target)].filter((dir) => existsSync(join(dir, file)));
  }

  const commitEnv = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };

  test("a repository folder owned by another user is trusted with safe.directory and kept, never re-cloned", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-clone-owner-"));
    try {
      const origin = makeOrigin(root);
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const target = join(root, "ws", "repos", "acme", "owned");
      const script = cloneScriptWithTarget(target, `file://${origin}`);
      expect(runScript(script, { HOME: home }).status).toBe(0);
      writeFileSync(join(target, "dc-uncommitted.txt"), "uncommitted\n");

      // Git's own switch for "this repository belongs to someone else", the
      // state `chown -R 1000:1000 <repo>` leaves for a root setup user.
      const otherOwner = { HOME: home, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };
      const run = runScript(script, otherOwner);
      expect(existsSync(join(target, "dc-uncommitted.txt"))).toBe(true);
      expect(run.status).toBe(0);
      expect(run.output).toContain("owned by another user; added it to safe.directory");
      expect(run.output).toContain(`Repository resource already present at ${target}`);
      expect(readFileSync(join(target, "dc-uncommitted.txt"), "utf8")).toBe("uncommitted\n");
      expect(recoveredSiblings(target)).toEqual([]);
      expect(
        execFileSync("git", ["config", "--global", "--get-all", "safe.directory"], {
          env: { HOME: home },
        }),
      ).toBe(`${target}\n`);

      // Later turns find the trusted folder readable and add nothing again.
      const again = runScript(script, otherOwner);
      expect(again.status).toBe(0);
      expect(again.output).not.toContain("safe.directory");
      expect(
        execFileSync("git", ["config", "--global", "--get-all", "safe.directory"], {
          env: { HOME: home },
        }),
      ).toBe(`${target}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a repository with a corrupt HEAD is moved aside with its work and cloned fresh", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-clone-corrupt-"));
    try {
      const origin = makeOrigin(root);
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const target = join(root, "ws", "repos", "acme", "corrupt");
      const script = cloneScriptWithTarget(target, `file://${origin}`);
      expect(runScript(script, { HOME: home }).status).toBe(0);
      writeFileSync(join(target, "dc-uncommitted.txt"), "uncommitted\n");
      writeFileSync(join(target, ".git", "HEAD"), "not a ref\n");

      const run = runScript(script, { HOME: home });
      // The uncommitted file survives, in the moved copy.
      expect(copiesHolding(target, "dc-uncommitted.txt")).toHaveLength(1);
      expect(run.status).toBe(0);
      const recovered = recoveredSiblings(target);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatch(/\.opengeni-recovered-\d{8}T\d{6}Z$/u);
      expect(readFileSync(join(recovered[0]!, "dc-uncommitted.txt"), "utf8")).toBe("uncommitted\n");
      expect(readFileSync(join(recovered[0]!, ".git", "HEAD"), "utf8")).toBe("not a ref\n");
      expect(run.output).toContain(
        `Notice: moved repository folder aside []: ${target}\t${recovered[0]}\tunreadable`,
      );
      // A fresh, readable clone took its place.
      expect(execFileSync("git", ["-C", target, "status", "--porcelain"])).toBe("");
      expect(readFileSync(join(target, "README.md"), "utf8")).toBe("hello\n");
      expect(existsSync(join(target, "dc-uncommitted.txt"))).toBe(false);

      // A second corruption in the same second gets its own recovery folder.
      writeFileSync(join(target, ".git", "HEAD"), "not a ref\n");
      expect(runScript(script, { HOME: home }).status).toBe(0);
      expect(recoveredSiblings(target)).toHaveLength(2);
      expect(
        readdirSync(join(root, "ws", "repos", "acme")).filter((f) => f.includes(".tmp.")),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pinned repository keeps the agent's commits on the pin in place", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-clone-pinned-"));
    try {
      const origin = makeOrigin(root);
      const first = execFileSync("git", ["-C", origin, "rev-parse", "HEAD"]).trim();
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const target = join(root, "ws", "repos", "acme", "pinned");
      const pinned = (expectedCommitSha: string) =>
        cloneScriptWithTarget(target, `file://${origin}`, {
          kind: "repository",
          uri: "https://github.com/opengeni/test-fixture.git",
          ref: "main",
          expectedCommitSha,
        });
      expect(runScript(pinned(first), { HOME: home }).status).toBe(0);

      // The agent commits on top of the pinned commit: that is the pin plus
      // its work, so it stays in place on later turns.
      writeFileSync(join(target, "agent.txt"), "committed\n");
      execFileSync("git", ["-C", target, "add", "agent.txt"]);
      execFileSync("git", ["-C", target, "commit", "-m", "agent work"], { env: commitEnv });
      const agentHead = execFileSync("git", ["-C", target, "rev-parse", "HEAD"]).trim();
      writeFileSync(join(target, "dc-uncommitted.txt"), "uncommitted\n");
      const kept = runScript(pinned(first), { HOME: home });
      expect(copiesHolding(target, "dc-uncommitted.txt")).toEqual([target]);
      expect(kept.status).toBe(0);
      expect(kept.output).toContain(`Repository resource already present at ${target}`);
      expect(execFileSync("git", ["-C", target, "rev-parse", "HEAD"]).trim()).toBe(agentHead);
      expect(readFileSync(join(target, "dc-uncommitted.txt"), "utf8")).toBe("uncommitted\n");
      expect(recoveredSiblings(target)).toEqual([]);

      // The clone records the commit it materialized, so the agent's own
      // branches stay in place while the pin is unchanged, even off the pin.
      expect(
        execFileSync("git", ["-C", target, "config", "--get", "opengeni.materializedCommit"]),
      ).toBe(`${first}\n`);
      execFileSync("git", ["-C", target, "checkout", "-q", "--orphan", "rewrite"]);
      execFileSync("git", ["-C", target, "commit", "-qm", "rewrite"], { env: commitEnv });
      const branched = runScript(pinned(first), { HOME: home });
      expect(branched.status).toBe(0);
      expect(branched.output).toContain(`Repository resource already present at ${target}`);
      expect(recoveredSiblings(target)).toEqual([]);

      // A folder cloned before the record existed counts while HEAD is built on
      // the pin, and gets the record.
      execFileSync("git", ["-C", target, "checkout", "-q", agentHead]);
      execFileSync("git", ["-C", target, "config", "--unset", "opengeni.materializedCommit"]);
      const legacy = runScript(pinned(first), { HOME: home });
      expect(legacy.status).toBe(0);
      expect(legacy.output).toContain(`Repository resource already present at ${target}`);
      expect(
        execFileSync("git", ["-C", target, "config", "--get", "opengeni.materializedCommit"]),
      ).toBe(`${first}\n`);
      expect(recoveredSiblings(target)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pinned repository at another commit is moved aside with its work and cloned fresh", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-clone-repinned-"));
    try {
      const origin = makeOrigin(root);
      const first = execFileSync("git", ["-C", origin, "rev-parse", "HEAD"]).trim();
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const target = join(root, "ws", "repos", "acme", "pinned");
      const pinned = (expectedCommitSha: string) =>
        cloneScriptWithTarget(target, `file://${origin}`, {
          kind: "repository",
          uri: "https://github.com/opengeni/test-fixture.git",
          ref: "main",
          expectedCommitSha,
        });
      expect(runScript(pinned(first), { HOME: home }).status).toBe(0);
      writeFileSync(join(target, "agent.txt"), "committed\n");
      execFileSync("git", ["-C", target, "add", "agent.txt"]);
      execFileSync("git", ["-C", target, "commit", "-m", "agent work"], { env: commitEnv });
      const agentHead = execFileSync("git", ["-C", target, "rev-parse", "HEAD"]).trim();
      writeFileSync(join(target, "dc-uncommitted.txt"), "uncommitted\n");

      // The pin moves to a commit the folder is not built on: the old folder,
      // with its unpushed commit and uncommitted file, is moved aside.
      writeFileSync(join(origin, "README.md"), "second\n");
      execFileSync("git", ["-C", origin, "commit", "-am", "second"], { env: commitEnv });
      const second = execFileSync("git", ["-C", origin, "rev-parse", "HEAD"]).trim();
      const moved = runScript(pinned(second), { HOME: home });
      expect(copiesHolding(target, "dc-uncommitted.txt")).toHaveLength(1);
      expect(moved.status).toBe(0);
      expect(moved.output).toContain("does not match expected commit");
      const recovered = recoveredSiblings(target);
      expect(recovered).toHaveLength(1);
      expect(readFileSync(join(recovered[0]!, "dc-uncommitted.txt"), "utf8")).toBe("uncommitted\n");
      expect(execFileSync("git", ["-C", recovered[0]!, "rev-parse", "HEAD"]).trim()).toBe(
        agentHead,
      );
      expect(moved.output).toContain(
        `Notice: moved repository folder aside []: ${target}\t${recovered[0]}\tpin`,
      );
      expect(execFileSync("git", ["-C", target, "rev-parse", "HEAD"]).trim()).toBe(second);
      expect(readFileSync(join(target, "README.md"), "utf8")).toBe("second\n");

      // A pin that moves back to an older commit is enforced too: the folder
      // holding the newer pin is moved aside.
      const back = runScript(
        cloneScriptWithTarget(
          target,
          `file://${origin}`,
          {
            kind: "repository",
            uri: "https://github.com/opengeni/test-fixture.git",
            ref: first,
            expectedCommitSha: first,
          },
          first,
        ),
        { HOME: home },
      );
      expect(back.status).toBe(0);
      expect(recoveredSiblings(target)).toHaveLength(2);
      expect(execFileSync("git", ["-C", target, "rev-parse", "HEAD"]).trim()).toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pinned subpath extract is kept on later turns", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-clone-pinned-subpath-"));
    try {
      const origin = makeOrigin(root);
      mkdirSync(join(origin, "docs"));
      writeFileSync(join(origin, "docs", "guide.md"), "guide\n");
      execFileSync("git", ["-C", origin, "add", "docs"]);
      execFileSync("git", ["-C", origin, "commit", "-qm", "docs"], { env: commitEnv });
      const sha = execFileSync("git", ["-C", origin, "rev-parse", "HEAD"]).trim();
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const target = join(root, "ws", "docs");
      const script = cloneScriptWithTarget(
        target,
        `file://${origin}`,
        {
          kind: "repository",
          uri: "https://github.com/opengeni/test-fixture.git",
          ref: "main",
          expectedCommitSha: sha,
          subpath: "docs",
        },
        "main",
        "docs",
      );
      expect(runScript(script, { HOME: home }).status).toBe(0);
      writeFileSync(join(target, "notes.md"), "agent notes\n");
      const again = runScript(script, { HOME: home });
      expect(again.status).toBe(0);
      expect(again.output).toContain(`Repository resource already present at ${target}`);
      expect(readFileSync(join(target, "notes.md"), "utf8")).toBe("agent notes\n");
      expect(recoveredSiblings(target)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a mount point that cannot be renamed has its entries moved aside, or is left whole", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-clone-mount-"));
    try {
      const origin = makeOrigin(root);
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const target = join(root, "ws", "repos", "acme", "mounted");
      // A mount point refuses rename, like `mv` of a mounted directory.
      const shim = join(root, "shim");
      mkdirSync(shim);
      const realMv = execFileSync("sh", ["-c", "command -v mv"]).trim();
      const sq = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      writeFileSync(
        join(shim, "mv"),
        [
          "#!/bin/sh",
          'src="$1"; [ "$src" = "--" ] && src="$2"',
          `case "$src" in ${sq(target)}|*/stuck.txt) echo "mv: Device or resource busy" >&2; exit 1 ;; esac`,
          `exec ${sq(realMv)} "$@"`,
        ].join("\n"),
        { mode: 0o755 },
      );
      const env = { HOME: home, PATH: `${shim}:${process.env.PATH ?? "/usr/bin:/bin"}` };
      const script = cloneScriptWithTarget(target, `file://${origin}`);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "dc-uncommitted.txt"), "uncommitted\n");
      mkdirSync(join(target, "src"));
      writeFileSync(join(target, "src", "work.ts"), "work\n");

      const moved = runScript(script, env);
      expect(copiesHolding(target, "dc-uncommitted.txt")).toHaveLength(1);
      expect(moved.status).toBe(0);
      const [copy] = recoveredSiblings(target);
      expect(readFileSync(join(copy!, "dc-uncommitted.txt"), "utf8")).toBe("uncommitted\n");
      expect(readFileSync(join(copy!, "src", "work.ts"), "utf8")).toBe("work\n");
      expect(readFileSync(join(target, "README.md"), "utf8")).toBe("hello\n");

      // One entry that cannot move: everything is put back and nothing re-cloned.
      writeFileSync(join(target, ".git", "HEAD"), "not a ref\n");
      writeFileSync(join(target, "stuck.txt"), "stuck\n");
      writeFileSync(join(target, "dc-uncommitted.txt"), "second\n");
      const stuck = runScript(script, env);
      expect(stuck.status).not.toBe(0);
      expect(stuck.output).toContain("Nothing was deleted.");
      expect(readFileSync(join(target, "dc-uncommitted.txt"), "utf8")).toBe("second\n");
      expect(readFileSync(join(target, ".git", "HEAD"), "utf8")).toBe("not a ref\n");
      expect(readFileSync(join(target, "stuck.txt"), "utf8")).toBe("stuck\n");
      expect(recoveredSiblings(target)).toEqual([copy]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("only Opengeni's own nested temporary clones are removed without a recovery copy", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-clone-nested-tmp-"));
    try {
      const origin = makeOrigin(root);
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const target = join(root, "ws", "repos", "acme", "raced");
      // A lost install race nests the loser's temporary clone in the target.
      mkdirSync(join(target, "raced.tmp.4242", ".git"), { recursive: true });
      const run = runScript(cloneScriptWithTarget(target, `file://${origin}`), { HOME: home });
      expect(run.status).toBe(0);
      expect(readdirSync(target).sort()).toEqual([".git", "README.md"]);
      expect(recoveredSiblings(target)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the clone hook reports moved folders to the model and in its completed event", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-clone-recovery-hook-"));
    try {
      const origin = makeOrigin(root);
      const workspace = join(root, "workspace");
      mkdirSync(workspace, { recursive: true });
      const uri = "https://github.com/opengeni/recovered.git";
      const session = hostShellSession(join(root, "home"), {
        cwd: workspace,
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
          GIT_CONFIG_VALUE_0: uri,
        },
        rewriteCommand: (cmd) => cmd.replaceAll("'/workspace/", `'${workspace}/`),
      });
      const resource = {
        kind: "repository" as const,
        uri,
        ref: "main",
        mountPath: "repos/test/recovered",
      };
      const target = join(workspace, "repos", "test", "recovered");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "notes.txt"), "not a repository yet\n");
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const notices: string[] = [];
      const warn = console.warn;
      console.warn = () => undefined;
      try {
        await runRepositoryCloneHook(session as never, [resource], {
          environment: {},
          onRuntimeEvent: async (event) => {
            events.push(event as never);
          },
          onSetupNotice: (notice) => notices.push(notice),
        });
      } finally {
        console.warn = warn;
      }
      const [recovered] = recoveredSiblings(target);
      expect(readFileSync(join(recovered!, "notes.txt"), "utf8")).toBe("not a repository yet\n");
      const movedTo = `repos/test/${recovered!.slice(recovered!.lastIndexOf("/") + 1)}`;
      expect(events[1]).toMatchObject({
        type: "sandbox.operation.completed",
        payload: {
          name: "repository-clone",
          recoveredRepositories: [{ path: "repos/test/recovered", movedTo }],
        },
      });
      expect(notices).toEqual([
        [
          "[Opengeni setup notice] These repository folders were moved aside instead of deleted, and a fresh copy was cloned in their place:",
          `- ${target} was moved to ${recovered} because it was not a readable Git work tree.`,
          "Any uncommitted or unpushed work from before is in the moved copy. Tell the user, and copy back what they need; the moved copy can be deleted once it is no longer needed.",
        ].join("\n"),
      ]);
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

  test("an empty remote materializes as an unborn branch with origin set, so the agent can commit and push", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-clone-empty-"));
    try {
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const env = { HOME: home };
      const cases = [
        { ref: "main", branch: "main", source: undefined },
        { ref: "backup", branch: "backup", source: "provider" as const },
        { ref: "refs/heads/feature/x", branch: "feature/x", source: undefined },
        { ref: "HEAD", branch: "main", source: "connection" as const },
      ];
      for (const [index, { ref, branch, source }] of cases.entries()) {
        // A freshly created GitHub repository: no commits, no refs at all.
        const empty = join(root, `empty-${index}.git`);
        execFileSync("git", ["init", "--bare", "-b", "main", empty]);
        const uri = `file://${empty}`;
        const target = join(root, "ws", "repos", "acme", `empty-${index}`);
        const script = cloneScriptWithTarget(target, uri, undefined, ref, "", source);
        const run = runScript(script, env);
        expect({ ref, status: run.status }).toEqual({ ref, status: 0 });
        expect(run.output).toContain(`starts on unborn branch ${branch}`);
        expect(run.output).toContain(`Repository resource ready at ${target}`);
        expect(run.output).not.toContain("couldn't find remote ref");
        expect(run.output).not.toContain("hint:");
        expect(execFileSync("git", ["-C", target, "symbolic-ref", "HEAD"]).trim()).toBe(
          `refs/heads/${branch}`,
        );
        expect(execFileSync("git", ["-C", target, "remote", "get-url", "origin"]).trim()).toBe(uri);

        // Later turns keep the work tree, including uncommitted agent work,
        // without consulting the remote again.
        writeFileSync(join(target, "README.md"), "backup\n");
        const again = runScript(script, env);
        expect(again.status).toBe(0);
        expect(again.output).toContain("already present");
        expect(readFileSync(join(target, "README.md"), "utf8")).toBe("backup\n");

        execFileSync("git", ["-C", target, "add", "README.md"]);
        execFileSync("git", [
          "-C",
          target,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          "commit",
          "-m",
          "init",
        ]);
        // The branch tracks origin, so a plain `git push` publishes it.
        execFileSync("git", ["-C", target, "push"]);
        expect(execFileSync("git", ["-C", empty, "rev-parse", `refs/heads/${branch}`]).trim()).toBe(
          execFileSync("git", ["-C", target, "rev-parse", "HEAD"]).trim(),
        );
        expect(
          readdirSync(join(root, "ws", "repos", "acme")).filter((f) => f.includes(".tmp.")),
        ).toEqual([]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an untouched empty-remote mount is cloned properly once the remote gains commits", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-clone-empty-filled-"));
    try {
      const empty = join(root, "empty.git");
      execFileSync("git", ["init", "--bare", "-b", "main", empty]);
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const uri = `file://${empty}`;
      const untouched = join(root, "ws", "untouched");
      const worked = join(root, "ws", "worked");
      const staged = join(root, "ws", "staged");
      for (const target of [untouched, worked, staged]) {
        expect(runScript(cloneScriptWithTarget(target, uri), { HOME: home }).status).toBe(0);
      }
      writeFileSync(join(worked, "NOTES.md"), "agent work\n");
      // Work that exists only in the index still counts as work.
      writeFileSync(join(staged, "STAGED.md"), "staged work\n");
      execFileSync("git", ["-C", staged, "add", "STAGED.md"]);
      rmSync(join(staged, "STAGED.md"));

      // Someone else pushes the first commit (for example the user's backup).
      // Commits on another branch only keep the stub; the mount's branch is
      // still absent on the remote, so re-fetching it would fail every turn.
      const origin = makeOrigin(root);
      execFileSync("git", ["-C", origin, "push", uri, "main:master"]);
      const otherBranch = runScript(cloneScriptWithTarget(untouched, uri), { HOME: home });
      expect(otherBranch.status).toBe(0);
      expect(otherBranch.output).toContain("already present");
      expect(execFileSync("git", ["-C", untouched, "symbolic-ref", "HEAD"])).toBe(
        "refs/heads/main\n",
      );

      execFileSync("git", ["-C", origin, "push", uri, "main"]);

      const refilled = runScript(cloneScriptWithTarget(untouched, uri), { HOME: home });
      expect(refilled.status).toBe(0);
      expect(refilled.output).toContain("now has commits; rematerializing");
      expect(readFileSync(join(untouched, "README.md"), "utf8")).toBe("hello\n");
      expect(recoveredSiblings(untouched)).toEqual([]);

      const stagedRun = runScript(cloneScriptWithTarget(staged, uri), { HOME: home });
      expect(stagedRun.status).toBe(0);
      const [stagedCopy] = recoveredSiblings(staged);
      expect(stagedCopy).toBeDefined();
      expect(execFileSync("git", ["-C", stagedCopy!, "show", ":STAGED.md"])).toBe("staged work\n");
      expect(stagedRun.output).toContain(
        `Notice: moved repository folder aside []: ${staged}\t${stagedCopy}\tremote-commits`,
      );
      expect(readFileSync(join(staged, "README.md"), "utf8")).toBe("hello\n");

      // A mount with agent work is never replaced.
      const kept = runScript(cloneScriptWithTarget(worked, uri), { HOME: home });
      expect(kept.status).toBe(0);
      expect(kept.output).toContain("already present");
      expect(readFileSync(join(worked, "NOTES.md"), "utf8")).toBe("agent work\n");
      expect(existsSync(join(worked, "README.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an empty remote stays fatal for a pinned commit or non-branch ref and says the repository is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-clone-empty-strict-"));
    try {
      const empty = join(root, "empty.git");
      execFileSync("git", ["init", "--bare", "-b", "main", empty]);
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const sha = "a".repeat(40);
      const uri = "https://github.com/opengeni/empty.git";
      const cases = [
        {
          resource: { kind: "repository" as const, uri, ref: "main", expectedCommitSha: sha },
          subpath: "",
        },
        { resource: { kind: "repository" as const, uri, ref: sha }, subpath: "" },
        { resource: { kind: "repository" as const, uri, ref: "abc1234" }, subpath: "" },
        { resource: { kind: "repository" as const, uri, ref: "pull/1/head" }, subpath: "" },
        { resource: { kind: "repository" as const, uri, ref: "refs/tags/v1" }, subpath: "" },
        { resource: { kind: "repository" as const, uri, ref: "main" }, subpath: "packages/api" },
      ];
      for (const [index, { resource, subpath }] of cases.entries()) {
        const target = join(root, "ws", `repo-${index}`);
        const run = runScript(
          cloneScriptWithTarget(target, `file://${empty}`, resource, resource.ref, subpath),
          { HOME: home },
        );
        expect({ ref: resource.ref, subpath, status: run.status }).toEqual({
          ref: resource.ref,
          subpath,
          status: 1,
        });
        expect(run.output).toContain(`Repository resource fetch failed for ${target}`);
        expect(run.output).toContain("The remote repository is empty");
        expect(existsSync(target)).toBe(false);
        expect(readdirSync(join(root, "ws")).filter((f) => f.includes(".tmp."))).toEqual([]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a missing ref on a non-empty remote still fails loudly without the empty-repository fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-clone-missing-ref-"));
    try {
      const origin = makeOrigin(root);
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const target = join(root, "ws", "repo");
      const run = runScript(
        cloneScriptWithTarget(target, `file://${origin}`, undefined, "does-not-exist"),
        { HOME: home },
      );
      expect(run.status).toBe(1);
      expect(run.output).toContain("couldn't find remote ref does-not-exist");
      expect(run.output).toContain(`Repository resource fetch failed for ${target}`);
      expect(run.output).toContain("Check repository access and the requested ref");
      expect(run.output).not.toContain("empty");
      expect(run.output).not.toContain("hint:");
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(join(root, "ws")).filter((f) => f.includes(".tmp."))).toEqual([]);
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
      line.includes('git -C "$tmp" fetch --depth 1 --no-tags origin "$ref"'),
    );
    const guardIndex = lines.findIndex((line) =>
      line.includes(
        'if repository_git -C "$tmp" rev-parse --verify --quiet "refs/remotes/origin/$ref"',
      ),
    );
    const setHeadIndex = lines.findIndex((line) =>
      line.includes('git -C "$tmp" remote set-head origin "$ref" >/dev/null || true'),
    );
    const checkoutIndex = lines.findIndex((line) =>
      line.includes('! repository_git -C "$tmp" checkout --detach FETCH_HEAD'),
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

  test("concurrent repository preparations on one box never fail on the global Git config lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-concurrent-prepare-"));
    try {
      const origin = makeOrigin(root);
      // One box: every preparation shares HOME and so the global Git config,
      // the way chats created together share their sandbox.
      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      const identity = {
        name: "opengeni[bot]",
        email: "42+opengeni[bot]@users.noreply.github.com",
      };
      const remotes = ["alpha", "beta", "gamma"].map(
        (name) => `https://github.com/acme/${name}.git`,
      );
      const resources = remotes.map((uri, index) => ({
        kind: "repository" as const,
        uri,
        ref: "main",
        mountPath: `repos/acme/repo-${index}`,
        githubInstallationId: 42,
        githubRepositoryId: 100 + index,
      }));
      const bindings = [
        {
          credentialBindingId: "github-installation:42",
          provider: "github" as const,
          token: "app-token",
          identity,
        },
      ];
      const preparations = 6;
      const sessions = Array.from({ length: preparations }, (_, index) => {
        const workspace = join(root, `workspace-${index}`);
        mkdirSync(workspace, { recursive: true });
        return (extraEnv: Record<string, string> = {}) =>
          hostShellSession(home, {
            cwd: workspace,
            env: {
              GIT_TERMINAL_PROMPT: "0",
              GIT_CONFIG_COUNT: String(remotes.length),
              ...Object.fromEntries(
                remotes.flatMap((remote, remoteIndex) => [
                  [`GIT_CONFIG_KEY_${remoteIndex}`, `url.file://${origin}.insteadOf`],
                  [`GIT_CONFIG_VALUE_${remoteIndex}`, remote],
                ]),
              ),
              ...extraEnv,
            },
            rewriteCommand: (cmd) => cmd.replaceAll("'/workspace/", `'${workspace}/`),
          });
      });

      // Another writer (the agent's own `git config --global`, say) holds the
      // global config lock while every preparation starts.
      const prepareAllWhileLocked = async (extraEnv: Record<string, string> = {}) => {
        const lockFile = join(home, ".gitconfig.lock");
        writeFileSync(lockFile, "");
        const release = setTimeout(() => rmSync(lockFile, { force: true }), 1_500);
        try {
          return await Promise.allSettled(
            sessions.map((session) =>
              runRepositoryCloneHook(session(extraEnv) as never, resources, {
                environment: {},
                gitCredentialBindings: bindings,
              }),
            ),
          );
        } finally {
          clearTimeout(release);
          rmSync(lockFile, { force: true });
        }
      };
      const failures = (results: PromiseSettledResult<void>[]) =>
        results.flatMap((result) =>
          result.status === "rejected" ? [String(result.reason).slice(0, 2_000)] : [],
        );

      // Fresh box: credential helper, broker include and default identity.
      expect(failures(await prepareAllWhileLocked())).toEqual([]);
      // Next turn on a box whose folders another user owns: every parallel
      // clone also trusts its folder in safe.directory.
      expect(
        failures(await prepareAllWhileLocked({ GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" })),
      ).toEqual([]);

      const globalConfig = (...args: string[]) =>
        execFileSync("git", ["config", "--global", ...args], { env: { HOME: home } })
          .split("\n")
          .filter((line, index, lines) => index < lines.length - 1 || line !== "");
      const helper = join(home, ".opengeni", "git-credentials", "helper");
      for (let index = 0; index < preparations; index += 1) {
        for (const resource of resources) {
          const target = join(root, `workspace-${index}`, resource.mountPath);
          expect(readFileSync(join(target, "README.md"), "utf8")).toBe("hello\n");
        }
      }
      expect(globalConfig("--get", "user.email")).toEqual([identity.email]);
      const helpers = globalConfig("--get-all", "credential.helper");
      const safeDirectories = globalConfig("--get-all", "safe.directory");
      expect(new Set(safeDirectories).size).toBe(safeDirectories.length);
      expect(safeDirectories.length).toBeGreaterThanOrEqual(preparations * resources.length);
      if (Bun.which("flock")) {
        // Serialised per box: each preparation replaced the helper chain whole.
        expect(helpers).toEqual(["", helper]);
        expect(globalConfig("--get-all", "include.path")).toEqual([
          join(home, ".opengeni", "git-credentials", "http-broker.gitconfig"),
        ]);
      } else {
        // Unserialised (no flock): writes still all land, and the chain after
        // the last reset is only our helper.
        const effective = helpers.slice(helpers.lastIndexOf("") + 1);
        expect(effective.length).toBeGreaterThan(0);
        expect(new Set(effective)).toEqual(new Set([helper]));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  describe("per-repository commit identity", () => {
    const appRemote = "https://github.com/acme/app-repo.git";
    const personalRemote = "https://github.com/octocat/personal-repo";
    const botIdentity = {
      name: "opengeni[bot]",
      email: "42+opengeni[bot]@users.noreply.github.com",
    };
    const personalIdentity = { name: "octocat", email: "1+octocat@users.noreply.github.com" };
    const resources = [
      {
        kind: "repository" as const,
        uri: appRemote,
        ref: "main",
        mountPath: "repos/acme/app-repo",
        githubInstallationId: 42,
        githubRepositoryId: 43,
      },
      {
        kind: "repository" as const,
        uri: personalRemote,
        ref: "main",
        mountPath: "repos/octocat/personal-repo",
        provider: "github" as const,
        connectionType: "github_personal" as const,
        credentialBindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        repositoryId: "77",
        access: "write" as const,
      },
    ];
    const bindings = [
      {
        credentialBindingId: "github-installation:42",
        provider: "github" as const,
        token: "app-token",
        identity: botIdentity,
      },
      {
        credentialBindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        provider: "github" as const,
        token: "personal-token",
        identity: personalIdentity,
      },
    ];

    /** A sandbox-shaped session whose PATH puts the per-turn wrapper dir first,
     *  exactly like the provisioned manifest PATH. */
    function identitySession(
      root: string,
      home: string,
      bakedIdentity: Record<string, string> = {},
    ) {
      const origin = existsSync(join(root, "origin")) ? join(root, "origin") : makeOrigin(root);
      const workspace = join(root, "workspace");
      mkdirSync(workspace, { recursive: true });
      const session = hostShellSession(home, {
        cwd: workspace,
        env: {
          PATH: `${join(home, ".opengeni", "bin")}:${process.env.PATH}`,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`,
          GIT_CONFIG_VALUE_0: appRemote,
          GIT_CONFIG_KEY_1: `url.file://${origin}.insteadOf`,
          GIT_CONFIG_VALUE_1: personalRemote,
          ...bakedIdentity,
        },
        rewriteCommand: (cmd) => cmd.replaceAll("'/workspace/", `'${workspace}/`),
      });
      const run = async (cmd: string) => {
        const result = await session.exec({ cmd });
        if (result.exitCode !== 0) {
          throw new Error(`command failed (${result.exitCode}): ${cmd}\n${result.output}`);
        }
        return result.stdout.trim();
      };
      const commitAs = async (relativeRepo: string, extra = "") =>
        await run(
          `${extra} git -C '${join(workspace, relativeRepo)}' commit --allow-empty -q -m change && git -C '${join(workspace, relativeRepo)}' log -1 --format='%an <%ae>|%cn <%ce>'`,
        );
      return { session, workspace, run, commitAs };
    }

    const formatted = (identity: { name: string; email: string }) =>
      `${identity.name} <${identity.email}>|${identity.name} <${identity.email}>`;

    test("mixed App and personal repositories in one box each commit as their own identity", async () => {
      const root = mkdtempSync(join(tmpdir(), "opengeni-identity-new-box-"));
      try {
        const home = join(root, "home");
        const { session, workspace, run, commitAs } = identitySession(root, home);
        await runRepositoryCloneHook(session as never, resources, {
          environment: {},
          gitCredentialBindings: bindings,
        });
        expect(await commitAs("repos/acme/app-repo")).toBe(formatted(botIdentity));
        expect(await commitAs("repos/octocat/personal-repo")).toBe(formatted(personalIdentity));
        // A repository the agent creates itself uses the box-wide default: the
        // App identity when an App repository is attached.
        await run(`git init -q '${join(workspace, "scratch")}'`);
        expect(await commitAs("scratch")).toBe(formatted(botIdentity));
        // The marker is local, never global.
        expect(
          await run(
            `git -C '${join(workspace, "repos/octocat/personal-repo")}' config --local --get opengeni.managedidentity`,
          ),
        ).toBe("true");

        // An identity someone set on purpose is never overwritten by later turns.
        await run(
          `git -C '${join(workspace, "repos/acme/app-repo")}' config --local --unset opengeni.managedidentity && git -C '${join(workspace, "repos/acme/app-repo")}' config --local user.email custom@example.com`,
        );
        await runRepositoryCloneHook(session as never, resources, {
          environment: {},
          gitCredentialBindings: bindings,
        });
        expect(
          await run(
            `git -C '${join(workspace, "repos/acme/app-repo")}' config --local --get user.email`,
          ),
        ).toBe("custom@example.com");

        // A managed identity whose binding no longer carries one is cleared.
        await runRepositoryCloneHook(session as never, resources, {
          environment: {},
          gitCredentialBindings: bindings.map(({ identity: _identity, ...binding }) => binding),
        });
        expect(
          (
            await session.exec({
              cmd: `git -C '${join(workspace, "repos/octocat/personal-repo")}' config --local --get user.email`,
            })
          ).exitCode,
        ).toBe(1);
        // So is the box-wide default once no binding carries an identity.
        expect((await session.exec({ cmd: "git config --global --get user.email" })).exitCode).toBe(
          1,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("an identity changed inside a managed repository is kept on later turns", async () => {
      const root = mkdtempSync(join(tmpdir(), "opengeni-identity-user-edit-"));
      try {
        const home = join(root, "home");
        const { session, workspace, run, commitAs } = identitySession(root, home);
        await runRepositoryCloneHook(session as never, resources, {
          environment: {},
          gitCredentialBindings: bindings,
        });
        const personalRepo = join(workspace, "repos/octocat/personal-repo");
        // The agent changes the identity on the person's request, marker untouched.
        await run(`git -C '${personalRepo}' config user.email mine@corp.example`);
        await run("git config --global user.name 'Someone Else'");
        await runRepositoryCloneHook(session as never, resources, {
          environment: {},
          gitCredentialBindings: bindings,
        });
        expect(await commitAs("repos/octocat/personal-repo")).toBe(
          `${personalIdentity.name} <mine@corp.example>|${personalIdentity.name} <mine@corp.example>`,
        );
        // No global committer overrides an identity set in the repository.
        expect(
          (await session.exec({ cmd: "git config --global --get committer.email" })).exitCode,
        ).toBe(1);
        expect(await run("git config --global --get user.name")).toBe("Someone Else");
        // The repository is no longer managed, so a dropped binding identity
        // does not clear it either.
        await runRepositoryCloneHook(session as never, resources, {
          environment: {},
          gitCredentialBindings: bindings.map(({ identity: _identity, ...binding }) => binding),
        });
        expect(await run(`git -C '${personalRepo}' config --get user.email`)).toBe(
          "mine@corp.example",
        );
        expect(await run("git config --global --get user.name")).toBe("Someone Else");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("a box whose env carries a deployment identity commits personal repositories as the person", async () => {
      const root = mkdtempSync(join(tmpdir(), "opengeni-identity-deployment-box-"));
      try {
        const home = join(root, "home");
        const deployment = { name: "Deploy Bot", email: "deploy@example.com" };
        const releaseBot = { name: "Release Bot", email: "release@example.com" };
        const { session, commitAs } = identitySession(root, home, {
          GIT_AUTHOR_NAME: deployment.name,
          GIT_AUTHOR_EMAIL: deployment.email,
          GIT_COMMITTER_NAME: releaseBot.name,
          GIT_COMMITTER_EMAIL: releaseBot.email,
        });
        await runRepositoryCloneHook(session as never, resources, {
          environment: {},
          gitCredentialBindings: bindings.map((binding) =>
            binding.credentialBindingId === "github-installation:42"
              ? { ...binding, identity: { ...deployment, committer: releaseBot } }
              : binding,
          ),
        });
        // A separately configured committer survives on App repositories.
        expect(await commitAs("repos/acme/app-repo")).toBe(
          `${deployment.name} <${deployment.email}>|${releaseBot.name} <${releaseBot.email}>`,
        );
        expect(await commitAs("repos/octocat/personal-repo")).toBe(formatted(personalIdentity));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("a box created with a baked GIT_AUTHOR env identity still commits as each repository's identity", async () => {
      const root = mkdtempSync(join(tmpdir(), "opengeni-identity-baked-box-"));
      try {
        const home = join(root, "home");
        const baked = {
          GIT_AUTHOR_NAME: botIdentity.name,
          GIT_AUTHOR_EMAIL: botIdentity.email,
          GIT_COMMITTER_NAME: botIdentity.name,
          GIT_COMMITTER_EMAIL: botIdentity.email,
        };
        const { session, workspace, run, commitAs } = identitySession(root, home, baked);
        await runRepositoryCloneHook(session as never, resources, {
          environment: {},
          gitCredentialBindings: bindings,
        });
        expect(await run("command -v git")).toBe(join(home, ".opengeni", "bin", "git"));
        expect(await commitAs("repos/octocat/personal-repo")).toBe(formatted(personalIdentity));
        expect(await commitAs("repos/acme/app-repo")).toBe(formatted(botIdentity));
        // From inside the repository (no -C) too.
        expect(
          await run(
            `cd '${join(workspace, "repos/octocat/personal-repo")}' && git commit --allow-empty -q -m inside && git log -1 --format='%ae|%ce'`,
          ),
        ).toBe(`${personalIdentity.email}|${personalIdentity.email}`);
        // An identity the command sets itself is respected.
        expect(
          await commitAs(
            "repos/octocat/personal-repo",
            "GIT_AUTHOR_NAME=Custom GIT_AUTHOR_EMAIL=custom@example.com",
          ),
        ).toBe(`Custom <custom@example.com>|${botIdentity.name} <${botIdentity.email}>`);
        // An unmanaged repository keeps the box's env identity.
        await run(`git init -q '${join(workspace, "scratch")}'`);
        expect(await commitAs("scratch")).toBe(formatted(botIdentity));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("the git wrapper never runs itself and fails clearly without a real git", async () => {
      const root = mkdtempSync(join(tmpdir(), "opengeni-identity-wrapper-loop-"));
      try {
        const home = join(root, "home");
        const { session, run } = identitySession(root, home);
        await runRepositoryCloneHook(session as never, resources, {
          environment: {},
          gitCredentialBindings: bindings,
        });
        const wrapperDir = join(home, ".opengeni", "bin");
        const linkDir = join(root, "link-bin");
        mkdirSync(linkDir, { recursive: true });
        childProcess.execFileSync("ln", ["-s", join(wrapperDir, "git"), join(linkDir, "git")]);
        expect(
          await run(`PATH='${wrapperDir}:${linkDir}:${wrapperDir}':"$PATH" git --version`),
        ).toContain("git version");
        const missing = await session.exec({
          cmd: `PATH='${wrapperDir}:${linkDir}' '${join(wrapperDir, "git")}' --version`,
        });
        expect(missing.exitCode).toBe(127);
        expect(missing.stderr).toContain("git: real command not found on PATH");

        // Another git shim that walks PATH skipping itself and execs the next
        // git reaches the real git in either PATH order.
        const shimDir = join(root, "shim-bin");
        mkdirSync(shimDir, { recursive: true });
        const shim = (mode: "exec" | "fork") =>
          [
            "#!/bin/sh",
            "IFS=:",
            "for dir in $PATH; do",
            '  [ -x "$dir/git" ] && ! [ "$dir/git" -ef "$0" ] && { unset IFS; ' +
              (mode === "exec" ? 'exec "$dir/git" "$@"; }' : '"$dir/git" "$@"; exit $?; }'),
            "done",
            "exit 127",
          ].join("\n");
        writeFileSync(join(shimDir, "git"), shim("exec"), { mode: 0o755 });
        for (const order of [`${wrapperDir}:${shimDir}`, `${shimDir}:${wrapperDir}`]) {
          const result = await session.exec({
            cmd: `PATH='${order}':"$PATH" timeout 10 git --version`,
          });
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("git version");
        }
        // A hook that runs git starts a new chain and still finds the real git.
        const hooked = join(root, "hooked");
        await run(`git init -q '${hooked}'`);
        writeFileSync(
          join(hooked, ".git", "hooks", "pre-commit"),
          "#!/bin/sh\nexec git rev-parse --git-dir >/dev/null\n",
          { mode: 0o755 },
        );
        const committed = await session.exec({
          cmd: `PATH='${wrapperDir}:${shimDir}':"$PATH" timeout 10 git -C '${hooked}' -c user.name=t -c user.email=t@example.com commit --allow-empty -q -m hooked`,
        });
        expect(committed.exitCode).toBe(0);
        // A shim that forks back into the wrapper stops instead of spinning.
        writeFileSync(join(shimDir, "git"), shim("fork"), { mode: 0o755 });
        const forked = await session.exec({
          cmd: `timeout 20 env PATH='${wrapperDir}:${shimDir}' '${join(wrapperDir, "git")}' --version`,
        });
        expect(forked.exitCode).toBe(125);
        expect(forked.stderr).toContain("git wrapper loop");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
