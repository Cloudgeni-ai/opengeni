import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import type { SandboxSessionLike, SandboxSessionState } from "@openai/agents/sandbox";
import { testSettings } from "@opengeni/testing";

import { createSandboxClient } from "../src/sandbox";
import { discoverWorkspaceSkills } from "../src/workspace-skills";

const liveGate = process.env.OPENGENI_LIVE_MODAL_WORKSPACE_SKILLS === "1" && hasModalCredentials();
const searchPaths = [{ path: ".agents/skills", source: ".agents/skills" }];

function hasModalCredentials(): boolean {
  if (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) return true;
  const path = join(homedir(), ".modal.toml");
  if (!existsSync(path)) return false;
  try {
    const wantedProfile = process.env.MODAL_PROFILE;
    return readFileSync(path, "utf8")
      .split(/\n(?=\[)/)
      .some((section) => {
        const name = /^\[([^\]]+)\]/.exec(section.trimStart())?.[1];
        if (!name || !/\btoken_id\s*=/.test(section)) return false;
        return wantedProfile ? name === wantedProfile : /\bactive\s*=\s*true\b/.test(section);
      });
  } catch {
    return false;
  }
}

async function exec(session: SandboxSessionLike, command: string): Promise<void> {
  if (!session.execCommand) throw new Error("Modal session exposes no execCommand seam");
  const output = await session.execCommand({
    cmd: command,
    yieldTimeMs: 60_000,
    maxOutputTokens: 2_000,
  });
  if (!output.includes("Process exited with code 0")) {
    throw new Error(`Modal setup command failed: ${output}`);
  }
}

async function waitForNativeRead(session: SandboxSessionLike, path: string): Promise<void> {
  if (!session.readFile) throw new Error("Modal session exposes no readFile seam");
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const content = await session.readFile({ path });
      const markdown = typeof content === "string" ? content : new TextDecoder().decode(content);
      if (markdown.includes("name: release")) return;
      lastError = new Error(`Modal readFile returned unexpected content: ${markdown}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`Modal readFile did not observe the skill fixture: ${String(lastError)}`);
}

describe("Modal workspace skill discovery (opt-in live service)", () => {
  test.skipIf(!liveGate)(
    "discovers no skills and a real skill across fresh and resumed sessions",
    async () => {
      const settings = testSettings({
        sandboxBackend: "modal",
        modalAppName:
          process.env.OPENGENI_MODAL_SMOKE_APP ?? "opengeni-workspace-skills-live-smoke",
        modalImageRef: process.env.OPENGENI_MODAL_SMOKE_IMAGE ?? "python:3.12-slim",
        modalWorkspacePersistence: "tar",
        modalTimeoutSeconds: 600,
        modalIdleTimeoutSeconds: 300,
      });
      const client = createSandboxClient(settings) as {
        create(): Promise<SandboxSessionLike>;
        resume(state: SandboxSessionState): Promise<SandboxSessionLike>;
        delete?(state: SandboxSessionState): Promise<void>;
      };
      let state: SandboxSessionState | null = null;
      try {
        const fresh = await client.create();
        state = fresh.state;
        await expect(discoverWorkspaceSkills(fresh, searchPaths)).resolves.toEqual([]);
        await exec(
          fresh,
          "mkdir -p /workspace/.agents/skills/release && printf '%s' '---\nname: release\ndescription: Prepare a safe release.\n---\n' > /workspace/.agents/skills/release/SKILL.md",
        );
        await waitForNativeRead(fresh, ".agents/skills/release/SKILL.md");
        await expect(discoverWorkspaceSkills(fresh, searchPaths)).resolves.toEqual([
          expect.objectContaining({
            name: "release",
            description: "Prepare a safe release.",
            path: ".agents/skills/release/SKILL.md",
          }),
        ]);

        const resumed = await client.resume(state);
        await expect(discoverWorkspaceSkills(resumed, searchPaths)).resolves.toEqual([
          expect.objectContaining({ name: "release" }),
        ]);
      } finally {
        if (state && client.delete) await client.delete(state);
      }
    },
    300_000,
  );

  test.skipIf(liveGate)("is visibly gated when live Modal credentials are not opted in", () => {
    expect(liveGate).toBe(false);
  });
});
