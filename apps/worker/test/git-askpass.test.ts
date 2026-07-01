// TOKEN-BROKER (B1): the askpass helper (docker/opengeni-git-askpass) now reads the
// git token from a FILE ($OPENGENI_GIT_TOKEN_FILE, default $HOME/.opengeni/git-token)
// rather than from the GITHUB_TOKEN/GH_TOKEN manifest env vars. This lets the agent
// refresh the token mid-turn (github_token MCP tool -> write the file) without any
// manifest-env change (validateNoEnvironmentDelta stays happy). Baked into the sandbox
// + desktop images by CONTENT (sandbox.Dockerfile / desktop.Dockerfile), so this test
// exercises the shipped script directly with /bin/sh.

import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SCRIPT = join(import.meta.dir, "..", "..", "..", "docker", "opengeni-git-askpass");

async function askpass(prompt: string, env: Record<string, string>): Promise<string> {
  const { stdout } = await exec("/bin/sh", [SCRIPT, prompt], { env: { ...process.env, ...env } });
  return stdout;
}

describe("opengeni-git-askpass reads the token FILE (B1)", () => {
  test("Password prompt -> the file contents at $OPENGENI_GIT_TOKEN_FILE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "askpass-"));
    try {
      const tokenFile = join(dir, "git-token");
      writeFileSync(tokenFile, "ghs_fileToken999");
      const out = await askpass("Password for 'https://github.com':", {
        OPENGENI_GIT_TOKEN_FILE: tokenFile,
      });
      expect(out.trim()).toBe("ghs_fileToken999");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Password prompt -> the $HOME/.opengeni/git-token fallback when no explicit file var", async () => {
    const home = mkdtempSync(join(tmpdir(), "askpass-home-"));
    try {
      mkdirSync(join(home, ".opengeni"), { recursive: true });
      writeFileSync(join(home, ".opengeni", "git-token"), "ghs_homeToken777");
      const out = await askpass("Password:", { HOME: home, OPENGENI_GIT_TOKEN_FILE: "" });
      expect(out.trim()).toBe("ghs_homeToken777");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Password prompt with NO token file -> a blank line (never crashes the fetch)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "askpass-empty-"));
    try {
      const out = await askpass("Password:", {
        OPENGENI_GIT_TOKEN_FILE: join(dir, "does-not-exist"),
      });
      // `cat ... || printf '\n'` -> an empty/blank line, exit 0 (no error).
      expect(out).toBe("\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Username prompt still answers x-access-token", async () => {
    const out = await askpass("Username for 'https://github.com':", {});
    expect(out.trim()).toBe("x-access-token");
  });
});
