import { test, expect } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackupIndex } from "./config";

// Explicit operator integration lane; never connects to an existing server.
const integration = process.env.OPENGENI_BACKUP_REAL_DB === "1" ? test : test.skip;
integration(
  "real PostgreSQL + Age + rclone round-trip preserves rows/grants/owners and rejects corruption",
  () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-backup-postgres-"));
    const data = join(root, "postgres"),
      socket = join(root, "socket"),
      remote = join(root, "remote");
    mkdirSync(socket);
    mkdirSync(remote);
    let started = false;
    const invoke = (binary: string, args: string[], env = process.env) =>
      execFileSync(binary, args, { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    try {
      invoke("initdb", ["-D", data, "-A", "trust", "--no-locale", "-U", "backup_admin"]);
      invoke("pg_ctl", [
        "-D",
        data,
        "-l",
        join(root, "postgres.log"),
        "-o",
        `-h '' -k ${socket} -p 5432`,
        "-w",
        "start",
      ]);
      started = true;
      const pgEnv = { ...process.env, PGHOST: socket, PGPORT: "5432", PGUSER: "backup_admin" };
      invoke("createdb", ["source"], pgEnv);
      invoke("createdb", ["recovery"], pgEnv);
      invoke(
        "psql",
        [
          "-d",
          "source",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          "CREATE ROLE backup_reader; CREATE ROLE backup_owner; CREATE TABLE records (id integer primary key, body text); INSERT INTO records SELECT i, repeat('payload',1000) FROM generate_series(1,100) i; ALTER TABLE records OWNER TO backup_owner; ALTER TABLE records ENABLE ROW LEVEL SECURITY; ALTER TABLE records FORCE ROW LEVEL SECURITY; CREATE POLICY records_reader ON records FOR SELECT TO backup_reader USING (true); GRANT SELECT ON records TO backup_reader; CREATE FUNCTION recovery_owner() RETURNS name LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT current_user'; ALTER FUNCTION recovery_owner() OWNER TO backup_owner;",
        ],
        pgEnv,
      );
      const key = join(root, "age.key");
      invoke("age-keygen", ["-o", key]);
      const recipient = invoke("age-keygen", ["-y", key]).trim();
      const services = join(root, "pg_service.conf");
      writeFileSync(
        services,
        `[source]\nhost=${socket}\nport=5432\nuser=backup_admin\ndbname=source\n[recovery]\nhost=${socket}\nport=5432\nuser=backup_admin\ndbname=recovery\n`,
        { mode: 0o600 },
      );
      const storage = join(root, "rclone.conf");
      writeFileSync(storage, "[local]\ntype=local\n", { mode: 0o600 });
      const configPath = join(root, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          remote: `local:${remote}`,
          stateDirectory: join(root, "state"),
          ageIdentityFile: key,
          ageRecipient: recipient,
          timeZone: "UTC",
          databases: [{ name: "source", service: "source" }],
          rolesService: "source",
        }),
      );
      const env = { ...process.env, PGSERVICEFILE: services, RCLONE_CONFIG: storage };
      const cli = (mode: string, extra: string[] = []) =>
        spawnSync(
          process.execPath,
          [join(import.meta.dir, "../backup.ts"), mode, "--config", configPath, ...extra],
          { env, encoding: "utf8" },
        );
      const backup = cli("run");
      expect(backup.stderr).toBe("");
      expect(backup.status).toBe(0);
      expect(cli("verify").status).toBe(0);
      const restoreArgs = [
        "--slot",
        "nightly",
        "--database",
        "source",
        "--target-service",
        "recovery",
        "--confirm-restore",
      ];
      const restored = cli("restore", restoreArgs);
      expect(restored.stderr).toBe("");
      expect(restored.status).toBe(0);
      expect(
        invoke(
          "psql",
          ["-d", "recovery", "-Atc", "SELECT count(*),sum(length(body)) FROM records"],
          pgEnv,
        ).trim(),
      ).toBe("100|700000");
      expect(
        invoke(
          "psql",
          [
            "-d",
            "recovery",
            "-Atc",
            "SELECT has_table_privilege('backup_reader','records','SELECT')",
          ],
          pgEnv,
        ).trim(),
      ).toBe("t");
      expect(
        invoke(
          "psql",
          [
            "-d",
            "recovery",
            "-Atc",
            "SELECT pg_get_userbyid(relowner),relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='records'::regclass; SELECT recovery_owner(); SET ROLE backup_reader; SELECT count(*) FROM records;",
          ],
          pgEnv,
        ).trim(),
      ).toBe("backup_owner|t|t\nbackup_owner\nSET\n100");
      expect(cli("restore", restoreArgs).status).not.toBe(0);
      const index = JSON.parse(readFileSync(join(remote, "CURRENT.json"), "utf8")) as BackupIndex;
      const dump = join(remote, index.nightly.files[0]!.key);
      const content = readFileSync(dump);
      content[content.length - 20] = content[content.length - 20]! ^ 1;
      writeFileSync(dump, content);
      expect(cli("verify").status).not.toBe(0);
      expect(cli("restore", restoreArgs).status).not.toBe(0);
    } finally {
      if (started) invoke("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);
