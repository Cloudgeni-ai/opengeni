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
  gitCredentialBindingHash,
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
      const realGit = Bun.which("git");
      if (!realGit) throw new Error("Git is required for the provider clone fixture");
      const bin = join(root, "fake-bin");
      await mkdir(bin);
      const realChmod = Bun.which("chmod");
      if (!realChmod) throw new Error("chmod is required for the provider clone fixture");
      // Enforce BSD option parsing even on Linux, where GNU chmod accepts the
      // old mode-before-"--" spelling. Never put token data in diagnostics.
      await writeFile(
        join(bin, "chmod"),
        [
          "#!/usr/bin/env sh",
          'if [ "${2:-}" = -- ]; then exit 64; fi',
          'exec "$OPENGENI_FIXTURE_CHMOD" "$@"',
        ].join("\n"),
        { mode: 0o755 },
      );
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
          '  uri=$("$OPENGENI_FIXTURE_GIT" -C "$target" remote get-url origin)',
          '  host="${uri#https://}"; host="${host%%/*}"',
          '  path="${uri#https://*/}"',
          '  expected="${EXPECTED_PASSWORD:-}"',
          '  credential=$(printf "protocol=https\\nhost=%s\\npath=%s\\n\\n" "$host" "$path" | eval \'"$OPENGENI_FIXTURE_GIT" \' "$prefix credential fill" 2>/dev/null || :)',
          '  if [ -n "$expected" ]; then',
          '    printf "%s\\n" "$credential" | grep -Fx "password=$expected" >/dev/null || { echo "credential mismatch" >&2; exit 1; }',
          '  elif printf "%s\\n" "$credential" | grep "^password=." >/dev/null; then',
          '    echo "unexpected credential on anonymous clone" >&2; exit 1',
          "  fi",
          '  "$OPENGENI_FIXTURE_GIT" -C "$target" -c user.name=fixture -c user.email=fixture@example.test commit --allow-empty -m fixture >/dev/null',
          '  "$OPENGENI_FIXTURE_GIT" -C "$target" rev-parse HEAD > "$target/.git/FETCH_HEAD"',
          "  exit 0",
          "fi",
          'eval \'exec "$OPENGENI_FIXTURE_GIT" \' "$prefix" \'"$@"\'',
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
        shell: "bash",
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          GIT_ASKPASS: join(root, "askpass"),
          OPENGENI_FIXTURE_GIT: realGit,
          OPENGENI_FIXTURE_CHMOD: realChmod,
        },
        rewriteCommand: (cmd) => {
          commands.push(cmd);
          // FileEnvironment is encoded in the staged env file, so keep its
          // real production root. The unique session id isolates that tree.
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
            shell: "bash",
            env: {
              PATH: `${bin}:${process.env.PATH}`,
              GIT_ASKPASS: join(root, "askpass"),
              EXPECTED_PASSWORD: password,
              OPENGENI_FIXTURE_GIT: realGit,
              OPENGENI_FIXTURE_CHMOD: realChmod,
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
          shell: "bash",
          cwd: join(root, "repos/renewed"),
          env: {
            PATH: `${join(root, ".opengeni/bin")}:${bin}:${process.env.PATH}`,
            EXPECTED_PASSWORD: "provider-secret-two",
            OPENGENI_FIXTURE_GIT: realGit,
            OPENGENI_FIXTURE_CHMOD: realChmod,
          },
        }),
        scope.sessionId,
      );
      expect((await cli.exec({ cmd: "gh pr create" })).exitCode).toBe(0);
      // A prior platform turn may leave a token behind. Subsequent Git pushes
      // must still select the renewed product store for this unbound remote.
      await writeFile(
        join(root, ".opengeni/git-credentials", `${gitCredentialBindingHash("github")}-token`),
        "stale-platform-token",
      );
      const selected = await cli.exec({
        cmd: "printf 'protocol=https\\nhost=github.com\\npath=acme/infra\\n\\n' | \"$OPENGENI_FIXTURE_GIT\" credential fill",
      });
      expect(selected.exitCode).toBe(0);
      expect(selected.stdout).toContain("password=provider-secret-two");
      expect(selected.stdout).not.toContain("stale-platform-token");
      await clone(
        { ...repository, uri: "https://github.com.evil.test/acme/infra", mountPath: "repos/other" },
        "",
      );
      await clone(
        {
          ...repository,
          mountPath: "repos/explicit",
          connectionId: "explicit-connection",
          credentialBindingId: "explicit-connection",
          provider: "github",
        },
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
            shell: "bash",
            cwd: join(root, mountPath),
            env: {
              PATH: `${join(root, ".opengeni/bin")}:${bin}:${process.env.PATH}`,
              EXPECTED_PASSWORD: password,
              OPENGENI_FIXTURE_GIT: realGit,
              OPENGENI_FIXTURE_CHMOD: realChmod,
            },
          }),
          scope.sessionId,
        );
        expect((await providerCli.exec({ cmd: `${tool} --version` })).exitCode).toBe(0);
      }
      // The authenticated provider's public files/environment seam is used by
      // hosts with more than one installation on the same Git hostname.
      async function provisionPaths(firstPassword: string, includeHostStore = false) {
        const material = normalizeRunCredentialsResolution(
          toRunCredentialsResolution(
            {
              status: "ok",
              ...(includeHostStore
                ? { git: [{ host: "gitlab.example.test", password: "host-store-fixture" }] }
                : {}),
              files: [
                {
                  path: "git/path-helper.sh",
                  mode: "0400",
                  content: [
                    "#!/bin/sh",
                    'test "$1" = get || exit 0',
                    "protocol= host= path=",
                    'while IFS="=" read -r key value; do',
                    '  case "$key" in protocol) protocol=$value ;; host) host=$value ;; path) path=$value ;; esac',
                    "done",
                    'test "$protocol" = https || exit 0',
                    'case "$host/$path" in',
                    `github.com/acme/infra) printf "username=fixture\\npassword=${firstPassword}\\n" ;;`,
                    'github.com/other/private) printf "username=fixture\\npassword=second-installation\\n" ;;',
                    "esac",
                  ].join("\n"),
                },
              ],
              fileEnvironment: { HOST_PATH_GIT_HELPER: "git/path-helper.sh" },
              environment: {
                GIT_CONFIG_COUNT: "3",
                GIT_CONFIG_KEY_0: "credential.helper",
                GIT_CONFIG_VALUE_0: "",
                GIT_CONFIG_KEY_1: "credential.useHttpPath",
                GIT_CONFIG_VALUE_1: "true",
                GIT_CONFIG_KEY_2: "Credential.Helper",
                GIT_CONFIG_VALUE_2: '!sh "$HOST_PATH_GIT_HELPER"',
              },
            },
            scope,
          ),
          scope,
        )!;
        await materializeRunCredentials(raw, material, {
          sessionId: scope.sessionId,
          attemptId: "attempt",
          executionGeneration: 1,
        });
      }
      await provisionPaths("first-installation");
      await clone({ ...repository, mountPath: "repos/path-first" }, "first-installation");
      await clone(
        { ...repository, uri: "https://github.com/other/private", mountPath: "repos/path-second" },
        "second-installation",
      );
      await clone(
        { ...repository, uri: "https://github.com/other/unselected", mountPath: "repos/path-miss" },
        "",
      );
      await clone(
        {
          ...repository,
          uri: "https://github.com.evil.test/acme/infra",
          mountPath: "repos/path-host-miss",
        },
        "",
      );
      await clone(
        {
          ...repository,
          connectionId: "explicit-connection",
          credentialBindingId: "explicit-connection",
          provider: "github",
          mountPath: "repos/path-explicit",
        },
        "",
      );
      await provisionPaths("renewed-installation");
      await clone({ ...repository, mountPath: "repos/path-renewed" }, "renewed-installation");
      await provisionPaths("mixed-installation", true);
      await clone({ ...repository, mountPath: "repos/path-with-host-store" }, "mixed-installation");
      await clone(
        {
          ...repository,
          uri: "https://gitlab.example.test/acme/infra",
          provider: "gitlab",
          mountPath: "repos/host-with-path-helper",
        },
        "host-store-fixture",
      );
      const noProvider = hostShellSession(root, {
        shell: "bash",
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          GIT_ASKPASS: join(root, "askpass"),
          OPENGENI_FIXTURE_GIT: realGit,
          OPENGENI_FIXTURE_CHMOD: realChmod,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_VALUE_0: '!printf "username=ambient\\npassword=must-not-leak\\n"',
        },
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
