import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionSkills, type SessionSkill } from "@opengeni/contracts";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSessionForSubject,
  getSessionLineage,
  listSessionsForSubject,
} from "../../packages/db/src/index";
import { withWorkspaceRls } from "../../packages/db/src/database";
import { lockSessionEventWriteRows } from "../../packages/db/src/session-control";

// Disposable local diagnostic: what a session's Skill folders cost the hot
// session reads on a realistic dataset. It seeds OPENGENI_BENCH_SESSIONS
// sessions (default 3000) whose inline Skills are about
// OPENGENI_BENCH_SKILLS_BYTES (default 265000) of this repository's Markdown,
// then times, from pg_stat_statements, the statements that read the sessions
// table: event-write locks of one session (the default full projection),
// session reads and 200-row list pages for the compact chat projection, and
// lineage reads. TOAST blocks come from pg_statio for the sessions table. Run
// it unchanged on two revisions to compare them; a revision without the
// compact read option ignores the extra argument and reads the folders.
const sessionCount = Number(process.env.OPENGENI_BENCH_SESSIONS ?? "3000");
const skillsBytes = Number(process.env.OPENGENI_BENCH_SKILLS_BYTES ?? "265000");
const lockIterations = Number(process.env.OPENGENI_BENCH_LOCKS ?? "2000");
if (
  ![sessionCount, skillsBytes, lockIterations].every(
    (value) => Number.isInteger(value) && value > 0,
  )
)
  throw new Error("Invalid benchmark size");

const shared = await acquireSharedTestDatabase("session-skills-reads-benchmark");
if (!shared) throw new Error("Local PostgreSQL required");
const client = createDb(shared.appUrl, { max: 16 });

type Phase = {
  phase: string;
  operations: number;
  /** Top-level statements that read or lock the sessions table. */
  sessionStatements: number;
  sessionExecMs: number;
  meanStatementMs: number;
  rows: number;
  /** Shared buffer blocks touched by those statements (8 KiB each), heap and TOAST. */
  sharedBlocks: number;
  /** Blocks of the sessions TOAST relation touched by every statement. */
  toastBlocks: number;
  wallMsPerOperation: number;
};

async function skillFolders(seed: number): Promise<SessionSkill[]> {
  const docs = join(import.meta.dir, "../../docs");
  const names = (await readdir(docs)).filter((name) => name.endsWith(".md")).sort();
  const skills: unknown[] = [];
  let remaining = skillsBytes;
  // Rotate the starting document so sessions carry different folders.
  for (let i = 0; i < names.length && remaining > 0; i++) {
    const name = names[(seed + i) % names.length]!;
    const text = (await readFile(join(docs, name), "utf8")).slice(0, Math.min(remaining, 60_000));
    const skillName = `bench-${name
      .toLowerCase()
      .replace(/\.md$/u, "")
      .replace(/[^a-z0-9-]/gu, "-")}`.slice(0, 64);
    skills.push({
      files: [
        {
          path: "SKILL.md",
          content: `---\nname: ${skillName}\ndescription: Benchmark Skill ${seed}.\n---\n\n${text}`,
        },
      ],
    });
    remaining -= text.length;
  }
  return SessionSkills.parse(skills);
}

async function toastBlocks(): Promise<number> {
  await shared!.admin`select pg_stat_clear_snapshot()`;
  const [row] = await shared!.admin<{ blocks: string }[]>`
    select coalesce(toast_blks_hit, 0) + coalesce(toast_blks_read, 0) as blocks
    from pg_statio_all_tables where relid = 'public.sessions'::regclass`;
  return Number(row?.blocks ?? 0);
}

async function phase(name: string, operations: number, run: (i: number) => Promise<unknown>) {
  // Warm once so the measured phase is not a cold cache or plan.
  await run(0);
  await shared!.admin`select pg_stat_statements_reset()`;
  const toastBefore = await toastBlocks();
  const started = performance.now();
  for (let i = 0; i < operations; i++) await run(i);
  const wallMs = performance.now() - started;
  // Backends report table I/O statistics when they go idle.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const [row] = await shared!.admin<
    { calls: string; execMs: number; rows: string; blocks: string }[]
  >`select coalesce(sum(calls), 0) as calls, coalesce(sum(total_exec_time), 0)::float8 as "execMs",
      coalesce(sum(rows), 0) as rows,
      coalesce(sum(shared_blks_hit + shared_blks_read), 0) as blocks
    from pg_stat_statements
    where toplevel and dbid = (select oid from pg_database where datname = current_database())
      and query ~* '\\mfrom "?sessions"?\\M'`;
  const calls = Number(row?.calls ?? 0);
  const result: Phase = {
    phase: name,
    operations,
    sessionStatements: calls,
    sessionExecMs: Math.round(Number(row?.execMs ?? 0)),
    meanStatementMs: calls ? Number(((row?.execMs ?? 0) / calls).toFixed(3)) : 0,
    rows: Number(row?.rows ?? 0),
    sharedBlocks: Number(row?.blocks ?? 0),
    toastBlocks: (await toastBlocks()) - toastBefore,
    wallMsPerOperation: Number((wallMs / operations).toFixed(2)),
  };
  console.error(JSON.stringify(result));
  return result;
}

try {
  await shared.admin`create extension if not exists pg_stat_statements`;
  const id = crypto.randomUUID();
  const grant = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "benchmark",
      accountExternalId: id,
      accountName: "Skills reads benchmark",
      workspaceExternalSource: "benchmark",
      workspaceExternalId: id,
      workspaceName: "Skills reads benchmark",
      subjectId: `benchmark:${id}`,
    })
  ).workspaceGrants[0]!;
  const input = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Skills reads benchmark",
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
    resources: [],
    metadata: {},
    ownerSubjectId: grant.subjectId,
  };
  const folders = await Promise.all(Array.from({ length: 8 }, (_, seed) => skillFolders(seed)));
  // A few roots, each with children, so lineage reads span many rows.
  const roots: string[] = [];
  const ids: string[] = [];
  for (let start = 0; start < sessionCount; start += 16) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(16, sessionCount - start) }, (_, offset) => {
        const index = start + offset;
        const parent = index % 50 === 0 ? undefined : roots.at(-1);
        return createSession(client.db, {
          ...input,
          skills: folders[index % folders.length]!,
          ...(parent ? { parentSessionId: parent } : {}),
        });
      }),
    );
    for (const [offset, session] of batch.entries()) {
      ids.push(session.id);
      if ((start + offset) % 50 === 0) roots.push(session.id);
    }
  }
  // Fixture-only: settle the seeded table once, then keep autovacuum of this
  // disposable database out of the measured TOAST counters.
  await shared.admin`vacuum analyze sessions`;
  await shared.admin`alter table sessions set (autovacuum_enabled = false, toast.autovacuum_enabled = false)`;
  const [size] = await shared.admin<{ heap: string; toast: string; skillsBytes: string }[]>`
    select pg_relation_size('sessions') as heap,
      pg_relation_size((select reltoastrelid from pg_class where oid = 'sessions'::regclass)) as toast,
      avg(pg_column_size(skills))::bigint as "skillsBytes"
    from sessions`;
  const pick = (i: number) => ids[(i * 7919) % ids.length]!;
  const phases = [
    await phase("event-write lock (one session)", lockIterations, (i) =>
      withWorkspaceRls(client.db, grant.workspaceId, (scopedDb) =>
        scopedDb.transaction((tx) =>
          lockSessionEventWriteRows(tx as never, {
            workspaceId: grant.workspaceId,
            controlLock: "none",
            sessionIds: [pick(i)],
          }),
        ),
      ),
    ),
    await phase("compact session read", 500, (i) =>
      (getSessionForSubject as (...args: unknown[]) => Promise<unknown>)(
        client.db,
        grant.workspaceId,
        pick(i),
        grant.subjectId,
        "root",
        "omit",
      ),
    ),
    await phase("compact list page of 200", 20, (i) =>
      (listSessionsForSubject as (...args: unknown[]) => Promise<unknown>)(
        client.db,
        grant.workspaceId,
        { subjectId: grant.subjectId, parentSessionId: roots[i % roots.length]!, limit: 200 },
        "omit",
      ),
    ),
    await phase("compact lineage read", 50, (i) =>
      (getSessionLineage as (...args: unknown[]) => Promise<unknown>)(
        client.db,
        grant.workspaceId,
        roots[i % roots.length]!,
        "omit",
      ),
    ),
  ];
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        fixture: {
          sessions: ids.length,
          heapBytes: Number(size?.heap ?? 0),
          toastBytes: Number(size?.toast ?? 0),
          storedSkillsBytesPerSession: Number(size?.skillsBytes ?? 0),
          rawSkillsBytesPerSession: skillsBytes,
        },
        phases,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await shared.release();
}
process.exit(0);
