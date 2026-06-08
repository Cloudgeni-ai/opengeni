import { describe, expect, test } from "bun:test";
import { withHostGitHubAppRepositoryAuth } from "./github-host-git";

describe("host GitHub App repository auth", () => {
  test("scopes Git extraheader auth to SDK repository materialization and restores process env", async () => {
    const original = snapshot();
    delete process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_KEY_0;
    delete process.env.GIT_CONFIG_VALUE_0;
    delete process.env.GIT_TERMINAL_PROMPT;

    try {
      const seen: string[] = [];
      let firstStarted!: () => void;
      let releaseFirst!: () => void;
      const firstStartedPromise = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      const releaseFirstPromise = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const first = withHostGitHubAppRepositoryAuth(gitAuthEnvironment("first"), async () => {
        seen.push(process.env.GIT_CONFIG_VALUE_0 ?? "");
        firstStarted();
        await releaseFirstPromise;
        seen.push(process.env.GIT_CONFIG_VALUE_0 ?? "");
        return "first";
      });
      await firstStartedPromise;

      const second = withHostGitHubAppRepositoryAuth(gitAuthEnvironment("second"), async () => {
        seen.push(process.env.GIT_CONFIG_VALUE_0 ?? "");
        return "second";
      });

      expect(envValue("GIT_CONFIG_VALUE_0")).toBe("AUTHORIZATION: basic first");
      releaseFirst();
      await expect(first).resolves.toBe("first");
      await expect(second).resolves.toBe("second");

      expect(seen).toEqual([
        "AUTHORIZATION: basic first",
        "AUTHORIZATION: basic first",
        "AUTHORIZATION: basic second",
      ]);
      expect(envValue("GIT_CONFIG_COUNT")).toBeUndefined();
      expect(envValue("GIT_CONFIG_KEY_0")).toBeUndefined();
      expect(envValue("GIT_CONFIG_VALUE_0")).toBeUndefined();
      expect(envValue("GIT_TERMINAL_PROMPT")).toBeUndefined();
    } finally {
      restore(original);
    }
  });

  test("does not mutate process env when there is no GitHub App extraheader", async () => {
    const original = snapshot();
    process.env.GIT_CONFIG_VALUE_0 = "ambient";
    try {
      await withHostGitHubAppRepositoryAuth({}, async () => {
        expect(envValue("GIT_CONFIG_VALUE_0")).toBe("ambient");
      });
      expect(envValue("GIT_CONFIG_VALUE_0")).toBe("ambient");
    } finally {
      restore(original);
    }
  });
});

function gitAuthEnvironment(tokenLabel: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${tokenLabel}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

function snapshot(): Record<string, string | undefined> {
  return {
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT,
  };
}

function restore(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function envValue(key: string): string | undefined {
  return process.env[key];
}
