/** Dependency-free failure telemetry: usable before installation, including in Docker builds. */
import { spawn } from "node:child_process";
import { readFileSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PREFIX = "[acquisition-diagnostic] ";
const TAIL_BYTES = 64 * 1024;

function explicitHttpStatus(stderr: string): number | null {
  const statuses = [
    ...stderr.matchAll(/(?:HTTP\/\d(?:\.\d)?\s+|status(?: code)?[:=]?\s+)([45]\d\d)\b/gi),
  ];
  return statuses.length === 1 ? Number(statuses[0]![1]) : null;
}

export function filesystemCapacity(path: string) {
  try {
    const stats = statfsSync(path, { bigint: true });
    // Decimal strings retain precision; no filesystem paths or exception messages are emitted.
    return {
      availableBytes: (stats.bavail * stats.bsize).toString(),
      freeInodes: stats.ffree.toString(),
      observation: "local-filesystem-at-failure" as const,
    };
  } catch {
    return { availableBytes: null, freeInodes: null, observation: "unavailable" as const };
  }
}

export function installFailureSummary(stderr: string, lockText: string | null) {
  const packages: Array<{ identity: string; expectedIntegrity: string | null }> = [];
  const errorLines = stderr
    .split("\n")
    .filter((line) => /error|fail|extract|integrity/i.test(line));
  let lockObservation = "unavailable";
  try {
    const lock = Bun.JSONC.parse(lockText ?? "") as { packages?: Record<string, unknown> };
    if (lock.packages && typeof lock.packages === "object") {
      lockObservation = "read";
      for (const entry of Object.values(lock.packages)) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
        const match = /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d[^\s/@:?#]*)$/i.exec(entry[0]);
        if (!match) continue;
        const name = match[1]!;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const packageMention = new RegExp(`(^|[\\s"'])${escaped}(?=$|[\\s"'@:,])`, "m");
        if (!errorLines.some((line) => packageMention.test(line))) continue;
        if (packages.some((candidate) => candidate.identity === entry[0])) continue;
        packages.push({
          identity: entry[0],
          expectedIntegrity:
            entry.find(
              (value): value is string =>
                typeof value === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/.test(value),
            ) ?? null,
        });
        if (packages.length === 20) break;
      }
    }
  } catch {
    // Malformed/missing locks must never replace the install failure or cause a network probe.
  }
  return {
    kind: "bun-install",
    packages,
    packageIdentification: "lock-candidates-mentioned-in-bounded-stderr-not-confirmed-resolution",
    packageLimit: 20,
    packageLimitReached: packages.length === 20,
    lockObservation,
    observedIntegrity: null,
    receivedBytes: null,
    httpStatus: explicitHttpStatus(stderr),
    httpStatusScope: "explicit-single-stderr-response-only; not-package-attributed",
    originalArchiveObservation: "unavailable-from-bun-output; no-refetch-performed",
    stderrWindowBytes: TAIL_BYTES,
  };
}

export function dockerPullFailureSummary(stderr: string) {
  // Classify only an explicitly named rejection phase. A generic denied response does not
  // identify whether the token endpoint, manifest or a layer request rejected the pull.
  const phase = /(?:failed to (?:fetch|authorize).*token|oauth token|token request)/i.test(stderr)
    ? "token"
    : /(?:failed to (?:fetch|resolve).*manifest|manifest.*(?:denied|unauthorized|forbidden))/i.test(
          stderr,
        )
      ? "manifest"
      : /(?:failed to (?:fetch|download).*layer|layer.*(?:denied|unauthorized|forbidden))/i.test(
            stderr,
          )
        ? "layer"
        : "unavailable";
  return {
    kind: "docker-pull",
    rejectionPhase: phase,
    httpStatus: explicitHttpStatus(stderr),
    originalArchiveObservation: "unavailable-from-docker-cli",
    daemonDiskObservation: "unavailable; local-client-filesystem-is-not-daemon-storage",
    clientFilesystem: filesystemCapacity(process.cwd()),
  };
}

export function emitAcquisitionDiagnostic(summary: unknown) {
  console.error(`${PREFIX}${JSON.stringify(summary)}`);
}

export async function observeInstall(command: string[]) {
  let tail = Buffer.alloc(0);
  let stderrTruncated = false;
  const child = spawn(command[0]!, command.slice(1), { stdio: ["inherit", "inherit", "pipe"] });
  child.stderr.on("data", (chunk: Buffer) => {
    if (!process.stderr.write(chunk)) {
      child.stderr.pause();
      process.stderr.once("drain", () => child.stderr.resume());
    }
    stderrTruncated ||= tail.length + chunk.length > TAIL_BYTES;
    tail = Buffer.concat([tail, chunk]).subarray(-TAIL_BYTES);
  });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  const onInterrupt = () => forward("SIGINT");
  const onTerminate = () => forward("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("error", () => resolve({ code: 127, signal: null }));
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  );
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
  if (result.code !== 0) {
    try {
      let lockText: string | null = null;
      try {
        lockText = readFileSync("bun.lock", "utf8");
      } catch {
        /* Optional evidence only. */
      }
      const cachePath =
        process.env.BUN_INSTALL_CACHE_DIR ||
        join(process.env.BUN_INSTALL || join(homedir(), ".bun"), "install", "cache");
      emitAcquisitionDiagnostic({
        ...installFailureSummary(tail.toString("utf8"), lockText),
        exitCode: result.code,
        signal: result.signal,
        stderrTruncated,
        workingFilesystem: filesystemCapacity(process.cwd()),
        cachePathClass: process.env.BUN_INSTALL_CACHE_DIR
          ? "environment-override"
          : process.env.BUN_INSTALL
            ? "bun-install-root-candidate"
            : "bun-home-default-candidate",
        cachePathObservation:
          "environment-or-default-candidate; bunfig-and-actual-entry-not-observed",
        cacheFilesystem: filesystemCapacity(cachePath),
      });
    } catch {
      console.error(`${PREFIX}{"kind":"bun-install","observation":"unavailable"}`);
    }
  }
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code ?? 1;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  // Bun consumes the separator in script invocation; tolerate runtimes that retain it too.
  if (args[0] === "--") args.shift();
  // The CLI is intentionally limited to observing an existing install, without adding flags.
  if (args[0] !== "bun" || args[1] !== "install") {
    console.error("usage: acquisition-diagnostics.ts -- bun install <existing install flags>");
    process.exitCode = 64;
  } else {
    await observeInstall([process.execPath, ...args.slice(1)]);
  }
}
