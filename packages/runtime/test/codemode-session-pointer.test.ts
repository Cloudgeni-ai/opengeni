import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildTerminalServerScript,
  refreshCodemodeTokenFile,
  runCodemodeTokenSeedHook,
  codemodeTokenFileFromEnvironment,
  codemodeTokenFileForSession,
  withCodemodeTokenClient,
  withCodemodeTokenSession,
} from "../src/index";

function shellSession(home: string) {
  return {
    exec: async (args: { cmd: string }) => {
      const proc = Bun.spawn(["sh", "-lc", args.cmd], {
        cwd: home,
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stdout, stderr };
    },
  };
}

describe("session-specific Codemode token pointers", () => {
  test("the sandbox-group-global ttyd process cannot inherit a session bearer pointer", () => {
    expect(buildTerminalServerScript({ port: 7681 })).toContain(
      "OPENGENI_CODEMODE_TOKEN_FILE=/dev/null",
    );
  });

  test("derives deterministic opaque siblings beside the stable manifest pointer", () => {
    const manifestFile = "/workspace/.opengeni/codemode-token";
    const first = codemodeTokenFileForSession(manifestFile, "session-a");
    const again = codemodeTokenFileForSession(manifestFile, "session-a");
    const second = codemodeTokenFileForSession(manifestFile, "session-b");

    expect(first).toBe(again);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^\/workspace\/\.opengeni\/codemode-tokens\/[a-f0-9]{64}$/);
    expect(first).not.toContain("session-a");
    expect(() => codemodeTokenFileForSession("relative/token", "session-a")).toThrow(
      "must be absolute",
    );
    expect(() => codemodeTokenFileForSession(manifestFile, " session-a")).toThrow(
      "session id is invalid",
    );
    expect(codemodeTokenFileFromEnvironment({ HOME: "/home/user" }, "session-a")).toBe(
      codemodeTokenFileForSession("/home/user/.opengeni/codemode-token", "session-a"),
    );
    expect(codemodeTokenFileFromEnvironment({}, "session-a")).toBe(
      codemodeTokenFileForSession("/workspace/.opengeni/codemode-token", "session-a"),
    );
  });

  test("decorates client create/resume sessions and preserves lifecycle methods", async () => {
    const tokenFile = "/workspace/.opengeni/codemode-tokens/" + "a".repeat(64);
    const commands: string[] = [];
    const rawSession = {
      exec: async (args: { cmd: string }) => {
        commands.push(args.cmd);
        return { exitCode: 0 };
      },
      execCommand: async (args: { cmd: string }) => {
        commands.push(args.cmd);
        return "ok";
      },
    };
    const lifecycle: string[] = [];
    const rawClient = {
      backendId: "test",
      supportsDefaultOptions: true,
      create: async () => rawSession,
      resume: async () => rawSession,
      delete: async () => {
        lifecycle.push("delete");
      },
      serializeSessionState: async () => {
        lifecycle.push("serialize");
        return { serialized: true };
      },
      canPersistOwnedSessionState: async () => {
        lifecycle.push("persist");
        return true;
      },
      canReusePreservedOwnedSession: async () => {
        lifecycle.push("reuse");
        return true;
      },
      deserializeSessionState: async () => {
        lifecycle.push("deserialize");
        return { restored: true };
      },
    };
    const client = withCodemodeTokenClient(rawClient as never, tokenFile) as any;
    const created = await client.create({});
    const resumed = await client.resume({});

    expect(created).toBe(resumed);
    await created.exec({ cmd: "echo exec" });
    await created.execCommand({ cmd: "echo exec-command" });
    expect(commands).toEqual([
      `export OPENGENI_CODEMODE_TOKEN_FILE='${tokenFile}'\necho exec`,
      `export OPENGENI_CODEMODE_TOKEN_FILE='${tokenFile}'\necho exec-command`,
    ]);
    await client.delete({});
    await client.serializeSessionState({}, {});
    await client.canPersistOwnedSessionState({});
    await client.canReusePreservedOwnedSession({});
    await client.deserializeSessionState({});
    expect(lifecycle).toEqual(["delete", "serialize", "persist", "reuse", "deserialize"]);
  });

  test("seeds and renews two session files independently while removing the legacy bearer", async () => {
    const home = mkdtempSync(join(tmpdir(), "opengeni-codemode-sessions-"));
    try {
      const tokenDir = join(home, ".opengeni");
      const manifestFile = join(tokenDir, "codemode-token");
      const firstFile = codemodeTokenFileForSession(manifestFile, "session-a");
      const secondFile = codemodeTokenFileForSession(manifestFile, "session-b");
      const session = shellSession(home);
      mkdirSync(tokenDir, { recursive: true });
      writeFileSync(manifestFile, "ogd_legacy", { mode: 0o600 });

      await runCodemodeTokenSeedHook(session as never, {
        environment: { HOME: home, OPENGENI_CODEMODE_TOKEN_FILE: manifestFile },
        codemodeTokenSeed: "ogd_first",
        codemodeTokenFile: firstFile,
      });
      expect(readFileSync(firstFile, "utf8")).toBe("ogd_first");
      expect(existsSync(manifestFile)).toBe(false);

      await runCodemodeTokenSeedHook(session as never, {
        environment: { HOME: home, OPENGENI_CODEMODE_TOKEN_FILE: manifestFile },
        codemodeTokenSeed: "ogd_second",
        codemodeTokenFile: secondFile,
      });
      expect(readFileSync(firstFile, "utf8")).toBe("ogd_first");
      expect(readFileSync(secondFile, "utf8")).toBe("ogd_second");

      await refreshCodemodeTokenFile(session as never, "ogd_first_renewed", {
        tokenFile: firstFile,
        legacyTokenFile: manifestFile,
      });
      expect(readFileSync(firstFile, "utf8")).toBe("ogd_first_renewed");
      expect(readFileSync(secondFile, "utf8")).toBe("ogd_second");
      expect(statSync(firstFile).mode & 0o777).toBe(0o600);
      expect(statSync(secondFile).mode & 0o777).toBe(0o600);
      expect(readdirSync(tokenDir).sort()).toEqual(["codemode-tokens"]);

      const firstSession = withCodemodeTokenSession(session, firstFile);
      const secondSession = withCodemodeTokenSession(session, secondFile);
      const firstRead = await firstSession.exec({
        cmd: 'printf "%s:" "$OPENGENI_CODEMODE_TOKEN_FILE"; cat "$OPENGENI_CODEMODE_TOKEN_FILE"',
      });
      const secondRead = await secondSession.exec({
        cmd: 'printf "%s:" "$OPENGENI_CODEMODE_TOKEN_FILE"; cat "$OPENGENI_CODEMODE_TOKEN_FILE"',
      });
      expect(firstRead.stdout).toBe(`${firstFile}:ogd_first_renewed`);
      expect(secondRead.stdout).toBe(`${secondFile}:ogd_second`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not delete the bearer when the legacy and selected paths are identical", async () => {
    const home = mkdtempSync(join(tmpdir(), "opengeni-codemode-equal-pointer-"));
    try {
      const tokenFile = join(home, ".opengeni", "codemode-token");
      await runCodemodeTokenSeedHook(shellSession(home) as never, {
        environment: { HOME: home, OPENGENI_CODEMODE_TOKEN_FILE: tokenFile },
        codemodeTokenSeed: "ogd_same_pointer",
        codemodeTokenFile: tokenFile,
      });
      expect(readFileSync(tokenFile, "utf8")).toBe("ogd_same_pointer");
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
