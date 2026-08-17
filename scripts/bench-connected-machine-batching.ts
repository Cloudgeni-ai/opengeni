#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { materializeSandboxFileDownloads, type SandboxFileDownload } from "@opengeni/runtime";

const counts = integerListArgument("--counts", [1, 5, 20, 100]);
const roundTripsMs = integerListArgument("--round-trip-ms", [0, 20, 100]);
const samples = integerArgument("--samples", 3);
const parallelism = integerArgument("--parallelism", 4);
const payloadBytes = integerArgument("--payload-bytes", 4 * 1024);
const signedUrlPadding = integerArgument("--signed-url-padding", 384);

if (samples < 1 || samples > 20) throw new Error("--samples must be between 1 and 20");
if (parallelism < 1 || parallelism > 8) throw new Error("--parallelism must be 1..8");
if (payloadBytes < 1 || payloadBytes > 1024 * 1024) {
  throw new Error("--payload-bytes must be 1..1048576");
}
if (signedUrlPadding < 0 || signedUrlPadding > 8_192) {
  throw new Error("--signed-url-padding must be 0..8192");
}
if (!Bun.which("curl")) throw new Error("curl is required");

type Strategy = "host-parallel" | "host-serial" | "sandbox-batch-parallel" | "sandbox-batch-serial";
type Phase = "cold" | "warm";
type Measurement = {
  commandBytes: number;
  commandCount: number;
  count: number;
  elapsedMs: number;
  failures: number;
  maxHostCommands: number;
  phase: Phase;
  roundTripMs: number;
  strategy: Strategy;
};

const measurements: Measurement[] = [];
for (const count of counts) {
  for (const roundTripMs of roundTripsMs) {
    for (let sample = 0; sample < samples; sample += 1) {
      const strategies: Strategy[] =
        sample % 2 === 0
          ? ["host-serial", "host-parallel", "sandbox-batch-serial", "sandbox-batch-parallel"]
          : ["sandbox-batch-parallel", "sandbox-batch-serial", "host-parallel", "host-serial"];
      for (const strategy of strategies) {
        measurements.push(
          ...(await runScenario({
            count,
            parallelism,
            payloadBytes,
            roundTripMs,
            signedUrlPadding,
            strategy,
          })),
        );
      }
    }
  }
}

const correctness = await runCorrectness({
  count: Math.max(20, ...counts),
  parallelism,
  payloadBytes,
  signedUrlPadding,
});
const commandSize = commandSizeProjection({ parallelism, payloadBytes, signedUrlPadding });

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      question:
        "Can a single sandbox exec remove per-file Connected Machine round trips without reducing files or weakening exact-byte, SHA-256, symlink, regular-file, atomic-replacement, read-only, repair, and secret-output invariants?",
      configuration: { counts, parallelism, payloadBytes, roundTripsMs, samples, signedUrlPadding },
      measurements: summarize(measurements),
      commandSize,
      correctness,
    },
    null,
    2,
  )}\n`,
);

async function runScenario(input: {
  count: number;
  parallelism: number;
  payloadBytes: number;
  roundTripMs: number;
  signedUrlPadding: number;
  strategy: Strategy;
}): Promise<Measurement[]> {
  const fixture = await createFixture(input);
  try {
    const output: Measurement[] = [];
    for (const phase of ["cold", "warm"] as const) {
      fixture.resetCommandStats();
      const startedAt = performance.now();
      const failures = await materialize(
        fixture.session,
        fixture.downloads,
        input.strategy,
        input.parallelism,
      );
      const elapsedMs = performance.now() - startedAt;
      await fixture.assertExact();
      output.push({
        commandBytes: fixture.commandBytes(),
        commandCount: fixture.commandCount(),
        count: input.count,
        elapsedMs,
        failures,
        maxHostCommands: fixture.maxHostCommands(),
        phase,
        roundTripMs: input.roundTripMs,
        strategy: input.strategy,
      });
    }
    return output;
  } finally {
    await fixture.close();
  }
}

async function runCorrectness(input: {
  count: number;
  parallelism: number;
  payloadBytes: number;
  signedUrlPadding: number;
}) {
  const strategies: Strategy[] = [
    "host-serial",
    "host-parallel",
    "sandbox-batch-serial",
    "sandbox-batch-parallel",
  ];
  const repairs = [];
  for (const strategy of strategies) {
    const fixture = await createFixture({ ...input, roundTripMs: 20, strategy });
    try {
      const coldFailures = await materialize(
        fixture.session,
        fixture.downloads,
        strategy,
        input.parallelism,
      );
      await fixture.assertExact();
      if (input.count > 0) {
        await chmod(fixture.target(0), 0o644);
        await writeFile(fixture.target(0), "mutated");
      }
      if (input.count > 1) await unlink(fixture.target(1));
      const repairFailures = await materialize(
        fixture.session,
        fixture.downloads,
        strategy,
        input.parallelism,
      );
      await fixture.assertExact();
      repairs.push({
        strategy,
        coldFailures,
        repairFailures,
        mutatedTargetRepaired: input.count > 0,
        missingTargetRepaired: input.count > 1,
        signedUrlAbsentFromOutput: fixture.outputs().every((value) => !value.includes("sig=")),
        passed: coldFailures === 0 && repairFailures === 0,
      });
    } finally {
      await fixture.close();
    }
  }

  const hostile = await createFixture({
    count: 1,
    parallelism: input.parallelism,
    payloadBytes: input.payloadBytes,
    roundTripMs: 0,
    signedUrlPadding: input.signedUrlPadding,
    strategy: "sandbox-batch-parallel",
  });
  try {
    const protectedParent = dirname(hostile.target(0));
    await mkdir(dirname(protectedParent), { recursive: true });
    await symlink(hostile.sources, protectedParent);
    const failures = await materialize(
      hostile.session,
      hostile.downloads,
      "sandbox-batch-parallel",
      input.parallelism,
    );
    return {
      repairs,
      symlinkedParentRejected: failures === 1,
      symlinkStillPresent: (await lstat(protectedParent)).isSymbolicLink(),
      passed: repairs.every((item) => item.passed) && failures === 1,
    };
  } finally {
    await hostile.close();
  }
}

async function materialize(
  session: Parameters<typeof materializeSandboxFileDownloads>[0],
  downloads: SandboxFileDownload[],
  strategy: Strategy,
  materializationParallelism: number,
): Promise<number> {
  if (strategy === "host-serial") {
    return (await materializeSandboxFileDownloads(session, downloads)).failures.length;
  }
  if (strategy === "host-parallel") {
    return (
      await materializeSandboxFileDownloads(session, downloads, {
        maxConcurrency: materializationParallelism,
      })
    ).failures.length;
  }
  if (downloads.length === 0) return 0;
  const command = sandboxBatchCommand(
    downloads,
    strategy === "sandbox-batch-parallel" ? materializationParallelism : 1,
  );
  const result = await session.exec!({
    cmd: command,
    workdir: "/workspace",
    yieldTimeMs: 300_000,
    maxOutputTokens: 20_000,
  });
  const text = resultText(result);
  const markers = new Map<number, "ok" | "failed">();
  for (const match of text.matchAll(/^__OG_FILE_(OK|FAILED)__:(\d+)$/gm)) {
    markers.set(Number.parseInt(match[2]!, 10), match[1] === "OK" ? "ok" : "failed");
  }
  let failures = 0;
  for (let index = 0; index < downloads.length; index += 1) {
    if (markers.get(index) !== "ok") failures += 1;
  }
  return failures;
}

function sandboxBatchCommand(downloads: SandboxFileDownload[], commandParallelism: number): string {
  const lines = [
    "set +x",
    "set -u",
    "verify_attachment() {",
    '  candidate="$1"; expected_size="$2"; expected_sha="$3"',
    '  [ -f "$candidate" ] && [ ! -L "$candidate" ] || return 1',
    '  if [ "$expected_size" != "-" ]; then',
    "    actual_size=$(wc -c < \"$candidate\" | tr -d '[:space:]')",
    '    [ "$actual_size" = "$expected_size" ] || return 1',
    "  fi",
    '  if [ "$expected_sha" != "-" ]; then',
    "    if command -v sha256sum >/dev/null 2>&1; then",
    "      actual_sha=$(sha256sum \"$candidate\" | awk '{print $1}')",
    "    elif command -v shasum >/dev/null 2>&1; then",
    "      actual_sha=$(shasum -a 256 \"$candidate\" | awk '{print $1}')",
    "    else",
    '      echo "No SHA-256 verifier is available for attachment delivery" >&2',
    "      return 2",
    "    fi",
    '    [ "$actual_sha" = "$expected_sha" ] || return 1',
    "  fi",
    "  return 0",
    "}",
    "materialize_one() {",
    '  target="$1"; url="$2"; expected_size="$3"; expected_sha="$4"',
    '  if [ -L "$target" ]; then echo "Refusing symlinked attachment target" >&2; return 73; fi',
    '  if [ -e "$target" ] && [ ! -f "$target" ]; then echo "Refusing non-file attachment target" >&2; return 73; fi',
    '  if verify_attachment "$target" "$expected_size" "$expected_sha"; then',
    "    :",
    "  else",
    '    tmp=$(mktemp "${target}.opengeni-download.XXXXXX") || return $?',
    "    trap 'rm -f -- \"$tmp\"' EXIT HUP INT TERM",
    '    curl --fail --location --silent --show-error --connect-timeout 10 --max-time 120 --retry 3 --retry-delay 1 --retry-max-time 180 --output "$tmp" "$url" || return $?',
    '    if ! verify_attachment "$tmp" "$expected_size" "$expected_sha"; then echo "Downloaded attachment failed size or SHA-256 verification" >&2; return 74; fi',
    '    mv -f -- "$tmp" "$target" || return $?',
    "    trap - EXIT HUP INT TERM",
    "  fi",
    '  chmod a-w -- "$target" 2>/dev/null || true',
    "}",
  ];

  for (const directory of uniqueTargetDirectories(downloads)) {
    let current = "";
    for (const segment of directory.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      lines.push(
        `if [ -L ${shellQuote(current)} ]; then echo ${shellQuote(`Refusing symlinked attachment directory: ${current}`)} >&2; exit 73; fi`,
        `mkdir -p -- ${shellQuote(current)}`,
      );
    }
  }

  lines.push("batch_failed=0");
  for (let start = 0; start < downloads.length; start += commandParallelism) {
    const chunk = downloads.slice(start, start + commandParallelism);
    if (commandParallelism === 1) {
      const index = start;
      lines.push(markerInvocation(downloads[index]!, index, false));
      continue;
    }
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const index = start + offset;
      lines.push(markerInvocation(chunk[offset]!, index, true), `og_pid_${offset}=$!`);
    }
    for (let offset = 0; offset < chunk.length; offset += 1) {
      lines.push(`wait "$og_pid_${offset}" || batch_failed=1`);
    }
  }
  lines.push('exit "$batch_failed"');
  return lines.join("\n");
}

function markerInvocation(
  download: SandboxFileDownload,
  index: number,
  background: boolean,
): string {
  const target = posix.join(download.mountPath, download.filename);
  const size = download.sizeBytes === undefined ? "-" : String(download.sizeBytes);
  const sha = download.sha256 ?? "-";
  const body = `if materialize_one ${shellQuote(target)} ${shellQuote(download.url)} ${shellQuote(size)} ${shellQuote(sha)}; then printf '%s\\n' ${shellQuote(`__OG_FILE_OK__:${index}`)}; else printf '%s\\n' ${shellQuote(`__OG_FILE_FAILED__:${index}`)}; exit 1; fi`;
  return background ? `( ${body} ) &` : `${body} || batch_failed=1`;
}

function uniqueTargetDirectories(downloads: SandboxFileDownload[]): string[] {
  return [
    ...new Set(
      downloads.map((download) => posix.dirname(posix.join(download.mountPath, download.filename))),
    ),
  ];
}

async function createFixture(input: {
  count: number;
  payloadBytes: number;
  roundTripMs: number;
  signedUrlPadding: number;
  strategy: Strategy;
}) {
  const root = await mkdtemp(join(tmpdir(), "opengeni-connected-batch-"));
  const workspace = join(root, "workspace");
  const sources = join(root, "sources");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(sources, { recursive: true })]);
  const expected = new Map<number, Uint8Array>();
  const downloads: SandboxFileDownload[] = [];
  for (let index = 0; index < input.count; index += 1) {
    const content = new TextEncoder().encode(
      `${String(index).padStart(4, "0")}:${"x".repeat(Math.max(0, input.payloadBytes - 5))}`,
    );
    const source = join(sources, `source-${index}.txt`);
    await writeFile(source, content);
    expected.set(index, content);
    const baseUrl = pathToFileURL(source).href;
    downloads.push({
      fileId: `file-${index}`,
      mountPath: `.opengeni/files/file-${index}`,
      filename: `input-${index}.txt`,
      url: `${baseUrl}?sig=${"s".repeat(input.signedUrlPadding)}`,
      sizeBytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }

  let active = 0;
  let maxActive = 0;
  let commandCount = 0;
  let commandBytes = 0;
  const outputs: string[] = [];
  const session = {
    exec: async ({ cmd }: { cmd: string }) => {
      commandCount += 1;
      commandBytes += Buffer.byteLength(cmd);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (input.roundTripMs > 0) await Bun.sleep(input.roundTripMs);
        const process = Bun.spawn(["/bin/sh", "-c", cmd], {
          cwd: workspace,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]);
        const output = `${stdout}${stderr}`;
        outputs.push(output);
        return { stdout, stderr, output, exitCode };
      } finally {
        active -= 1;
      }
    },
  } as Parameters<typeof materializeSandboxFileDownloads>[0];
  const target = (index: number) =>
    join(workspace, ".opengeni", "files", `file-${index}`, `input-${index}.txt`);
  return {
    close: async () => await rm(root, { recursive: true, force: true }),
    commandBytes: () => commandBytes,
    commandCount: () => commandCount,
    downloads,
    maxHostCommands: () => maxActive,
    outputs: () => outputs,
    resetCommandStats: () => {
      commandCount = 0;
      commandBytes = 0;
      maxActive = active;
      outputs.length = 0;
    },
    session,
    sources,
    target,
    assertExact: async () => {
      for (let index = 0; index < input.count; index += 1) {
        const actual = await readFile(target(index));
        const wanted = expected.get(index);
        if (!wanted || !actual.equals(wanted)) throw new Error(`file ${index} was not preserved`);
        const mode = (await lstat(target(index))).mode & 0o222;
        if (mode !== 0) throw new Error(`file ${index} remained writable`);
      }
    },
  };
}

function commandSizeProjection(input: {
  parallelism: number;
  payloadBytes: number;
  signedUrlPadding: number;
}) {
  const countsToProject = [1, 5, 20, 50, 100, 250, 500, 1_000];
  return countsToProject.map((count) => {
    const downloads = Array.from(
      { length: count },
      (_, index): SandboxFileDownload => ({
        fileId: `file-${index}`,
        mountPath: `.opengeni/files/file-${index}`,
        filename: `input-${index}.txt`,
        url: `https://storage.invalid/object-${index}?sig=${"s".repeat(input.signedUrlPadding)}`,
        sizeBytes: input.payloadBytes,
        sha256: "a".repeat(64),
      }),
    );
    const serial = Buffer.byteLength(sandboxBatchCommand(downloads, 1));
    const parallel = Buffer.byteLength(sandboxBatchCommand(downloads, input.parallelism));
    return { count, serialBytes: serial, parallelBytes: parallel };
  });
}

function summarize(items: Measurement[]) {
  const groups = new Map<string, Measurement[]>();
  for (const item of items) {
    const key = `${item.count}:${item.roundTripMs}:${item.strategy}:${item.phase}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const elapsed = group.map((item) => item.elapsedMs).sort((left, right) => left - right);
    return {
      count: first.count,
      phase: first.phase,
      roundTripMs: first.roundTripMs,
      strategy: first.strategy,
      commandCount: distribution(group.map((item) => item.commandCount)),
      commandBytes: distribution(group.map((item) => item.commandBytes)),
      maxHostCommands: Math.max(...group.map((item) => item.maxHostCommands)),
      failures: group.reduce((total, item) => total + item.failures, 0),
      elapsedMs: distribution(elapsed),
    };
  });
}

function distribution(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (value: number) =>
    ordered[Math.min(ordered.length - 1, Math.ceil(value * ordered.length) - 1)]!;
  return {
    samples: ordered.length,
    min: ordered[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: ordered.at(-1)!,
  };
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  return [record.stdout, record.stderr, record.output]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function stringArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function integerArgument(name: string, fallback: number): number {
  const value = stringArgument(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function integerListArgument(name: string, fallback: number[]): number[] {
  const value = stringArgument(name);
  if (value === undefined) return fallback;
  const parsed = value.split(",").map((item) => Number.parseInt(item, 10));
  if (parsed.length === 0 || parsed.some((item) => !Number.isSafeInteger(item) || item < 0)) {
    throw new Error(`${name} must be a comma-separated list of non-negative integers`);
  }
  return [...new Set(parsed)];
}
