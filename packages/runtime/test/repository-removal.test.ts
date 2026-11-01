import { describe, expect, test } from "bun:test";
import type { ResourceRef } from "@opengeni/contracts";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitCredentialBindingHash, sandboxRepositoryRemovalHooks } from "../src";
import {
  repositoryRemovalCommand,
  repositoryRemovalPlan,
  repositoryRemovalPlanIsEmpty,
} from "../src/repository-removal";

type Repository = Extract<ResourceRef, { kind: "repository" }>;

const groceryBot: Repository = {
  kind: "repository",
  uri: "https://github.com/Cloudgeni-ai/grocery-bot.git",
  ref: "main",
  provider: "github",
  githubInstallationId: 71,
  githubRepositoryId: 72,
};
const docsSameInstallation: Repository = {
  kind: "repository",
  uri: "https://github.com/Cloudgeni-ai/docs.git",
  ref: "main",
  provider: "github",
  githubInstallationId: 71,
  githubRepositoryId: 73,
};
const otherInstallation: Repository = {
  kind: "repository",
  uri: "https://github.com/acme/site.git",
  ref: "main",
  provider: "github",
  githubInstallationId: 81,
  githubRepositoryId: 82,
};
const personal: Repository = {
  kind: "repository",
  uri: "https://github.com/bendik/notes",
  ref: "main",
  provider: "github",
  connectionType: "github_personal",
  credentialBindingId: "22222222-2222-4222-8222-222222222222",
  repositoryId: "91",
  access: "write",
};
const gitlab: Repository = {
  kind: "repository",
  uri: "https://gitlab.com/acme/api.git",
  ref: "main",
  provider: "gitlab",
  connectionId: "33333333-3333-4333-8333-333333333333",
};

/** Opengeni's own GitHub App minted the box's tokens. */
const OPENGENI_MINTED = { revokeDedicatedGitHubAppTokens: true };

describe("repositoryRemovalPlan", () => {
  test("removes the folder and a dedicated App binding, revoking its token", () => {
    const plan = repositoryRemovalPlan([groceryBot], [otherInstallation], OPENGENI_MINTED);
    expect(plan.folders).toEqual(["/workspace/repos/github.com/Cloudgeni-ai/grocery-bot"]);
    // Same file name the credential helper reads.
    expect(plan.bindingHashes).toEqual([gitCredentialBindingHash("github-installation:71")]);
    expect(plan.revocableBindingHashes).toEqual(plan.bindingHashes);
    // Another GitHub repository still uses the provider token.
    expect(plan.providers).toEqual([]);
  });

  test("never revokes a token a host credential callback supplied", () => {
    const plan = repositoryRemovalPlan([groceryBot], [otherInstallation]);
    expect(plan.bindingHashes).toEqual([gitCredentialBindingHash("github-installation:71")]);
    expect(plan.revocableBindingHashes).toEqual([]);
    expect(repositoryRemovalCommand(plan)).not.toMatch(/^revoke_github_app_token /m);
  });

  test("keeps a binding another attached repository shares", () => {
    const plan = repositoryRemovalPlan([groceryBot], [docsSameInstallation]);
    expect(plan.folders).toEqual(["/workspace/repos/github.com/Cloudgeni-ai/grocery-bot"]);
    expect(plan.bindingHashes).toEqual([]);
    expect(plan.revocableBindingHashes).toEqual([]);
  });

  test("removes provider tokens no attached repository uses", () => {
    const plan = repositoryRemovalPlan([groceryBot, gitlab], [], OPENGENI_MINTED);
    expect(plan.providers).toEqual(["github", "gitlab"]);
    expect(plan.bindingHashes).toEqual(
      [
        gitCredentialBindingHash("github-installation:71"),
        gitCredentialBindingHash(gitlab.connectionId!),
      ].sort(),
    );
    // Only a github.com App installation token is revoked.
    expect(plan.revocableBindingHashes).toEqual([
      gitCredentialBindingHash("github-installation:71"),
    ]);
  });

  test("never revokes a personal OAuth token", () => {
    const plan = repositoryRemovalPlan([personal], [otherInstallation], OPENGENI_MINTED);
    expect(plan.bindingHashes).toEqual([gitCredentialBindingHash(personal.credentialBindingId!)]);
    expect(plan.revocableBindingHashes).toEqual([]);
  });

  test("leaves a repository that is attached again, or by another session in the box", () => {
    const plan = repositoryRemovalPlan(
      [groceryBot],
      [{ ...groceryBot, uri: "https://github.com/cloudgeni-ai/Grocery-Bot" }],
    );
    expect(repositoryRemovalPlanIsEmpty(plan)).toBe(true);
  });

  test("keeps a folder another attached resource mounts at or inside", () => {
    const plan = repositoryRemovalPlan(
      [{ ...groceryBot, mountPath: "apps" }],
      [{ ...otherInstallation, mountPath: "apps/site" }],
    );
    expect(plan.folders).toEqual([]);
  });
});

describe("sandboxRepositoryRemovalHooks", () => {
  test("runs before the agent starts in a managed sandbox only", () => {
    const removal = { removed: [groceryBot], retained: [] };
    const hooks = sandboxRepositoryRemovalHooks([otherInstallation], removal, "docker");
    expect(hooks.map((hook) => [hook.id, hook.phase])).toEqual([
      ["repository-removal", "beforeAgentStart"],
    ]);
    expect(sandboxRepositoryRemovalHooks([otherInstallation], removal, "selfhosted")).toEqual([]);
    expect(sandboxRepositoryRemovalHooks([otherInstallation], undefined, "docker")).toEqual([]);
    // Another session sharing the box still attaches the repository.
    expect(
      sandboxRepositoryRemovalHooks(
        [otherInstallation],
        { removed: [groceryBot], retained: [groceryBot] },
        "docker",
      ),
    ).toEqual([]);
  });

  test("revokes a dedicated token only when Opengeni's own App minted it", async () => {
    const commandFor = async (revokeDedicatedGitHubAppTokens: boolean) => {
      const [hook] = sandboxRepositoryRemovalHooks(
        [otherInstallation],
        { removed: [groceryBot], retained: [], revokeDedicatedGitHubAppTokens },
        "docker",
      );
      const commands: string[] = [];
      await hook!.run(
        {
          exec: async (args: { cmd: string }) => {
            commands.push(args.cmd);
            return { exitCode: 0, output: "" };
          },
        } as never,
        {} as never,
      );
      return commands[0] ?? "";
    };
    expect(await commandFor(true)).toMatch(/^revoke_github_app_token /m);
    expect(await commandFor(false)).not.toMatch(/^revoke_github_app_token /m);
  });

  test("records the cleanup only after the sandbox command succeeds", async () => {
    for (const exitCode of [0, 1]) {
      let cleaned = 0;
      const commands: string[] = [];
      const events: string[] = [];
      const [hook] = sandboxRepositoryRemovalHooks(
        [otherInstallation],
        { removed: [groceryBot], retained: [], onCleaned: async () => void (cleaned += 1) },
        "docker",
      );
      const box = {
        exec: async (args: { cmd: string }) => {
          commands.push(args.cmd);
          return { exitCode, output: "" };
        },
      };
      // A failed cleanup never fails the turn: access is already refused.
      await hook!.run(
        box as never,
        {
          onRuntimeEvent: async (event: { type: string }) => void events.push(event.type),
        } as never,
      );
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain(
        "rm -rf -- '/workspace/repos/github.com/Cloudgeni-ai/grocery-bot'",
      );
      expect(cleaned).toBe(exitCode === 0 ? 1 : 0);
      expect(events).toEqual([
        "sandbox.operation.started",
        exitCode === 0 ? "sandbox.operation.completed" : "sandbox.operation.failed",
      ]);
    }
  });
});

describe("repositoryRemovalCommand", () => {
  test("deletes the folder and binding, revoking the token outside argv", () => {
    // A hand-built plan rooted in a temporary directory: the real plan only
    // names folders under the sandbox's /workspace.
    const root = mkdtempSync(join(tmpdir(), "opengeni-repository-removal-"));
    try {
      const folder = join(root, "github.com", "Cloudgeni-ai", "grocery-bot");
      mkdirSync(join(folder, ".git"), { recursive: true });
      writeFileSync(join(folder, "notes.txt"), "work");
      const kept = join(root, "github.com", "acme", "site");
      mkdirSync(kept, { recursive: true });
      const credentialDir = join(root, ".opengeni", "git-credentials");
      mkdirSync(credentialDir, { recursive: true });
      const removedHash = gitCredentialBindingHash("github-installation:71");
      const keptHash = gitCredentialBindingHash("github-installation:81");
      writeFileSync(join(credentialDir, `${removedHash}-token`), "ghs_removed_token");
      writeFileSync(join(credentialDir, `${keptHash}-token`), "ghs_kept_token");
      writeFileSync(join(credentialDir, "gitlab-token"), "glpat");
      const bin = join(root, "bin");
      mkdirSync(bin);
      const log = join(root, "curl.log");
      writeFileSync(
        join(bin, "curl"),
        [
          "#!/bin/sh",
          `printf 'argv:%s\\n' "$*" >> '${log}'`,
          'for arg in "$@"; do case "$arg" in @*) cat "${arg#@}" >> ' +
            `'${log}'` +
            " ;; esac; done",
          "exit 0",
        ].join("\n"),
      );
      chmodSync(join(bin, "curl"), 0o755);

      const command = repositoryRemovalCommand({
        folders: [folder],
        bindingHashes: [removedHash],
        revocableBindingHashes: [removedHash],
        providers: ["gitlab"],
      });
      execFileSync("bash", ["-c", command], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: root,
          OPENGENI_GIT_CREDENTIALS_DIR: credentialDir,
        },
      });

      expect(existsSync(folder)).toBe(false);
      expect(existsSync(kept)).toBe(true);
      expect(existsSync(join(credentialDir, `${removedHash}-token`))).toBe(false);
      expect(readFileSync(join(credentialDir, `${keptHash}-token`), "utf8")).toBe("ghs_kept_token");
      expect(existsSync(join(credentialDir, "gitlab-token"))).toBe(false);
      const calls = readFileSync(log, "utf8");
      expect(calls).toContain("-X DELETE");
      expect(calls).toContain("https://api.github.com/installation/token");
      expect(calls).toContain("Authorization: Bearer ghs_removed_token");
      // The token reached curl only through the header file.
      const argvLines = calls.split("\n").filter((line) => line.startsWith("argv:"));
      expect(argvLines.join("\n")).not.toContain("ghs_removed_token");

      // Running it again (every turn until re-attached) is harmless.
      execFileSync("bash", ["-c", command], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: root,
          OPENGENI_GIT_CREDENTIALS_DIR: credentialDir,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
