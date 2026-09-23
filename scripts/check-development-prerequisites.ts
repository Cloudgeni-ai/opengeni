#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalBunVersion } from "./bun-version";

export type DevelopmentPrerequisiteOptions = {
  repositoryRoot?: string;
  /** Already resolved launcher authority. This checker never sources shell files. */
  environment?: NodeJS.ProcessEnv;
  /** resolve defers artifact build checks until the resolver needs source fallback;
   * it is NOT a verified runtime. Only the verifier may select verified-prebuilt. */
  artifactRuntime?: "source-build" | "verified-prebuilt" | "resolve";
  /** Defaults to source-build only when effective selfhosted is enabled. */
  relayRuntime?: "source-build" | "verified-prebuilt" | "disabled";
};

export type PrerequisiteProbeResult = { ok: boolean; stdout: string };
export type PrerequisiteHost = {
  platform: string;
  arch: string;
  uid: number;
  bunVersion: string;
  which: (command: string) => string | null;
  readable: (path: string) => boolean;
  executable: (path: string) => boolean;
  /** Read-only commands only; implementation must bound runtime and output. */
  probe: (command: string, args: string[]) => PrerequisiteProbeResult | Promise<PrerequisiteProbeResult>;
};

const nativeInstall = {
  postgres: "Install PostgreSQL 17 server/client and matching pgvector (Debian/Ubuntu with PGDG: sudo apt-get install postgresql-17 postgresql-client-17 postgresql-17-pgvector; macOS: brew install postgresql@17, then build/install pgvector v0.8.0 with PG_CONFIG pointing to that PostgreSQL 17 installation). Put its bin directory on PATH and verify pg_config --version. Extension files must belong to that same installation; an unversioned Homebrew pgvector may target a different PostgreSQL major.",
  nats: "Install pinned NATS server 2.11.8 and Temporal CLI 1.4.1 with: bun scripts/install-development-tools.ts --install --tools=nats,temporal. Add the reported binDirectory to PATH. The verified project-local installer provides nats-server, not the nats client; preflight itself installs nothing.",
  temporal: "Install pinned Temporal CLI 1.4.1 with: bun scripts/install-development-tools.ts --install --tools=nats,temporal. Add the reported binDirectory to PATH. The CLI must provide server start-dev; tctl is not a substitute.",
  garage: "Provide an independently verified Garage v2.3.0 host binary on PATH, or use OPENGENI_DEV_BACKEND=docker with the repository's digest-pinned image. Automatic native Garage bootstrap is unavailable: the official Linux release assets lack an upstream checksum source, and no official macOS binary is provided. Preflight does not download or build Garage.",
  minio: "Explicit MinIO compatibility requires minio RELEASE.2025-09-07T16-13-09Z and mc RELEASE.2025-08-13T08-35-41Z (docker-compose.yml pins). Obtain matching verified host binaries from the upstream release archives; if unavailable on this host use Docker or Garage, not an unpinned latest binary.",
};

export function developmentPrerequisiteErrors(options: {
  bunVersion: string;
  requiredBunVersion: string;
  platform: string;
  which: (command: string) => string | null;
  artifactRuntime?: DevelopmentPrerequisiteOptions["artifactRuntime"];
  relayRuntime?: DevelopmentPrerequisiteOptions["relayRuntime"];
}): string[] {
  const errors: string[] = [];
  if (options.bunVersion !== options.requiredBunVersion) {
    errors.push(`Bun does not match this checkout's pinned Bun ${options.requiredBunVersion}. Download the matching host archive from https://github.com/oven-sh/bun/releases/tag/bun-v${options.requiredBunVersion}, verify its checksum, extract it and put bun on PATH. Check bun --version and PATH order; do not pipe downloaded scripts into a shell.`);
  }
  if (options.platform !== "linux" && options.platform !== "darwin") {
    errors.push("The repository Bash launcher requires Linux or macOS. Native Windows/PowerShell startup is unsupported: use WSL2 with a Linux checkout and install tools inside that distribution (not Windows executables).");
  }
  for (const command of ["bash", "git", "curl", "ps"]) {
    if (!options.which(command)) errors.push(`Missing ${command}. Install host packages (Debian/Ubuntu: sudo apt-get install bash git curl procps; macOS: Xcode Command Line Tools via xcode-select --install, plus brew install bash curl).`);
  }
  errors.push(...sourceBuildHostErrors(options));
  return errors;
}

function sourceBuildHostErrors(options: Pick<DevelopmentPrerequisiteOptions, "artifactRuntime" | "relayRuntime"> & {
  which: PrerequisiteHost["which"];
}): string[] {
  const errors: string[] = [];
  if ((options.artifactRuntime ?? "source-build") === "source-build" ||
      (options.relayRuntime !== "verified-prebuilt" && options.relayRuntime !== "disabled")) {
    for (const [command, hint] of [
      ["rustup", "Install rustup using a downloaded, inspected installer from https://rustup.rs; source builds use the checked-in Rust toolchain, not an arbitrary system rustc."],
      ["cc", "Install the Xcode Command Line Tools (xcode-select --install) on macOS, or sudo apt-get install build-essential on Debian/Ubuntu."],
    ] as const) {
      if (!options.which(command)) errors.push(`Missing ${command} for source-build mode. ${hint}`);
    }
  }
  return errors;
}

/** No installs, downloads, generated files, database connections, or service starts. */
export async function collectDevelopmentPrerequisites(
  options: DevelopmentPrerequisiteOptions = {},
  suppliedHost?: PrerequisiteHost,
): Promise<{ backend: "docker" | "native"; errors: string[] }> {
  const repositoryRoot = options.repositoryRoot ?? resolve(import.meta.dir, "..");
  const environment = options.environment ?? process.env;
  const host = suppliedHost ?? createPrerequisiteHost(environment, repositoryRoot);
  const errors = developmentPrerequisiteErrors({
    ...host, artifactRuntime: "resolve", relayRuntime: "disabled",
    requiredBunVersion: await canonicalBunVersion(repositoryRoot),
  });
  const requested = environment.OPENGENI_DEV_BACKEND || "auto";
  if (!["auto", "native", "docker"].includes(requested)) {
    errors.push("OPENGENI_DEV_BACKEND must be auto, docker, or native.");
  }
  const dockerUsable = requested !== "native" && Boolean(host.which("docker")) && (await host.probe("docker", ["info"])).ok;
  const backend = requested === "docker" || (requested === "auto" && dockerUsable) ? "docker" : "native";
  const fixture = environment.OPENGENI_OBJECT_STORAGE_FIXTURE || "garage";
  if (!["garage", "minio"].includes(fixture)) {
    errors.push("OPENGENI_OBJECT_STORAGE_FIXTURE must be garage (default) or minio (explicit compatibility).");
  }
  const requireCommand = (command: string, hint: string): boolean => {
    if (host.which(command)) return true;
    errors.push(`Missing ${command}. ${hint}`);
    return false;
  };
  const requireProbe = async (command: string, args: string[], message: string, match?: RegExp) => {
    const result = await host.probe(command, args);
    if (!result.ok || (match && !match.test(result.stdout))) errors.push(message);
    return result;
  };
  if (backend === "docker") {
    if (!dockerUsable) errors.push("Docker backend requires an installed Docker CLI and a responsive daemon. Start Docker Desktop on macOS/WSL2 or the Docker Engine service on Linux, check socket permissions/context, then run docker info. Auto fallback is not used for explicit docker.");
    if (host.which("docker")) {
      await requireProbe("docker", ["compose", "version"], "Docker Compose v2 is required. Install the Docker Compose plugin (docker-compose-plugin on Docker's Debian/Ubuntu repository) or enable it in Docker Desktop.", /(?:version\s+)?v?2\.\d+/u);
      if (!environment.OPENGENI_SANDBOX_BACKEND || environment.OPENGENI_SANDBOX_BACKEND === "docker") {
        await requireProbe("docker", ["buildx", "version"], "Docker sandbox builds require Buildx. Install docker-buildx-plugin on Linux or enable Buildx in Docker Desktop.");
      }
    }
  } else {
    if (!["x64", "arm64"].includes(host.arch)) errors.push("Native infrastructure host architecture is unsupported; use Linux/macOS x64 or arm64 with verified host binaries, or a supported Docker host.");
    for (const command of ["setsid", "sha256sum", "nohup"]) {
      requireCommand(command, "Native launcher requires this utility. Debian/Ubuntu: sudo apt-get install util-linux coreutils. macOS: install coreutils and a setsid-compatible utility and expose their commands on PATH, or select Docker; stock macOS alone is insufficient.");
    }
    if (host.uid === 0) {
      requireCommand("runuser", "Root native startup requires util-linux runuser and a postgres system user; installing the PostgreSQL server package normally creates that user. Prefer an unprivileged development user.");
      await requireProbe("id", ["-u", "postgres"], "Root native startup requires a postgres system user. Install the PostgreSQL server package or run as an unprivileged user.");
    }
    if (requireCommand("pg_config", nativeInstall.postgres)) {
      await requireProbe("pg_config", ["--version"], `Native PostgreSQL must be version 17 for the local fixture. ${nativeInstall.postgres}`, /^PostgreSQL 17(?:\.|\s|$)/u);
      const bindir = await host.probe("pg_config", ["--bindir"]);
      const sharedir = await host.probe("pg_config", ["--sharedir"]);
      const librarydir = await host.probe("pg_config", ["--pkglibdir"]);
      if (!bindir.ok || !isAbsolute(bindir.stdout.trim())) {
        errors.push(`pg_config could not resolve its server binary directory. ${nativeInstall.postgres}`);
      } else {
        for (const command of ["postgres", "initdb", "pg_ctl", "createdb"]) {
          if (!host.executable(join(bindir.stdout.trim(), command))) errors.push(`Missing executable ${command} in pg_config --bindir. ${nativeInstall.postgres}`);
        }
      }
      if (!librarydir.ok || !isAbsolute(librarydir.stdout.trim())) {
        errors.push(`pg_config could not resolve its extension library directory. ${nativeInstall.postgres}`);
      } else {
        for (const extension of ["vector", "pgcrypto"]) {
          if (!host.readable(join(librarydir.stdout.trim(), `${extension}.so`))) errors.push(`Missing PostgreSQL ${extension} shared library. ${nativeInstall.postgres}`);
        }
      }
      if (!sharedir.ok || !isAbsolute(sharedir.stdout.trim())) {
        errors.push(`pg_config could not resolve its extension directory. ${nativeInstall.postgres}`);
      } else {
        for (const extension of ["vector", "pgcrypto"]) {
          if (!host.readable(join(sharedir.stdout.trim(), "extension", `${extension}.control`))) errors.push(`Missing PostgreSQL ${extension} extension control file. ${nativeInstall.postgres}`);
        }
      }
    }
    for (const command of ["psql", "pg_isready"]) {
      if (requireCommand(command, nativeInstall.postgres)) await requireProbe(command, ["--version"], `${command} must resolve to PostgreSQL 17 on PATH. ${nativeInstall.postgres}`, /\(PostgreSQL\) 17(?:\.|\s|$)/u);
    }
    if (requireCommand("nats-server", nativeInstall.nats)) await requireProbe("nats-server", ["--version"], `NATS server 2.10+ (2.x) is required for auth callout. ${nativeInstall.nats}`, /\bv2\.(?:1\d|[2-9]\d)\.\d+/u);
    if (requireCommand("temporal", nativeInstall.temporal)) await requireProbe("temporal", ["server", "start-dev", "--help"], `Temporal CLI does not provide the required native development server. ${nativeInstall.temporal}`, /--db-filename/u);
    if (fixture === "garage") {
      if (requireCommand("garage", nativeInstall.garage)) {
        await requireProbe("garage", ["--version"], `Native Garage must match v2.3.0. ${nativeInstall.garage}`, /\b2\.3\.0(?:\s|$)/u);
      }
      if (host.platform === "darwin") errors.push("Native Garage on macOS has no verified repository bootstrap path. Use the Docker backend, or explicit MinIO compatibility with verified macOS binaries; do not assume a Linux Garage binary will run.");
    }
    if (fixture === "minio") {
      for (const [command, pin] of [["minio", "RELEASE.2025-09-07T16-13-09Z"], ["mc", "RELEASE.2025-08-13T08-35-41Z"]] as const) {
        if (requireCommand(command, nativeInstall.minio)) {
          const result = await host.probe(command, ["--version"]);
          if (!result.ok || !result.stdout.includes(pin)) errors.push(`${command} does not match the pinned MinIO compatibility release. ${nativeInstall.minio}`);
        }
      }
    }
  }
  errors.push(...await collectDevelopmentSourceBuildPrerequisites(options, host));
  return { backend, errors };
}

/** Called by the runtime resolver BEFORE a source fallback build. Independent of
 * infrastructure: no Docker/PG/service checks, installs, or generated files. */
export async function collectDevelopmentSourceBuildPrerequisites(
  options: DevelopmentPrerequisiteOptions = {},
  suppliedHost?: PrerequisiteHost,
): Promise<string[]> {
  const repositoryRoot = options.repositoryRoot ?? resolve(import.meta.dir, "..");
  const environment = options.environment ?? process.env;
  const relayRuntime = options.relayRuntime ??
    (environment.OPENGENI_SANDBOX_SELFHOSTED_ENABLED === "true" ? "source-build" : "disabled");
  const host = suppliedHost ?? createPrerequisiteHost(environment, repositoryRoot);
  const errors = sourceBuildHostErrors({ ...options, relayRuntime, which: host.which });
  const requireProbe = async (command: string, args: string[], message: string, match?: RegExp) => {
    const result = await host.probe(command, args);
    if (!result.ok || (match && !match.test(result.stdout))) errors.push(message);
  };
  if ((options.artifactRuntime ?? "source-build") === "source-build" && host.which("rustup")) {
    const parsed = Bun.TOML.parse(readFileSync(join(repositoryRoot, "packages/artifact-tool/kernel/rust-toolchain.toml"), "utf8")) as { toolchain: { channel: string } };
    const channel = parsed.toolchain.channel;
    if (!/^\d+\.\d+\.\d+$/u.test(channel)) throw new Error("Invalid pinned artifact Rust toolchain");
    await requireProbe("rustup", ["run", channel, "rustc", "--version"], `Artifact source-build requires pinned Rust ${channel}. Run: rustup toolchain install ${channel} --profile minimal --no-self-update. Or supply a source/host/integrity-verified prebuilt artifact runtime through the launcher.`, new RegExp(`^rustc ${channel.replaceAll(".", "\\.")}\\s`, "u"));
    await requireProbe("rustup", ["run", channel, "cargo", "--version"], `Artifact source-build requires cargo in Rust ${channel}. Run: rustup toolchain install ${channel} --profile minimal --no-self-update.`);
  }
  if (relayRuntime === "source-build") {
    if (!host.which("cargo")) errors.push("Missing cargo. The local relay is a separate source build. Install the toolchain selected by agent/rust-toolchain.toml, or have the launcher disable the relay/use a verified prebuilt relay.");
    else await requireProbe("cargo", ["--version"], "Relay cargo is not usable. Install the toolchain selected by agent/rust-toolchain.toml; the artifact runtime's prebuilt status does not satisfy relay build requirements.");
    if (host.which("rustup")) {
      const parsed = Bun.TOML.parse(readFileSync(join(repositoryRoot, "agent/rust-toolchain.toml"), "utf8")) as { toolchain: { channel: string } };
      await requireProbe("rustup", ["run", parsed.toolchain.channel, "rustc", "--version"], "Relay source-build toolchain is unavailable. Install the channel from agent/rust-toolchain.toml using rustup toolchain install; that file currently selects a floating stable channel, not an exact release pin.");
    }
  }
  return errors;
}

/** Fixed per-command and whole-preflight budgets; captured output never enters diagnostics. */
export function createPrerequisiteHost(environment: NodeJS.ProcessEnv, cwd: string): PrerequisiteHost {
  const deadline = Date.now() + 15_000;
  const accessible = (path: string, mode: number) => {
    try { accessSync(path, mode); return true; } catch { return false; }
  };
  return {
    platform: process.platform, arch: process.arch, uid: process.getuid?.() ?? -1,
    bunVersion: Bun.version,
    which: (command) => Bun.which(command, { PATH: environment.PATH }),
    readable: (path) => accessible(path, constants.R_OK),
    executable: (path) => accessible(path, constants.X_OK),
    probe: async (command, args) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, stdout: "" };
      return new Promise<PrerequisiteProbeResult>((resolveResult) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const child = spawn(command, args, { cwd, env: { ...environment, RUSTUP_AUTO_INSTALL: "0" }, stdio: ["ignore", "pipe", "pipe"] });
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!ok) child.kill("SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
          resolveResult({ ok, stdout: ok ? Buffer.concat(chunks).toString("utf8") : "" });
        };
        const timer = setTimeout(() => finish(false), Math.min(3_000, remaining));
        child.stdout.on("data", (chunk: Buffer) => {
          if (settled) return;
          size += chunk.length;
          if (size > 64 * 1024) finish(false);
          else chunks.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64 * 1024) finish(false);
        });
        child.on("error", () => finish(false));
        child.on("close", (code) => finish(code === 0));
      });
    },
  };
}

export async function checkDevelopmentPrerequisites(options: DevelopmentPrerequisiteOptions = {}): Promise<void> {
  const { errors } = await collectDevelopmentPrerequisites(options);
  assertPrerequisites(errors);
}

export async function checkDevelopmentSourceBuildPrerequisites(options: DevelopmentPrerequisiteOptions = {}): Promise<void> {
  assertPrerequisites(await collectDevelopmentSourceBuildPrerequisites(options));
}

function assertPrerequisites(errors: string[]): void {
  if (errors.length > 0) {
    console.error("OpenGeni startup prerequisites are missing:\n" + errors.map((error) => `  - ${error}`).join("\n"));
    throw new Error("OpenGeni startup prerequisites are not satisfied; no prerequisite installation was attempted");
  }
}

if (import.meta.main) await checkDevelopmentPrerequisites();