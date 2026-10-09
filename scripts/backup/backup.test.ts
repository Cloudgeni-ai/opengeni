import { test, expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  checkAge,
  nextIndex,
  obsoleteManifests,
  parseConfig,
  validateIndex,
  weekStart,
  type BackupConfig,
  type BackupIndex,
  type Manifest,
} from "./config";

const config: BackupConfig = {
  remote: "fixture:bucket",
  stateDirectory: "/tmp/fixture-state",
  ageIdentityFile: "/tmp/fixture-key",
  ageRecipient: "fixture",
  timeZone: "Europe/Oslo",
  databases: [
    { name: "app", service: "app" },
    { name: "workflow", service: "workflow" },
  ],
  rolesService: "app",
};
function manifest(date: string): Manifest {
  const run = `runs/${date.replace(/[-:]/g, "")}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
  return {
    run,
    startedAt: date,
    finishedAt: date,
    files: ["app.dump.age", "workflow.dump.age", "roles.sql.age"].map((name) => ({
      key: `${run}/${name}`,
      bytes: 100,
      sha256: "a".repeat(64),
    })),
  };
}
test("bootstrap shares one real point; nightly preserves weekly; Sunday promotes", () => {
  const seed = nextIndex(null, manifest("2026-10-04T01:15:00Z"), config);
  expect(seed.nightly).toEqual(seed.weekly);
  const monday = nextIndex(seed, manifest("2026-10-05T01:15:00Z"), config);
  expect(obsoleteManifests(seed, monday)).toEqual([]);
  const tuesday = nextIndex(monday, manifest("2026-10-06T01:15:00Z"), config);
  expect(tuesday.weekly).toEqual(seed.weekly);
  expect(obsoleteManifests(monday, tuesday)).toEqual([monday.nightly]);
  const sunday = nextIndex(tuesday, manifest("2026-10-11T01:15:00Z"), config);
  expect(sunday.nightly).toEqual(sunday.weekly);
  expect(obsoleteManifests(tuesday, sunday)).toHaveLength(2);
});
test("weekly catches up after a missed Sunday and respects timezone/DST", () => {
  const old = nextIndex(null, manifest("2026-10-04T01:15:00Z"), config);
  expect(nextIndex(old, manifest("2026-10-12T01:15:00Z"), config).week).toBe("2026-10-11");
  expect(weekStart(new Date("2026-10-10T21:59:00Z"), config.timeZone)).toBe("2026-10-04");
  expect(weekStart(new Date("2026-10-10T22:00:00Z"), config.timeZone)).toBe("2026-10-11");
  expect(weekStart(new Date("2026-11-07T23:00:00Z"), config.timeZone)).toBe("2026-11-08");
});
test("reject invalid config, incomplete manifests, traversal and duplicate entries", () => {
  for (const patch of [
    { remote: "--config=/secret" },
    { remote: "x:../other" },
    { timeZone: "bad/zone" },
    { stateDirectory: "/" },
    { databases: [config.databases[0], config.databases[0]] },
  ]) {
    expect(() => parseConfig({ ...config, ...patch })).toThrow();
  }
  const m = manifest("2026-10-09T01:15:00Z");
  expect(() => nextIndex(null, { ...m, files: m.files.slice(0, 1) }, config)).toThrow();
  expect(() => nextIndex(null, { ...m, run: "runs/../../unrelated" }, config)).toThrow();
  expect(() =>
    nextIndex(null, { ...m, files: [m.files[0]!, m.files[0]!, m.files[0]!] }, config),
  ).toThrow();
});
test("reject stale replacement and stale/future recovery points", () => {
  const old = nextIndex(null, manifest("2026-10-04T01:15:00Z"), config);
  expect(() => nextIndex(old, manifest("2026-10-03T01:15:00Z"), config)).toThrow();
  const index = nextIndex(old, manifest("2026-10-10T01:15:00Z"), config);
  checkAge(index, new Date("2026-10-10T12:00:00Z"));
  expect(() => checkAge(index, new Date("2026-10-12T12:00:00Z"))).toThrow();
  expect(() => checkAge(index, new Date("2026-10-09T12:00:00Z"))).toThrow();
  expect(() => validateIndex({ ...index, week: "2026-09-27" }, config)).toThrow();
});
test("full CLI: failures preserve points, ambiguous publication recovers, restore is isolated", () => {
  const root = mkdtempSync(join(tmpdir(), "opengeni-backup-test-"));
  try {
    const bin = join(root, "bin"),
      remote = join(root, "remote"),
      state = join(root, "state");
    for (const dir of [bin, remote, state]) mkdirSync(dir);
    for (const name of ["rclone", "age", "pg_dump", "pg_dumpall", "pg_restore", "psql"]) {
      writeFileSync(
        join(bin, name),
        `#!${process.execPath}\n${readFileSync(new URL("./fixtures/tool.ts", import.meta.url), "utf8")}`,
      );
      chmodSync(join(bin, name), 0o755);
    }
    writeFileSync(join(root, "config.json"), JSON.stringify({ ...config, stateDirectory: state }));
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_REMOTE: remote };
    const invoke = (mode: string, failure = "", extra: string[] = []) =>
      spawnSync(
        process.execPath,
        [
          join(import.meta.dir, "../backup.ts"),
          mode,
          "--config",
          join(root, "config.json"),
          ...extra,
        ],
        { env: { ...env, MOCK_FAILURE: failure }, encoding: "utf8" },
      );
    const first = invoke("run");
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    const initial = readFileSync(join(remote, "CURRENT.json"), "utf8");
    for (const failure of ["dump", "upload", "decrypt", "restore", "checksum"]) {
      expect(invoke("run", failure).status).not.toBe(0);
      expect(readFileSync(join(remote, "CURRENT.json"), "utf8")).toBe(initial);
      expect(existsSync(join(state, "current.dump.age"))).toBe(false);
    }
    expect(invoke("check").status).toBe(0);
    expect(invoke("verify").status).toBe(0);
    expect(invoke("run", "index-ambiguous").status).not.toBe(0);
    expect(existsSync(join(state, "pending.json"))).toBe(true);
    const second = readFileSync(join(remote, "CURRENT.json"), "utf8");
    expect(second).not.toBe(initial);
    expect(invoke("check").status).toBe(0);
    expect(existsSync(join(state, "pending.json"))).toBe(false);
    expect(invoke("run").status).toBe(0);
    const third = JSON.parse(readFileSync(join(remote, "CURRENT.json"), "utf8")) as BackupIndex;
    expect(third.weekly.run).toBe((JSON.parse(initial) as BackupIndex).weekly.run);
    expect(
      existsSync(join(remote, (JSON.parse(second) as BackupIndex).nightly.files[0]!.key)),
    ).toBe(false);
    const restoreArgs = [
      "--slot",
      "weekly",
      "--database",
      "app",
      "--target-service",
      "recovery",
      "--confirm-restore",
    ];
    expect(invoke("restore", "", restoreArgs).status).toBe(0);
    expect(invoke("restore", "nonempty-target", restoreArgs).status).not.toBe(0);
    expect(
      invoke(
        "restore",
        "",
        restoreArgs.map((x) => (x === "recovery" ? "app" : x)),
      ).status,
    ).not.toBe(0);
    expect(invoke("restore", "", restoreArgs.slice(0, -1)).status).not.toBe(0);
    // Fail closed if the remote index is stale, before any new dump or deletion.
    writeFileSync(join(remote, "CURRENT.json"), initial);
    const before = readFileSync(join(root, "operations.log"), "utf8");
    expect(invoke("run").status).not.toBe(0);
    const added = readFileSync(join(root, "operations.log"), "utf8").slice(before.length);
    expect(added).not.toContain("deletefile");
    expect(added).not.toContain("pg_dump");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
