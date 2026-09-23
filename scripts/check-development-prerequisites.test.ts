import { describe, expect, spyOn, test } from "bun:test";
import {
  collectDevelopmentPrerequisites,
  collectDevelopmentSourceBuildPrerequisites,
  createPrerequisiteHost,
  developmentPrerequisiteErrors,
  type PrerequisiteHost,
} from "./check-development-prerequisites";
import { resolve } from "node:path";

const ready = {
  bunVersion: "1.4.0",
  requiredBunVersion: "1.4.0",
  platform: "linux",
  which: (command: string) => `/usr/bin/${command}`,
};

describe("development prerequisites", () => {
  test("accepts supported hosts without requiring Docker or model credentials", () => {
    for (const platform of ["linux", "darwin"]) {
      expect(developmentPrerequisiteErrors({ ...ready, platform })).toEqual([]);
    }
    expect(developmentPrerequisiteErrors({ ...ready, bunVersion: "1.5.0" })).toEqual([
      expect.stringContaining("pinned Bun 1.4.0"),
    ]);
  });

  test("reports an older Bun before the frozen install fails", () => {
    expect(developmentPrerequisiteErrors({ ...ready, bunVersion: "1.3.5" })).toEqual([
      expect.stringContaining("pinned Bun 1.4.0"),
    ]);
  });

  test("collects missing native build tools with installation instructions", () => {
    const errors = developmentPrerequisiteErrors({
      ...ready,
      which: (command) => (command === "rustup" || command === "cc" ? null : `/usr/bin/${command}`),
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("https://rustup.rs");
    expect(errors[1]).toContain("Xcode Command Line Tools");
  });

  test("directs native Windows users to WSL2", () => {
    expect(developmentPrerequisiteErrors({ ...ready, platform: "win32" })).toEqual([
      expect.stringContaining("WSL2"),
    ]);
  });
});

function fixture(overrides: Partial<PrerequisiteHost> = {}) {
  const commands: string[] = [];
  const host: PrerequisiteHost = {
    ...ready,
    arch: "x64",
    uid: 1000,
    executable: () => true,
    readable: () => true,
    probe(command, args) {
      const key = [command, ...args].join(" ");
      commands.push(key);
      const stdout: Record<string, string> = {
        "docker compose version": "Docker Compose version v2.39.0",
        "pg_config --version": "PostgreSQL 17.6",
        "pg_config --bindir": "/opt/postgres/bin\n",
        "pg_config --sharedir": "/opt/postgres/share\n",
        "pg_config --pkglibdir": "/opt/postgres/lib\n",
        "psql --version": "psql (PostgreSQL) 17.6",
        "pg_isready --version": "pg_isready (PostgreSQL) 17.6",
        "nats-server --version": "nats-server: v2.11.8",
        "temporal server start-dev --help": "--db-filename string",
        "garage --version": "garage v2.3.0",
        "minio --version": "minio version RELEASE.2025-09-07T16-13-09Z",
        "mc --version": "mc version RELEASE.2025-08-13T08-35-41Z",
        "rustup run 1.97.0 rustc --version": "rustc 1.97.0 (commit date)",
      };
      return { ok: true, stdout: stdout[key] ?? "" };
    },
    ...overrides,
  };
  return { host, commands };
}

const prebuilt = { artifactRuntime: "verified-prebuilt", relayRuntime: "disabled" } as const;

describe("backend-aware read-only preflight", () => {
  test("Docker checks daemon, Compose, Buildx, but not native infrastructure", async () => {
    const { host, commands } = fixture();
    expect(await collectDevelopmentPrerequisites({ ...prebuilt, environment: {} }, host)).toEqual({
      backend: "docker",
      errors: [],
    });
    expect(commands).toEqual(["docker info", "docker compose version", "docker buildx version"]);
  });

  test("auto falls back to complete native checks when daemon probe fails", async () => {
    const { host, commands } = fixture();
    const probe = host.probe;
    host.probe = (command, args) =>
      command === "docker" ? { ok: false, stdout: "secret" } : probe(command, args);
    const result = await collectDevelopmentPrerequisites({ ...prebuilt, environment: {} }, host);
    expect(result).toEqual({ backend: "native", errors: [] });
    expect(commands).toContain("garage --version");
    expect(commands.some((command) => command.startsWith("minio"))).toBe(false);
  });

  test("explicit Docker does not fall back and reports all Docker probe failures", async () => {
    const { host } = fixture({ probe: () => ({ ok: false, stdout: "credential=do-not-print" }) });
    const result = await collectDevelopmentPrerequisites(
      { ...prebuilt, environment: { OPENGENI_DEV_BACKEND: "docker" } },
      host,
    );
    expect(result.backend).toBe("docker");
    expect(result.errors).toHaveLength(3);
    expect(result.errors.join("\n")).not.toContain("do-not-print");
  });

  test("native never probes Docker and requires server tools, extensions and libraries together", async () => {
    const { host, commands } = fixture({ readable: () => false, executable: () => false });
    const result = await collectDevelopmentPrerequisites(
      { ...prebuilt, environment: { OPENGENI_DEV_BACKEND: "native" } },
      host,
    );
    expect(result.errors).toHaveLength(8);
    expect(result.errors.join("\n")).toContain("initdb");
    expect(result.errors.join("\n")).toContain("vector shared library");
    expect(result.errors.join("\n")).toContain("pgcrypto extension control");
    expect(commands.some((command) => command.startsWith("docker"))).toBe(false);
  });

  test("empty fresh host aggregates missing programs, Bun, and source build requirements", async () => {
    const { host } = fixture({ which: () => null, bunVersion: "1.0.0", uid: 0 });
    const result = await collectDevelopmentPrerequisites(
      {
        environment: {
          OPENGENI_DEV_BACKEND: "native",
          OPENGENI_SANDBOX_SELFHOSTED_ENABLED: "true",
        },
      },
      host,
    );
    for (const requirement of [
      "Bun",
      "bash",
      "git",
      "curl",
      "ps",
      "rustup",
      "cc",
      "setsid",
      "sha256sum",
      "runuser",
      "pg_config",
      "psql",
      "pg_isready",
      "nats-server",
      "temporal",
      "garage",
      "cargo",
    ]) {
      expect(result.errors.join("\n")).toContain(requirement);
    }
    expect(result.errors.join("\n")).not.toMatch(/curl[^\n]*\|\s*(?:bash|sh)/u);
    expect(result.errors.join("\n")).toContain("--install --tools=nats,temporal");
    expect(result.errors.join("\n")).toContain("Temporal CLI 1.4.1");
    expect(result.errors.join("\n")).toContain(
      "cross-validated against the existing digest-pinned official image",
    );
  });

  test("verified prebuilt runtime skips Rust/cc; a separate source relay still requires them", async () => {
    const { host } = fixture({
      which: (command) => (["rustup", "cc", "cargo"].includes(command) ? null : `/bin/${command}`),
    });
    expect(
      (await collectDevelopmentPrerequisites({ ...prebuilt, environment: {} }, host)).errors,
    ).toEqual([]);
    const result = await collectDevelopmentPrerequisites(
      { ...prebuilt, relayRuntime: "source-build", environment: {} },
      host,
    );
    expect(result.errors).toHaveLength(3);
    expect(result.errors.join("\n")).toContain("relay");
  });

  test("source build probes pinned Rust without installing it", async () => {
    const { host, commands } = fixture();
    const result = await collectDevelopmentPrerequisites(
      { environment: { OPENGENI_SANDBOX_SELFHOSTED_ENABLED: "true" } },
      host,
    );
    expect(result.errors).toEqual([]);
    expect(commands).toContain("rustup run 1.97.0 rustc --version");
    expect(commands).toContain("rustup run stable rustc --version");
    expect(commands.every((command) => !command.includes(" install"))).toBe(true);
  });

  test("resolve defers artifact-only build requirements without claiming verified prebuilt", async () => {
    const { host, commands } = fixture({
      which: (command) => (["rustup", "cc", "cargo"].includes(command) ? null : `/bin/${command}`),
    });
    expect(
      (await collectDevelopmentPrerequisites({ artifactRuntime: "resolve", environment: {} }, host))
        .errors,
    ).toEqual([]);
    expect(commands).toEqual(["docker info", "docker compose version", "docker buildx version"]);
    const relay = await collectDevelopmentPrerequisites(
      { artifactRuntime: "resolve", environment: { OPENGENI_SANDBOX_SELFHOSTED_ENABLED: "true" } },
      host,
    );
    expect(relay.errors).toHaveLength(3);
  });

  test("source fallback separately aggregates build requirements without probing services", async () => {
    const { host, commands } = fixture({ which: () => null });
    const errors = await collectDevelopmentSourceBuildPrerequisites(
      { artifactRuntime: "source-build", relayRuntime: "disabled", environment: {} },
      host,
    );
    expect(errors).toEqual([expect.stringContaining("rustup"), expect.stringContaining("cc")]);
    expect(commands).toEqual([]);
    const readyHost = fixture();
    expect(
      await collectDevelopmentSourceBuildPrerequisites(
        { artifactRuntime: "source-build", relayRuntime: "disabled", environment: {} },
        readyHost.host,
      ),
    ).toEqual([]);
    expect(readyHost.commands).toEqual([
      "rustup run 1.97.0 rustc --version",
      "rustup run 1.97.0 cargo --version",
    ]);
  });

  test("MinIO is explicit, pinned, and does not require Garage", async () => {
    const { host, commands } = fixture();
    const options = {
      ...prebuilt,
      environment: { OPENGENI_DEV_BACKEND: "native", OPENGENI_OBJECT_STORAGE_FIXTURE: "minio" },
    };
    expect((await collectDevelopmentPrerequisites(options, host)).errors).toEqual([]);
    expect(commands).toContain("mc --version");
    expect(commands).not.toContain("garage --version");
    const probe = host.probe;
    host.probe = (command, args) =>
      ["minio", "mc"].includes(command)
        ? { ok: true, stdout: "unversioned" }
        : probe(command, args);
    expect((await collectDevelopmentPrerequisites(options, host)).errors).toHaveLength(2);
  });

  test("fresh or disabled selfhosted does not require relay tools with verified artifacts", async () => {
    const { host, commands } = fixture({
      which: (command) => (["rustup", "cc", "cargo"].includes(command) ? null : `/bin/${command}`),
    });
    for (const enabled of [undefined, "false"]) {
      const result = await collectDevelopmentPrerequisites(
        {
          artifactRuntime: "verified-prebuilt",
          environment: { OPENGENI_SANDBOX_SELFHOSTED_ENABLED: enabled },
        },
        host,
      );
      expect(result.errors).toEqual([]);
    }
    expect(commands.some((command) => command.includes("cargo"))).toBe(false);
    const enabled = await collectDevelopmentPrerequisites(
      {
        artifactRuntime: "verified-prebuilt",
        environment: { OPENGENI_SANDBOX_SELFHOSTED_ENABLED: "true" },
      },
      host,
    );
    expect(enabled.errors).toHaveLength(3);
  });

  test("invalid selectors do not print their possibly sensitive values", async () => {
    const { host } = fixture();
    const result = await collectDevelopmentPrerequisites(
      {
        ...prebuilt,
        environment: {
          OPENGENI_DEV_BACKEND: "token=private",
          OPENGENI_OBJECT_STORAGE_FIXTURE: "token=private",
        },
      },
      host,
    );
    expect(result.errors).toHaveLength(2);
    expect(result.errors.join("\n")).not.toContain("private");
  });

  test("does not accept outdated NATS, wrong PostgreSQL, or a Temporal CLI without start-dev", async () => {
    const { host } = fixture();
    const probe = host.probe;
    host.probe = (command, args) => {
      if (command === "nats-server") return { ok: true, stdout: "nats-server: v2.9.1" };
      if (command === "temporal") return { ok: true, stdout: "tctl" };
      if (command === "pg_config" && args[0] === "--version")
        return { ok: true, stdout: "PostgreSQL 16.2" };
      return probe(command, args);
    };
    const result = await collectDevelopmentPrerequisites(
      { ...prebuilt, environment: { OPENGENI_DEV_BACKEND: "native" } },
      host,
    );
    expect(result.errors).toHaveLength(3);
  });

  test("macOS native supervision is unsupported with either fixture; Windows requires WSL2", async () => {
    const { host } = fixture({ platform: "darwin" });
    for (const storage of ["garage", "minio"]) {
      const result = await collectDevelopmentPrerequisites(
        {
          ...prebuilt,
          environment: { OPENGENI_DEV_BACKEND: "native", OPENGENI_OBJECT_STORAGE_FIXTURE: storage },
        },
        host,
      );
      expect(result.errors).toEqual([
        expect.stringContaining("macOS native supervision is unsupported"),
      ]);
      expect(result.errors[0]).toContain("OPENGENI_DEV_BACKEND=docker");
    }
    expect(
      developmentPrerequisiteErrors({ ...ready, ...prebuilt, platform: "win32" }).join("\n"),
    ).toContain("WSL2");
  });

  test("macOS Docker remains supported without native utilities or service binaries", async () => {
    const { host } = fixture({
      platform: "darwin",
      which: (command) =>
        ["bash", "git", "curl", "ps", "docker"].includes(command) ? `/bin/${command}` : null,
    });
    expect(
      await collectDevelopmentPrerequisites(
        { ...prebuilt, environment: { OPENGENI_DEV_BACKEND: "docker" } },
        host,
      ),
    ).toEqual({ backend: "docker", errors: [] });
  });

  test("remote/disabled sandboxes do not require Buildx", async () => {
    const { host, commands } = fixture();
    await collectDevelopmentPrerequisites(
      { ...prebuilt, environment: { OPENGENI_SANDBOX_BACKEND: "none" } },
      host,
    );
    expect(commands).not.toContain("docker buildx version");
  });

  test("real probe bounds hung commands, caps output, and suppresses stderr", async () => {
    const host = createPrerequisiteHost(process.env, resolve(import.meta.dir, ".."));
    const before = Date.now();
    expect(await host.probe(process.execPath, ["-e", "setInterval(() => {}, 1000)"])).toEqual({
      ok: false,
      stdout: "",
    });
    expect(Date.now() - before).toBeLessThan(4500);
    expect(
      await host.probe(process.execPath, ["-e", "console.error('sensitive'); process.exit(1)"]),
    ).toEqual({ ok: false, stdout: "" });
    expect(await host.probe(process.execPath, ["-e", "console.log('x'.repeat(100000))"])).toEqual({
      ok: false,
      stdout: "",
    });
    expect(await host.probe("/nonexistent/opengeni-preflight-test", [])).toEqual({
      ok: false,
      stdout: "",
    });
  }, 6000);

  test("whole-preflight budget prevents further commands after fifteen seconds", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    try {
      const host = createPrerequisiteHost(process.env, resolve(import.meta.dir, ".."));
      clock.mockReturnValue(16001);
      expect(await host.probe(process.execPath, ["--version"])).toEqual({ ok: false, stdout: "" });
    } finally {
      clock.mockRestore();
    }
  });
});
