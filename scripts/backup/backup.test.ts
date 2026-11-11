import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  checkAge,
  groupRuns,
  parseConfig,
  parseEnvironment,
  retainedRuns,
  weekStart,
  type BackupConfig,
  type ResticSnapshot,
  type Run,
} from "./config";

const config: BackupConfig = parseConfig({
  repository: "s3:https://storage.example.internal/backups/database",
  passwordFile: "/etc/opengeni-backup/restic-password",
  stateDirectory: "/tmp/fixture-state",
  timeZone: "Europe/Oslo",
  databases: [
    { name: "app", service: "app" },
    { name: "workflow", service: "workflow" },
  ],
  rolesService: "app",
});

function snapshot(run: string, name: string, time: string, complete = true): ResticSnapshot {
  return {
    id: `${run}-${name}`,
    time,
    hostname: "opengeni",
    paths: [`/${name}`],
    tags: ["opengeni-backup", `run=${run}`, ...(complete ? ["complete"] : [])],
    summary: { total_bytes_processed: 10 },
  };
}
function completeRun(id: string, time: string): Run {
  return { id, time, complete: true, files: [] };
}

test("config defaults, validation and reserved names", () => {
  expect(config.host).toBe("opengeni");
  expect(config.retention).toEqual({ daily: 7, weekly: 4 });
  for (const patch of [
    { repository: "--option=x" },
    { repository: "relative/path" },
    { repository: "/srv/../backups" },
    { passwordFile: "relative" },
    { timeZone: "bad/zone" },
    { stateDirectory: "/" },
    { host: "two words" },
    { retention: { daily: 0 } },
    { databases: [config.databases[0], config.databases[0]] },
    { databases: [{ name: "roles", service: "x" }] },
  ]) {
    expect(() => parseConfig({ ...config, ...patch })).toThrow();
  }
  expect(parseConfig({ ...config, repository: "/srv/backups" }).repository).toBe("/srv/backups");
});
test("storage environment file is literal and keeps restic settings out", () => {
  expect(parseEnvironment("# comment\nAWS_ACCESS_KEY_ID=id\nAWS_SECRET_ACCESS_KEY=a=b\n")).toEqual({
    AWS_ACCESS_KEY_ID: "id",
    AWS_SECRET_ACCESS_KEY: "a=b",
  });
  expect(() => parseEnvironment("RESTIC_PASSWORD=x")).toThrow();
  expect(() => parseEnvironment("not a pair")).toThrow();
});
test("a run is complete only with every expected file tagged complete", () => {
  const runs = groupRuns(
    [
      snapshot("a", "app.dump", "2026-10-05T01:15:00Z"),
      snapshot("a", "workflow.dump", "2026-10-05T03:00:00Z"),
      snapshot("a", "roles.sql", "2026-10-05T03:01:00Z"),
      snapshot("b", "app.dump", "2026-10-06T01:15:00Z"),
      snapshot("b", "workflow.dump", "2026-10-06T03:00:00Z", false),
      snapshot("b", "roles.sql", "2026-10-06T03:01:00Z"),
      { ...snapshot("c", "app.dump", "2026-10-07T01:15:00Z"), hostname: "other" },
    ],
    config,
  );
  expect(runs.map((r) => [r.id, r.complete, r.files.length])).toEqual([
    ["b", false, 3],
    ["a", true, 3],
  ]);
  expect(runs[1]!.files.map((f) => f.name)).toEqual(["app.dump", "workflow.dump", "roles.sql"]);
});
test("retention keeps the newest run per day and per week, in the configured time zone", () => {
  const runs = [
    completeRun("sun-late", "2026-10-11T22:30:00Z"), // Monday 00:30 in Oslo
    completeRun("sun", "2026-10-11T01:15:00Z"),
    completeRun("sat", "2026-10-10T01:15:00Z"),
    completeRun("earlier-sat", "2026-10-10T00:15:00Z"),
    completeRun("previous-week", "2026-10-03T01:15:00Z"),
    completeRun("old", "2026-09-01T01:15:00Z"),
    { ...completeRun("failed", "2026-10-11T23:00:00Z"), complete: false },
  ];
  const keep = retainedRuns(runs, { ...config, retention: { daily: 2, weekly: 2 } });
  expect([...keep].sort()).toEqual(["sun", "sun-late"]);
  const weekly = retainedRuns(runs, { ...config, retention: { daily: 1, weekly: 3 } });
  expect([...weekly].sort()).toEqual(["previous-week", "sun", "sun-late"]);
  expect(weekStart(new Date("2026-10-11T21:59:00Z"), config.timeZone)).toBe("2026-10-05");
  expect(weekStart(new Date("2026-10-11T22:00:00Z"), config.timeZone)).toBe("2026-10-12");
});
test("freshness rejects missing, stale and future points", () => {
  const run = completeRun("a", "2026-10-10T01:15:00Z");
  expect(checkAge(run, new Date("2026-10-10T12:00:00Z"))).toBe(run);
  expect(() => checkAge(undefined)).toThrow();
  expect(() => checkAge(run, new Date("2026-10-12T12:00:00Z"))).toThrow();
  expect(() => checkAge(run, new Date("2026-10-09T12:00:00Z"))).toThrow();
});

const resticAvailable = spawnSync("restic", ["version"]).status === 0;
(resticAvailable ? test : test.skip)(
  "full CLI against a real restic repository: failed runs leave no point, retention, restore isolation",
  () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-backup-test-"));
    try {
      const bin = join(root, "bin"),
        state = join(root, "state");
      mkdirSync(bin);
      for (const name of ["pg_dump", "pg_dumpall", "pg_restore", "psql"]) {
        writeFileSync(
          join(bin, name),
          `#!${process.execPath}\n${readFileSync(new URL("./fixtures/tool.ts", import.meta.url), "utf8")}`,
        );
        chmodSync(join(bin, name), 0o755);
      }
      writeFileSync(join(root, "password"), "fixture password\n", { mode: 0o600 });
      writeFileSync(join(root, "storage.env"), "FIXTURE_STORAGE=1\n", { mode: 0o600 });
      writeFileSync(
        join(root, "config.json"),
        JSON.stringify({
          ...config,
          repository: join(root, "repository"),
          passwordFile: join(root, "password"),
          environmentFile: join(root, "storage.env"),
          stateDirectory: state,
        }),
      );
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_ROOT: root };
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
      const list = () => JSON.parse(invoke("list").stdout) as Run[];

      const missing = invoke("run");
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain("run `init` once");
      expect(invoke("init").status).toBe(0);
      expect(invoke("init").status).not.toBe(0);

      const first = invoke("run");
      expect(first.stderr).toBe("");
      expect(first.status).toBe(0);
      const [initial] = list();
      expect(initial!.complete).toBe(true);
      expect(initial!.files.map((f) => f.name)).toEqual(["app.dump", "workflow.dump", "roles.sql"]);
      expect(invoke("check").status).toBe(0);
      expect(invoke("verify").status).toBe(0);

      for (const failure of ["dump", "parse"]) {
        expect(invoke("run", failure).status).not.toBe(0);
        const runs = list();
        expect(runs).toHaveLength(1);
        expect(runs[0]!.id).toBe(initial!.id);
      }

      // Same local day: the newer run replaces the older one.
      const second = invoke("run");
      expect(second.status).toBe(0);
      const summary = JSON.parse(second.stdout.trim().split("\n").at(-1)!) as {
        run: string;
        forgottenRuns: number;
      };
      expect(summary.forgottenRuns).toBe(1);
      expect(list().map((r) => r.id)).toEqual([summary.run]);

      const restoreArgs = [
        "--database",
        "app",
        "--target-service",
        "recovery",
        "--confirm-restore",
      ];
      expect(invoke("restore", "", restoreArgs).status).toBe(0);
      expect(invoke("restore", "", ["--run", summary.run, ...restoreArgs]).status).toBe(0);
      expect(invoke("restore", "", ["--run", initial!.id, ...restoreArgs]).status).not.toBe(0);
      expect(invoke("restore", "nonempty-target", restoreArgs).status).not.toBe(0);
      expect(invoke("restore", "restore", restoreArgs).status).not.toBe(0);
      expect(
        invoke(
          "restore",
          "",
          restoreArgs.map((x) => (x === "recovery" ? "app" : x)),
        ).status,
      ).not.toBe(0);
      expect(invoke("restore", "", restoreArgs.slice(0, -1)).status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);
