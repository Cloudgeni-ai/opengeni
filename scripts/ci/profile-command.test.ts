import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LiveResourceLog,
  parseGnuTime,
  parseResourceCounters,
  parseResourceInteger,
  readResourceFile,
  resolveResourceScope,
  type LiveResourceSnapshot,
} from "./profile-command";

function snapshot(overrides: Partial<LiveResourceSnapshot> = {}): LiveResourceSnapshot {
  return {
    scope: "cgroup2",
    currentBytes: 1024,
    kernelPeakBytes: 4096,
    limitBytes: 8192,
    limitUnlimited: false,
    hostTotalBytes: 16384,
    hostAvailableBytes: 8192,
    hierarchical: [0, 0, 0, 0, 0],
    local: [0, 0, 0, 0, 0],
    ...overrides,
  };
}

type ResourceRecord = {
  seq: number;
  elapsedMs: number;
  event: string;
  scope: string;
  memory: { observedPeakBytes: number | null; kernelPeakBytes: number | null };
  events: {
    hierarchical: (number | null)[];
    local: (number | null)[];
    deltaHierarchical: (number | null)[];
    deltaLocal: (number | null)[];
    hierarchicalReset: boolean;
    localReset: boolean;
    scopeChanged: boolean;
  };
  termination: {
    timedOut: boolean;
    forwardedSignal: string | null;
    observedExitCode: number | null;
  };
};
function resourceRecords(text: string): ResourceRecord[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("[profile-resource] "))
    .map((line) => JSON.parse(line.slice("[profile-resource] ".length)) as ResourceRecord);
}

describe("bounded live resource diagnostics", () => {
  test("strict counters exclude unknown keys and reject ambiguous or oversized values", () => {
    expect(
      parseResourceCounters(
        "high 1\nmax 2\noom 3\noom_kill 4\noom_group_kill 5\nfixture_secret value",
      ),
    ).toEqual([1, 2, 3, 4, 5]);
    for (const text of [
      null,
      "oom 1\noom 2",
      "oom -1",
      "oom 1e3",
      "oom 1 extra",
      "oom 9007199254740992",
      "oom 2\n" + "x".repeat(4096),
    ]) {
      expect(parseResourceCounters(text)).toEqual([null, null, null, null, null]);
    }
    for (const text of [null, "max", "", "01", "-1", "1e3", "9007199254740992"])
      expect(parseResourceInteger(text)).toBeNull();
    expect(parseResourceInteger("42\n")).toBe(42);
  });

  test("scope follows exact membership and matching mount root, refusing ambiguity and traversal", () => {
    const root = "10 1 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n";
    expect(resolveResourceScope("0::/jobs/example\n", root)).toBe("/sys/fs/cgroup/jobs/example");
    const nested = "11 1 0:1 /jobs /sys/fs/cgroup rw - cgroup2 cgroup rw\n";
    expect(resolveResourceScope("0::/jobs/example", nested)).toBe("/sys/fs/cgroup/example");
    expect(resolveResourceScope("0::/jobs/example", root + nested)).toBe("/sys/fs/cgroup/example");
    for (const membership of [
      "0::/jobs/../secret",
      "0::/jobs/./example",
      "0::/jobs//example",
      "0::/jobs/deleted\n0::/other",
      "2:memory:/jobs/example",
      "0::/" + "x".repeat(16384),
    ]) {
      expect(resolveResourceScope(membership, root)).toBeNull();
    }
    expect(resolveResourceScope("0::/jobs/example", root + root)).toBeNull();
    expect(resolveResourceScope("0::/elsewhere", nested)).toBeNull();
    expect(resolveResourceScope("0::/jobs", root.replace("cgroup2", "cgroup"))).toBeNull();
  });

  test("numeric files are bounded, read-only, and never follow a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-resource-read-"));
    try {
      const target = join(root, "counter");
      writeFileSync(target, "8\n");
      expect(readResourceFile(target)).toBe("8\n");
      symlinkSync(target, join(root, "redirect"));
      expect(readResourceFile(join(root, "redirect"))).toBeNull();
      writeFileSync(target, "1".repeat(4097));
      expect(readResourceFile(target)).toBeNull();
      expect(readFileSync(target, "utf8")).toBe("1".repeat(4097));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("counter decreases invalidate deltas even when still above the initial baseline", () => {
    let now = 0;
    let value = snapshot({ hierarchical: [10, 0, 0, 0, 0] });
    const lines: string[] = [];
    const log = new LiveResourceLog(
      () => value,
      (line) => {
        lines.push(line);
        return true;
      },
      () => now,
    );
    log.emit("start");
    value = snapshot({ hierarchical: [50, 1, 0, 0, 0], local: [1, 0, 0, 0, 0] });
    now = 1000;
    log.sample();
    value = snapshot({ hierarchical: [40, 1, 0, 0, 0], local: [0, 0, 0, 0, 0] });
    now = 2000;
    log.sample();
    value = snapshot({ hierarchical: [60, 1, 0, 0, 0], local: [2, 0, 0, 0, 0] });
    now = 3000;
    log.sample();
    const records = resourceRecords(lines.join(""));
    expect(records[1]!.events.deltaHierarchical[0]).toBe(40);
    expect(records[2]!.events.hierarchical[0]).toBe(40);
    expect(records[2]!.events.hierarchicalReset).toBe(true);
    expect(records[2]!.events.localReset).toBe(true);
    expect(records[3]!.events.deltaHierarchical).toEqual([null, null, null, null, null]);
    expect(records[3]!.events.deltaLocal).toEqual([null, null, null, null, null]);
    expect(records[0]!.memory.kernelPeakBytes).toBe(4096);
    expect(records[0]!.memory.observedPeakBytes).toBe(1024);
    value = snapshot({ scope: "unavailable" });
    log.emit("child-close");
    expect(resourceRecords(lines.at(-1)!)[0]!.events.scopeChanged).toBe(true);
  });

  test("rate, full-record and total budgets reserve lifecycle capacity", () => {
    let now = 0;
    const lines: string[] = [];
    const log = new LiveResourceLog(
      () => snapshot(),
      (line) => {
        lines.push(line);
        return true;
      },
      () => now,
    );
    log.emit("start");
    for (let step = 0; step < 40; step += 1) {
      now += 25;
      log.sample();
    }
    expect(lines).toHaveLength(2);
    for (let step = 0; step < 1200; step += 1) {
      now += 1000;
      log.sample();
    }
    log.emit("timeout", { timedOut: true });
    log.emit("signal", { forwardedSignal: "SIGTERM", sentSignal: "SIGTERM" });
    log.emit("child-close", { observedExitCode: 143 });
    log.emit("group-settled", { processGroupSettled: true });
    const records = resourceRecords(lines.join(""));
    expect(records.filter((record) => record.event === "limit")).toHaveLength(1);
    expect(records.at(-1)!.event).toBe("group-settled");
    expect(records.at(-1)!.termination).toMatchObject({
      timedOut: true,
      forwardedSignal: "SIGTERM",
      observedExitCode: 143,
    });
    expect(lines.every((line) => Buffer.byteLength(line) <= 1024)).toBe(true);
    expect(Buffer.byteLength(lines.join(""))).toBeLessThanOrEqual(1024 * 1024);
    for (let step = 0; step < 128; step += 1) log.emit("signal");
    expect(lines.length).toBeLessThanOrEqual(1024);
    expect(resourceRecords(lines.join("")).every((record, index) => record.seq === index)).toBe(
      true,
    );
  });

  test("backpressure and thrown I/O disable only telemetry; no unbounded queue or raw exception", () => {
    const secret = "generated-fixture-private-value";
    let writes = 0;
    let reads = 0;
    const log = new LiveResourceLog(
      () => {
        reads += 1;
        return snapshot();
      },
      () => {
        writes += 1;
        return false;
      },
      () => 0,
    );
    log.emit("start");
    for (let index = 0; index < 10000; index += 1) log.emit("signal");
    expect(reads).toBe(1);
    expect(writes).toBe(1);
    const lines: string[] = [];
    const failed = new LiveResourceLog(
      () => {
        throw new Error(secret);
      },
      (line) => {
        lines.push(line);
        return true;
      },
      () => 0,
    );
    expect(() => failed.emit("start")).not.toThrow();
    failed.emit("child-close");
    expect(lines).toHaveLength(1);
    expect(lines.join("")).not.toContain(secret);
    expect(resourceRecords(lines.join(""))[0]!.event).toBe("disabled");
    const throwing = new LiveResourceLog(
      () => snapshot(),
      () => {
        throw new Error(secret);
      },
      () => 0,
    );
    expect(() => throwing.emit("start")).not.toThrow();
  });

  test("only closed numeric fields enter the diagnostic record", () => {
    const secret = "generated-fixture-private-value";
    const lines: string[] = [];
    const hostile = { ...snapshot(), path: `/example/${secret}`, command: secret, token: secret };
    const log = new LiveResourceLog(
      () => hostile,
      (line) => {
        lines.push(line);
        return true;
      },
      () => 0,
    );
    log.emit("start", { forwardedSignal: secret });
    expect(lines.join("")).not.toContain(secret);
    expect(resourceRecords(lines.join(""))[0]!.termination.forwardedSignal).toBeNull();
  });

  test("an abruptly killed observer leaves a parseable prefix without manufactured completion", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "opengeni-resource-prefix-"));
    const ready = join(root, "ready");
    const output = join(root, "result.json");
    const script = join(root, "child.sh");
    writeFileSync(
      script,
      '#!/bin/sh\nexec >/dev/null 2>&1\nprintf "%s %s\\n" "$$" "$(ps -o pgid= -p $$)" > "$1"\nexec sleep 60\n',
    );
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--live-resources",
        "--name",
        "prefix",
        "--output",
        output,
        "--",
        "sh",
        script,
        ready,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const text = new Response(child.stdout).text();
    let killed = false;
    try {
      for (let attempt = 0; attempt < 80 && !existsSync(ready); attempt += 1) await Bun.sleep(25);
      expect(existsSync(ready)).toBe(true);
      await Bun.sleep(1100);
      child.kill("SIGKILL");
      killed = true;
      expect(await child.exited).not.toBe(0);
      expect(existsSync(output)).toBe(false);
    } finally {
      if (!killed) {
        child.kill("SIGTERM");
        await child.exited;
      }
      if (existsSync(ready)) {
        const [pid, group] = readFileSync(ready, "utf8").trim().split(/\s+/u).map(Number);
        expect(Number.isSafeInteger(pid) && pid! > 1).toBe(true);
        expect(Number.isSafeInteger(group) && group! > 1).toBe(true);
        try {
          process.kill(-group!, "SIGKILL");
        } catch {
          /* Test-owned group already settled. */
        }
        await expectProcessGone(pid!);
      }
      rmSync(root, { recursive: true, force: true });
    }
    const records = resourceRecords(await text);
    expect(records[0]!.event).toBe("start");
    expect(records.some((record) => record.event === "sample")).toBe(true);
    expect(records.some((record) => ["child-close", "group-settled"].includes(record.event))).toBe(
      false,
    );
  });

  test("flag off retains default stdout; workflow opts in only for typecheck", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-resource-default-"));
    try {
      const child = Bun.spawn(
        [
          "bun",
          "scripts/ci/profile-command.ts",
          "--name",
          "default",
          "--output",
          join(root, "result.json"),
          "--",
          "sh",
          "-c",
          "exit 0",
        ],
        { stdout: "pipe", stderr: "ignore" },
      );
      const text = new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(resourceRecords(await text)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow.match(/--live-resources/gu)).toHaveLength(1);
    const typecheck = workflow
      .split("- name: Profile impacted TypeScript 7 projects")[1]!
      .split("- name: Run exactly the explained source guards")[0]!;
    expect(typecheck).toContain("timeout-minutes: 11");
    expect(typecheck).toContain("--timeout-seconds 600\n          --live-resources");
  });
});

async function expectProcessGone(pid: number): Promise<void> {
  expect(Number.isSafeInteger(pid)).toBe(true);
  expect(pid).toBeGreaterThan(0);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(25);
  }
  expect(() => process.kill(pid, 0)).toThrow();
}

describe("secret-safe command profile parsing", () => {
  test("parses GNU time CPU, RSS, and filesystem counters", () => {
    expect(
      parseGnuTime(`
        User time (seconds): 1.25
        System time (seconds): 0.50
        Maximum resident set size (kbytes): 2048
        File system inputs: 3
        File system outputs: 4
      `),
    ).toEqual({
      userSeconds: 1.25,
      systemSeconds: 0.5,
      maxRssBytes: 2 * 1024 * 1024,
      fileSystemInputs: 3,
      fileSystemOutputs: 4,
    });
  });

  test("missing or malformed fields remain explicit nulls", () => {
    expect(parseGnuTime("Maximum resident set size (kbytes): nope\n")).toEqual({
      userSeconds: null,
      systemSeconds: null,
      maxRssBytes: null,
      fileSystemInputs: null,
      fileSystemOutputs: null,
    });
  });

  test("failure still writes terminal evidence", async () => {
    const output = join(mkdtempSync(join(tmpdir(), "opengeni-profile-failure-")), "result.json");
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--live-resources",
        "--name",
        "failure",
        "--output",
        output,
        "--",
        "sh",
        "-c",
        "exit 7",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await child.exited).toBe(7);
    const profile = JSON.parse(readFileSync(output, "utf8")) as {
      exitCode: number;
    };
    expect(profile.exitCode).toBe(7);
  });

  test("deadline terminates the command group and records a timeout", async () => {
    const output = join(mkdtempSync(join(tmpdir(), "opengeni-profile-timeout-")), "result.json");
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--live-resources",
        "--name",
        "timeout",
        "--output",
        output,
        "--timeout-seconds",
        "1",
        "--",
        "sleep",
        "30",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await child.exited).not.toBe(0);
    const profile = JSON.parse(readFileSync(output, "utf8")) as {
      timedOut: boolean;
      timeoutSeconds: number;
      forwardedSignal: string | null;
    };
    expect(profile.timedOut).toBe(true);
    expect(profile.timeoutSeconds).toBe(1);
    expect(profile.forwardedSignal).toBe("SIGTERM");
  });

  test("a TERM-trapping command cannot turn a timeout into success", async () => {
    if (process.platform === "win32") return;
    const output = join(
      mkdtempSync(join(tmpdir(), "opengeni-profile-trapped-timeout-")),
      "result.json",
    );
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--live-resources",
        "--name",
        "trapped-timeout",
        "--output",
        output,
        "--timeout-seconds",
        "1",
        "--",
        "sh",
        "-c",
        "trap 'exit 0' TERM; while :; do sleep 1; done",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await child.exited).toBe(124);
    const profile = JSON.parse(readFileSync(output, "utf8")) as {
      exitCode: number;
      timedOut: boolean;
    };
    expect(profile.exitCode).toBe(124);
    expect(profile.timedOut).toBe(true);
  });

  test("cancellation is forwarded and recorded", async () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-profile-cancel-"));
    const output = join(root, "result.json");
    const ready = join(root, "ready");
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--live-resources",
        "--name",
        "cancel",
        "--output",
        output,
        "--",
        "sh",
        "-c",
        `echo ready > ${JSON.stringify(ready)}; exec sleep 30`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    for (let attempt = 0; attempt < 40 && !existsSync(ready); attempt += 1) {
      await Bun.sleep(25);
    }
    expect(existsSync(ready)).toBe(true);
    child.kill("SIGTERM");
    expect(await child.exited).not.toBe(0);
    const profile = JSON.parse(readFileSync(output, "utf8")) as {
      exitCode: number;
      forwardedSignal: string | null;
    };
    expect(profile.exitCode).not.toBe(0);
    expect(profile.forwardedSignal).toBe("SIGTERM");
  });

  test("cancellation terminates the complete descendant process group", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "opengeni-profile-tree-cancel-"));
    const output = join(root, "result.json");
    const pidFile = join(root, "descendant.pid");
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--live-resources",
        "--name",
        "tree-cancel",
        "--output",
        output,
        "--",
        "sh",
        "-c",
        `sleep 30 & echo $! > ${pidFile}.tmp; mv ${pidFile}.tmp ${pidFile}; wait`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    for (let attempt = 0; attempt < 40 && !existsSync(pidFile); attempt += 1) {
      await Bun.sleep(25);
    }
    expect(existsSync(pidFile)).toBe(true);
    const descendantPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    child.kill("SIGTERM");
    expect(await child.exited).not.toBe(0);
    await expectProcessGone(descendantPid);
    const profile = JSON.parse(readFileSync(output, "utf8")) as {
      forwardedSignal: string | null;
    };
    expect(profile.forwardedSignal).toBe("SIGTERM");
  });

  test("cancellation escalates after the leader exits while a descendant survives TERM", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "opengeni-profile-leader-exit-"));
    const output = join(root, "result.json");
    const pidFile = join(root, "descendant.pid");
    const script = join(root, "leader-exits.sh");
    writeFileSync(
      script,
      `#!/usr/bin/env bash
set -eu
trap 'exit 0' TERM
bash -eu -c '
  trap "" TERM
  # Publish readiness only after TERM is ignored and the PID is fully written.
  echo "$$" > "$1.tmp"
  mv "$1.tmp" "$1"
  while :; do sleep 1; done
' bash "$1" &
wait
`,
    );
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--live-resources",
        "--name",
        "leader-exits",
        "--output",
        output,
        "--",
        "bash",
        script,
        pidFile,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, OPENGENI_PROFILE_KILL_GRACE_MS: "100" },
      },
    );
    for (let attempt = 0; attempt < 80 && !existsSync(pidFile); attempt += 1) {
      await Bun.sleep(25);
    }
    expect(existsSync(pidFile)).toBe(true);
    const descendantPid = Number(readFileSync(pidFile, "utf8").trim());
    child.kill("SIGTERM");
    expect(await child.exited).not.toBe(0);
    await expectProcessGone(descendantPid);
    const profile = JSON.parse(readFileSync(output, "utf8")) as {
      exitCode: number;
      forwardedSignal: string | null;
    };
    expect(profile.exitCode).not.toBe(0);
    expect(profile.forwardedSignal).toBe("SIGTERM");
  });

  test("a successful leader cannot leave an unprofiled descendant behind", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "opengeni-profile-orphan-"));
    const output = join(root, "result.json");
    const pidFile = join(root, "descendant.pid");
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--live-resources",
        "--name",
        "orphan",
        "--output",
        output,
        "--",
        "sh",
        "-c",
        'sleep 300 >/dev/null 2>&1 & echo "$!" > "$1"',
        "sh",
        pidFile,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        env: {
          ...process.env,
          OPENGENI_PROFILE_KILL_GRACE_MS: "100",
          OPENGENI_PROFILE_NATURAL_SETTLE_MS: "100",
        },
      },
    );
    expect(await child.exited).toBe(70);
    const descendantPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(() => process.kill(descendantPid, 0)).toThrow();
    const profile = JSON.parse(readFileSync(output, "utf8")) as {
      exitCode: number;
      observedExitCode: number;
      processGroupObservedAfterLeaderExit: boolean;
      processGroupSettledNaturally: boolean | null;
      processGroupLeakDetected: boolean;
      processGroupSettled: boolean;
    };
    expect(profile.exitCode).toBe(70);
    expect(profile.observedExitCode).toBe(0);
    expect(profile.processGroupObservedAfterLeaderExit).toBe(true);
    expect(profile.processGroupSettledNaturally).toBe(false);
    expect(profile.processGroupLeakDetected).toBe(true);
    expect(profile.processGroupSettled).toBe(true);
  });

  test("a successful leader permits bounded natural descendant teardown", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "opengeni-profile-natural-settle-"));
    const output = join(root, "result.json");
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--live-resources",
        "--name",
        "natural-settle",
        "--output",
        output,
        "--",
        "sh",
        "-c",
        "sleep 0.5 >/dev/null 2>&1 &",
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, OPENGENI_PROFILE_NATURAL_SETTLE_MS: "1000" },
      },
    );
    expect(await child.exited).toBe(0);
    const profile = JSON.parse(readFileSync(output, "utf8")) as {
      exitCode: number;
      observedExitCode: number;
      processGroupObservedAfterLeaderExit: boolean;
      processGroupSettledNaturally: boolean | null;
      processGroupLeakDetected: boolean;
      processGroupSettled: boolean;
    };
    expect(profile.exitCode).toBe(0);
    expect(profile.observedExitCode).toBe(0);
    expect(profile.processGroupObservedAfterLeaderExit).toBe(true);
    expect(profile.processGroupSettledNaturally).toBe(true);
    expect(profile.processGroupLeakDetected).toBe(false);
    expect(profile.processGroupSettled).toBe(true);
  });

  test("cancellation escalates against a TERM-ignoring descendant group", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "opengeni-profile-stubborn-cancel-"));
    const output = join(root, "result.json");
    const ready = join(root, "ready");
    const child = Bun.spawn(
      [
        "bun",
        "scripts/ci/profile-command.ts",
        "--live-resources",
        "--name",
        "stubborn-cancel",
        "--output",
        output,
        "--",
        "sh",
        "-c",
        `trap '' TERM; touch ${ready}; while :; do sleep 1; done`,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, OPENGENI_PROFILE_KILL_GRACE_MS: "100" },
      },
    );
    for (let attempt = 0; attempt < 80 && !existsSync(ready); attempt += 1) {
      await Bun.sleep(25);
    }
    expect(existsSync(ready)).toBe(true);
    child.kill("SIGTERM");
    expect(await child.exited).not.toBe(0);
    const profile = JSON.parse(readFileSync(output, "utf8")) as {
      exitCode: number;
      forwardedSignal: string | null;
    };
    expect(profile.exitCode).not.toBe(0);
    expect(profile.forwardedSignal).toBe("SIGTERM");
  });
});
