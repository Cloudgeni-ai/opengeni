import { test, expect } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Explicit operator integration lane; never connects to an existing server.
const integration = process.env.OPENGENI_BACKUP_REAL_DB === "1" ? test : test.skip;
integration(
  "real PostgreSQL + restic round-trip preserves rows/grants/owners, stores unchanged data once and rejects corruption",
  () => {
    const root = mkdtempSync(join(tmpdir(), "opengeni-backup-postgres-"));
    const data = join(root, "postgres"),
      socket = join(root, "socket"),
      repository = join(root, "repository");
    mkdirSync(socket);
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
      invoke("createdb", ["pristine"], pgEnv);
      invoke("createdb", ["ordered"], pgEnv);
      invoke(
        "psql",
        [
          "-d",
          "source",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          // About 26 MB of varied rows, so restic's content-defined chunks can deduplicate.
          "CREATE ROLE backup_reader; CREATE ROLE backup_owner; CREATE TABLE records (id integer primary key, body text); INSERT INTO records SELECT i, (SELECT string_agg(md5(i::text || '-' || j), '') FROM generate_series(1,20) j) FROM generate_series(1,40000) i; ALTER TABLE records OWNER TO backup_owner; ALTER TABLE records ENABLE ROW LEVEL SECURITY; ALTER TABLE records FORCE ROW LEVEL SECURITY; CREATE POLICY records_reader ON records FOR SELECT TO backup_reader USING (true); GRANT SELECT ON records TO backup_reader; CREATE FUNCTION recovery_owner() RETURNS name LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT current_user'; ALTER FUNCTION recovery_owner() OWNER TO backup_owner;",
        ],
        pgEnv,
      );
      const password = join(root, "restic-password");
      writeFileSync(password, "integration password\n", { mode: 0o600 });
      const services = join(root, "pg_service.conf");
      writeFileSync(
        services,
        ["source", "recovery", "pristine", "ordered"]
          .map((db) => `[${db}]\nhost=${socket}\nport=5432\nuser=backup_admin\ndbname=${db}\n`)
          .join(""),
        { mode: 0o600 },
      );
      const configPath = join(root, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          repository,
          passwordFile: password,
          stateDirectory: join(root, "state"),
          timeZone: "UTC",
          databases: [{ name: "source", service: "source" }],
          rolesService: "source",
        }),
      );
      const env = { ...process.env, PGSERVICEFILE: services };
      // Service-scoped authentication may allow only the configured database.
      // pg_dumpall must not silently select postgres/template1 instead.
      writeFileSync(
        join(data, "pg_hba.conf"),
        "local source all trust\nlocal recovery all trust\nlocal pristine all trust\nlocal ordered all trust\nlocal all all reject\n",
      );
      invoke("psql", ["-d", "source", "-Atc", "SELECT pg_reload_conf()"], pgEnv);
      const cli = (mode: string, extra: string[] = []) =>
        spawnSync(
          process.execPath,
          [join(import.meta.dir, "../backup.ts"), mode, "--config", configPath, ...extra],
          { env, encoding: "utf8" },
        );
      expect(cli("init").status).toBe(0);
      const backup = cli("run");
      expect(backup.stderr).toBe("");
      expect(backup.status).toBe(0);
      expect(cli("verify").status).toBe(0);
      // A night with a small change stores far less than the archive again.
      invoke(
        "psql",
        ["-d", "source", "-c", "UPDATE records SET body = body || 'x' WHERE id = 1"],
        pgEnv,
      );
      const next = cli("run");
      expect(next.status).toBe(0);
      const result = JSON.parse(next.stdout.trim().split("\n").at(-1)!) as {
        files: { name: string; bytes: number; added: number }[];
      };
      const archive = result.files.find((f) => f.name === "source.dump")!;
      expect(archive.added).toBeLessThan(archive.bytes / 4);
      const restoreArgs = [
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
      ).toBe("40000|25600001");
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
      ).toBe("backup_owner|t|t\nbackup_owner\nSET\n40000");
      // A target that already holds data is refused.
      expect(cli("restore", restoreArgs).status).not.toBe(0);

      // Ordered tables. Sessions write rows interleaved, and whole sessions are
      // later deleted while new ones fill the freed space, so physical row order
      // moves throughout the table; in key order only the changed sessions move.
      invoke(
        "psql",
        [
          "-d",
          "source",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          "CREATE TABLE events (session integer, seq integer, body text, body_length integer GENERATED ALWAYS AS (length(body)) STORED, PRIMARY KEY (session, seq)); CREATE TABLE events_physical (LIKE events INCLUDING ALL); INSERT INTO events (session, seq, body) SELECT s, q, repeat(md5(s || '/' || q), 12) FROM generate_series(1, 100) q, generate_series(1, 2000) s ORDER BY q, s; INSERT INTO events_physical (session, seq, body) SELECT session, seq, body FROM events; ALTER TABLE events OWNER TO backup_owner; ALTER TABLE events ENABLE ROW LEVEL SECURITY; ALTER TABLE events FORCE ROW LEVEL SECURITY; CREATE POLICY events_reader ON events FOR SELECT TO backup_reader USING (true); GRANT SELECT ON events TO backup_reader; CREATE INDEX events_body_length ON events (body_length);",
        ],
        pgEnv,
      );
      writeFileSync(
        configPath,
        JSON.stringify({
          ...JSON.parse(readFileSync(configPath, "utf8")),
          databases: [
            {
              name: "source",
              service: "source",
              orderedTables: [{ table: "public.events", key: ["session", "seq"] }],
            },
          ],
        }),
      );
      const orderedRun = cli("run");
      expect(orderedRun.stderr).toBe("");
      expect(orderedRun.status).toBe(0);
      expect(cli("verify").status).toBe(0);
      invoke(
        "psql",
        [
          "-d",
          "source",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          "DELETE FROM events WHERE session <= 100; DELETE FROM events_physical WHERE session <= 100",
          "-c",
          "VACUUM events, events_physical",
          "-c",
          "INSERT INTO events (session, seq, body) SELECT s, q, repeat(md5(s || '/' || q), 12) FROM generate_series(1, 100) q, generate_series(2001, 2100) s ORDER BY q, s; UPDATE events SET body = body || '!' WHERE seq = 100 AND session % 1000 = 0; INSERT INTO events_physical (session, seq, body) SELECT session, seq, body FROM events WHERE session > 2000 ORDER BY seq, session; UPDATE events_physical SET body = body || '!' WHERE seq = 100 AND session % 1000 = 0;",
        ],
        pgEnv,
      );
      const churned = cli("run");
      expect(churned.status).toBe(0);
      const churn = JSON.parse(churned.stdout.trim().split("\n").at(-1)!) as {
        files: { name: string; bytes: number; added: number }[];
      };
      expect(churn.files.map((f) => f.name)).toEqual(["source.dump", "source.tables", "roles.sql"]);
      // The same churn in the same rows: in physical order (in the archive) it
      // is stored again nearly in full; in key order only around the changes.
      const rows = churn.files.find((f) => f.name === "source.tables")!;
      const physical = churn.files.find((f) => f.name === "source.dump")!;
      expect(rows.added).toBeLessThan(rows.bytes / 3);
      expect(rows.added * 3).toBeLessThan(physical.added);
      expect(cli("verify").status).toBe(0);
      const orderedArgs = [
        "--database",
        "source",
        "--target-service",
        "ordered",
        "--confirm-restore",
      ];
      const orderedRestore = cli("restore", orderedArgs);
      expect(orderedRestore.stderr).toBe("");
      expect(orderedRestore.status).toBe(0);
      const query = (db: string, sql: string) =>
        invoke("psql", ["-d", db, "-Atc", sql], pgEnv).trim();
      const fingerprint =
        "SELECT count(*), sum(length(body)), sum(body_length), md5(string_agg(session || '/' || seq || '/' || body, ',' ORDER BY session, seq)) FROM events";
      expect(query("ordered", fingerprint)).toBe(query("source", fingerprint));
      expect(query("ordered", "SELECT count(*),sum(length(body)) FROM records")).toBe(
        query("source", "SELECT count(*),sum(length(body)) FROM records"),
      );
      expect(
        query(
          "ordered",
          "SELECT pg_get_userbyid(relowner),relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='events'::regclass; SELECT count(*) FROM pg_indexes WHERE tablename='events'; SET ROLE backup_reader; SELECT count(*) FROM events;",
        ),
      ).toBe("backup_owner|t|t\n2\nSET\n200000");
      // A failed ordered restore leaves the target empty.
      expect(cli("restore", orderedArgs).status).not.toBe(0);
      // Flip a byte in every stored pack: restic's authentication must refuse
      // it, and the empty target must stay empty.
      const packs = join(repository, "data");
      for (const dir of readdirSync(packs))
        for (const name of readdirSync(join(packs, dir))) {
          const pack = join(packs, dir, name);
          const content = readFileSync(pack);
          content[20] = content[20]! ^ 1;
          chmodSync(pack, 0o600);
          writeFileSync(pack, content);
        }
      expect(cli("verify").status).not.toBe(0);
      const pristineArgs = [
        "--database",
        "source",
        "--target-service",
        "pristine",
        "--confirm-restore",
      ];
      expect(cli("restore", pristineArgs).status).not.toBe(0);
      expect(
        invoke(
          "psql",
          [
            "-d",
            "pristine",
            "-Atc",
            "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname = 'public'",
          ],
          pgEnv,
        ).trim(),
      ).toBe("0");
    } finally {
      if (started) invoke("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
      rmSync(root, { recursive: true, force: true });
    }
  },
  240000,
);
