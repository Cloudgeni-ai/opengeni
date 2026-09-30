import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResourceRef } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import {
  buildManifest,
  materializeRunCredentials,
  normalizeRunCredentialsResolution,
  repositoryHasExplicitGitConnection,
  repositoryUsesSandboxClone,
  runCredentialRoot,
  runRepositoryCloneHook,
  withRunCredentialsSession,
} from "@opengeni/runtime";
import { hostShellSession } from "../../../packages/runtime/test/isolated-git-home-fixture";
import { toRunCredentialsResolution } from "../src/activities/workspace-credential-provider";

type Repository = Extract<ResourceRef, { kind: "repository" }>;
const scope = { accountId: "account", workspaceId: "workspace", sessionId: crypto.randomUUID() };
const repository: Repository = {
  kind: "repository",
  uri: "https://github.com/acme/infra",
  ref: "main",
  mountPath: "repos/github/acme/infra",
};

describe("provider credentials for repository resource clones", () => {
  test("all unbound managed repositories wait for the clone hook; explicit selections stay explicit", () => {
    for (const sandboxBackend of ["docker", "local", "modal", "vercel"] as const) {
      expect(repositoryUsesSandboxClone(testSettings({ sandboxBackend }), repository)).toBe(true);
    }
    for (const selection of [
      { connectionId: "connection" },
      { credentialBindingId: "binding" },
      { connectionType: "github_app" as const },
      { githubInstallationId: 123 },
    ]) {
      expect(repositoryHasExplicitGitConnection({ ...repository, ...selection })).toBe(true);
    }
    expect(repositoryHasExplicitGitConnection(repository)).toBe(false);
    expect(repositoryUsesSandboxClone(testSettings(), repository, "selfhosted")).toBe(false);
    const manifest = buildManifest(testSettings({ sandboxBackend: "docker" }), [repository]);
    expect(JSON.stringify(manifest)).not.toContain('"repo":');
  });

  test("exact-host helper, explicit precedence, renewal and anonymous fallback never leak secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "og-provider-clone-"));
    const commands: string[] = [];
    const events: unknown[] = [];
    try {
      const bin = join(root, "fake-bin");
      await mkdir(bin);
      // Exercise Git's real credential machinery, but never contact a network.
      // The fake fetch persists only the outcome, not the supplied credential.
      await writeFile(
        join(bin, "git"),
        [
          "#!/usr/bin/env sh",
          "set -eu",
          "prefix=",
          'while [ "${1:-}" = -c ]; do',
          "  prefix=\"$prefix -c '$2'\"",
          "  shift 2",
          "done",
          'if [ "${1:-}" = -C ] && [ "${3:-}" = fetch ]; then',
          '  target="$2"',
          '  uri=$(/usr/bin/git -C "$target" remote get-url origin)',
          '  host="${uri#https://}"; host="${host%%/*}"',
          '  expected="${EXPECTED_PASSWORD:-}"',
          '  credential=$(printf "protocol=https\\nhost=%s\\n\\n" "$host" | eval "/usr/bin/git $prefix credential fill" 2>/dev/null || :)',
          '  if [ -n "$expected" ]; then',
          '    printf "%s\\n" "$credential" | grep -Fx "password=$expected" >/dev/null || { echo "credential mismatch" >&2; exit 1; }',
          '  elif printf "%s\\n" "$credential" | grep "^password=." >/dev/null; then',
          '    echo "unexpected credential on anonymous clone" >&2; exit 1',
          "  fi",
          '  /usr/bin/git -C "$target" -c user.name=fixture -c user.email=fixture@example.test commit --allow-empty -m fixture >/dev/null',
          '  /usr/bin/git -C "$target" rev-parse HEAD > "$target/.git/FETCH_HEAD"',
          "  exit 0",
          "fi",
          'eval "exec /usr/bin/git $prefix \\"\\$@\\""',
        ].join("\n"),
        { mode: 0o755 },
      );
      await writeFile(
        join(bin, "gh"),
        ["#!/usr/bin/env sh", '[ "${GH_TOKEN:-}" = "$EXPECTED_PASSWORD" ]'].join("\n"),
        { mode: 0o755 },
      );
      for (const [tool, variable] of [
        ["glab", "GITLAB_TOKEN"],
        ["az", "AZURE_DEVOPS_EXT_PAT"],
      ]) {
        await writeFile(
          join(bin, tool!),
          ["#!/usr/bin/env sh", `[ "\${${variable}:-}" = "$EXPECTED_PASSWORD" ]`].join("\n"),
          { mode: 0o755 },
        );
      }
      const raw = hostShellSession(root, {
        env: { PATH: `${bin}:${process.env.PATH}`, GIT_ASKPASS: join(root, "askpass") },
        rewriteCommand: (cmd) => {
          commands.push(cmd);
          return cmd
            .replaceAll("/workspace", root)
            .replaceAll("/etc/profile.d", join(root, "profile.d"));
        },
      });
      async function provision(password: string, host = "GITHUB.COM") {
        const material = normalizeRunCredentialsResolution(
          toRunCredentialsResolution({ status: "ok", git: [{ host, password }] }, scope),
          scope,
        )!;
        await materializeRunCredentials(raw, material, {
          sessionId: scope.sessionId,
          attemptId: "attempt",
          executionGeneration: 1,
        });
      }
      async function clone(resource: Repository, password: string) {
        const session = withRunCredentialsSession(
          hostShellSession(root, {
            env: {
              PATH: `${bin}:${process.env.PATH}`,
              GIT_ASKPASS: join(root, "askpass"),
              EXPECTED_PASSWORD: password,
            },
            rewriteCommand: (cmd) => {
              commands.push(cmd);
              return cmd
                .replaceAll("/workspace", root)
                .replaceAll("/etc/profile.d", join(root, "profile.d"));
            },
          }),
          scope.sessionId,
        );
        await runRepositoryCloneHook(session as never, [resource], {
          environment: {},
          onRuntimeEvent: async (event) => {
            events.push(event);
          },
        });
      }
      await provision("provider-secret-one");
      await clone(repository, "provider-secret-one");
      const config = await readFile(join(root, repository.mountPath!, ".git/config"), "utf8");
      expect(config).toContain(repository.uri);
      expect(config).not.toContain("provider-secret");
      expect(config).not.toContain("credential.helper");

      await provision("provider-secret-two");
      await clone({ ...repository, mountPath: "repos/renewed" }, "provider-secret-two");
      const cli = withRunCredentialsSession(
        hostShellSession(root, {
          cwd: join(root, "repos/renewed"),
          env: {
            PATH: `${join(root, ".opengeni/bin")}:${bin}:${process.env.PATH}`,
            EXPECTED_PASSWORD: "provider-secret-two",
          },
        }),
        scope.sessionId,
      );
      expect((await cli.exec({ cmd: "gh pr create" })).exitCode).toBe(0);
      await clone(
        { ...repository, uri: "https://github.com.evil.test/acme/infra", mountPath: "repos/other" },
        "",
      );
      await clone(
        { ...repository, mountPath: "repos/explicit", connectionId: "explicit-connection" },
        "",
      );
      for (const [host, provider, tool, password] of [
        ["gitlab.example.test:8443", "gitlab", "glab", "glpat-renewed-token"],
        ["dev.azure.com", "azure_devops", "az", "azure-renewed-token"],
      ] as const) {
        await provision(password, host);
        const mountPath = `repos/${provider}`;
        await clone(
          {
            ...repository,
            uri: `https://${host}/acme/infra`,
            provider,
            mountPath,
            optional: true,
          },
          password,
        );
        const providerCli = withRunCredentialsSession(
          hostShellSession(root, {
            cwd: join(root, mountPath),
            env: {
              PATH: `${join(root, ".opengeni/bin")}:${bin}:${process.env.PATH}`,
              EXPECTED_PASSWORD: password,
            },
          }),
          scope.sessionId,
        );
        expect((await providerCli.exec({ cmd: `${tool} --version` })).exitCode).toBe(0);
      }
      const noProvider = hostShellSession(root, {
        env: { PATH: `${bin}:${process.env.PATH}`, GIT_ASKPASS: join(root, "askpass") },
        rewriteCommand: (cmd) =>
          cmd.replaceAll("/workspace", root).replaceAll("/etc/profile.d", join(root, "profile.d")),
      });
      await runRepositoryCloneHook(noProvider as never, [
        { ...repository, mountPath: "repos/anonymous" },
      ]);
      expect(JSON.stringify(events)).not.toContain("provider-secret");
      // Material delivery contains base64 bytes by design; the clone command
      // and lifecycle events never contain a literal provider credential.
      expect(commands.join("\n")).not.toContain("provider-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(runCredentialRoot(scope.sessionId), { recursive: true, force: true });
    }
  }, 30_000);
});
