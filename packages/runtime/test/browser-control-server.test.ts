import { describe, expect, test } from "bun:test";
import {
  BrowserControlServerError,
  BrowserControlServerUnsupportedError,
  buildBrowserControlServerScript,
  ensureBrowserControlServer,
  tearDownBrowserControlServer,
} from "../src/sandbox";

describe("browser control server placement lifecycle", () => {
  test("builds one flocked launch without putting the token value in argv", () => {
    const command = buildBrowserControlServerScript({
      adminTokenFile: "/run/opengeni/browserd-token",
      allowedOrigins: ["https://app.opengeni.com"],
    });
    expect(command).toContain("flock -w 30 --close");
    expect(command).toContain("OPENGENI_BROWSERD_PORT=7682");
    expect(command).toContain("OPENGENI_BROWSERD_ROOT='/tmp/opengeni-browserd/state'");
    expect(command).toContain("OPENGENI_BROWSERD_ADMIN_TOKEN_FILE='/run/opengeni/browserd-token'");
    expect(command).toContain("OPENGENI_BROWSERD_ALLOWED_ORIGINS='https://app.opengeni.com'");
    expect(command).toContain("OPENGENI_CODEMODE_TOKEN_FILE=/dev/null");
    expect(command).toContain("test -x /usr/local/bin/opengeni-browserd-up");
    expect(command).toContain("/usr/local/bin/opengeni-browserd-up");
    expect(command).not.toContain("Bearer");
  });

  test("classifies a missing browserd binary as engine_unavailable", async () => {
    await expect(
      ensureBrowserControlServer(
        {
          exec: async () => ({
            exitCode: 127,
            stderr: "env: ‘opengeni-browserd-up’: No such file or directory",
          }),
        },
        { adminTokenFile: "/run/opengeni/browserd-token" },
      ),
    ).rejects.toMatchObject<BrowserControlServerError>({
      exitCode: 127,
      stage: "engine_unavailable",
    });
    await expect(
      ensureBrowserControlServer(
        {
          exec: async () => ({
            exitCode: 16,
            stderr: "opengeni-browserd-up is not installed on this sandbox image",
          }),
        },
        { adminTokenFile: "/run/opengeni/browserd-token" },
      ),
    ).rejects.toMatchObject<BrowserControlServerError>({
      exitCode: 16,
      stage: "engine_unavailable",
    });
  });

  test("launches through structured exec and parses the exact readiness marker", async () => {
    const commands: Array<{ cmd: string; workdir?: string; yieldTimeMs?: number }> = [];
    const result = await ensureBrowserControlServer(
      {
        exec: async (args: { cmd: string; workdir?: string; yieldTimeMs?: number }) => {
          commands.push(args);
          return {
            exitCode: 0,
            stdout: "OPENGENI_BROWSERD_UP port=7682 (already)\n",
          };
        },
      },
      { adminTokenFile: "/run/opengeni/browserd-token" },
    );
    expect(result).toEqual({
      port: 7682,
      marker: "OPENGENI_BROWSERD_UP port=7682 (already)",
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.workdir).toBe("/workspace");
    expect(commands[0]?.yieldTimeMs).toBe(60_000);
  });

  test("classifies startup and port collision failures on execCommand fallback", async () => {
    await expect(
      ensureBrowserControlServer(
        {
          execCommand: async () =>
            "browser controller port 7682 is occupied by an unmanaged process",
        },
        { adminTokenFile: "/run/opengeni/browserd-token" },
      ),
    ).rejects.toMatchObject<BrowserControlServerError>({
      exitCode: 15,
      stage: "port_conflict",
    });
    await expect(
      ensureBrowserControlServer(
        {
          execCommand: async () => "browser controller has no supported Chromium engine",
        },
        { adminTokenFile: "/run/opengeni/browserd-token" },
      ),
    ).rejects.toMatchObject<BrowserControlServerError>({
      exitCode: 16,
      stage: "engine_unavailable",
    });
    await expect(
      ensureBrowserControlServer({}, { adminTokenFile: "/run/opengeni/browserd-token" }),
    ).rejects.toBeInstanceOf(BrowserControlServerUnsupportedError);
  });

  test("rejects a successful process exit without the authenticated readiness marker", async () => {
    await expect(
      ensureBrowserControlServer(
        {
          exec: async () => ({ exitCode: 0, stdout: "unrelated output\n" }),
        },
        { adminTokenFile: "/run/opengeni/browserd-token" },
      ),
    ).rejects.toMatchObject<BrowserControlServerError>({ exitCode: 14, stage: "startup" });
  });

  test("tears down through the available provider command surface", async () => {
    const commands: Array<{ cmd: string; workdir?: string }> = [];
    await tearDownBrowserControlServer({
      execCommand: async (args: { cmd: string; workdir?: string }) => {
        commands.push(args);
        return "OPENGENI_BROWSERD_DOWN";
      },
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      cmd: "/bin/bash /usr/local/bin/opengeni-browserd-down",
      workdir: "/workspace",
    });
  });

  test("rejects relative token paths and non-origin allowlist entries", () => {
    expect(() => buildBrowserControlServerScript({ adminTokenFile: "relative/token" })).toThrow(
      "must be absolute",
    );
    expect(() =>
      buildBrowserControlServerScript({
        adminTokenFile: "/run/opengeni/browserd-token",
        allowedOrigins: ["https://app.opengeni.com/path"],
      }),
    ).toThrow("must be an absolute origin");
  });
});
