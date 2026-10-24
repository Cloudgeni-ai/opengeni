// Diagnostic only: incremental index storage/write cost, not full append latency.
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";

const fixture = await acquireSharedTestDatabase("tool-name-index-cost", {
  withheldMigrations: [
    "0943_session_event_tool_name_pages.sql",
    "0944_session_event_tool_name_fallback_pages.sql",
  ],
});
if (!fixture) throw new Error("Disposable PostgreSQL required");
const db = postgres(fixture.adminUrl, { max: 1, onnotice: () => undefined });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
try {
  for (const table of ["before_events", "after_events"]) {
    await db.unsafe(
      `create temporary table ${table} (like session_events including defaults including constraints including indexes)`,
    );
  }
  await db.unsafe(`create index named_tools on after_events(workspace_id,session_id,tool_name,sequence)
    where type='agent.toolCall.created' and tool_name is not null and octet_length(tool_name)<=2048`);
  await db.unsafe(`create index legacy_tools on after_events(workspace_id,session_id,sequence)
    where type='agent.toolCall.created' and (tool_name is null or octet_length(tool_name)>2048)`);
  const account = crypto.randomUUID(),
    workspace = crypto.randomUUID(),
    session = crypto.randomUUID();
  for (const table of ["before_events", "after_events"]) {
    await db.unsafe(
      `insert into ${table}(account_id,workspace_id,session_id,sequence,type,tool_name,payload)
      select $1::uuid,$2::uuid,$3::uuid,n,
        case when n%5=0 then 'agent.toolCall.created' else 'agent.toolCall.output' end,
        case when n%5=0 then 'tool_'||(n%100)::text else null end,
        jsonb_build_object('name','tool_'||(n%100)::text,'arguments',repeat('x',256))
      from generate_series(1,20000) n`,
      [account, workspace, session],
    );
  }
  console.log(
    JSON.stringify({
      probe: "initial-index-bytes",
      rows: 20000,
      createdRows: 4000,
      sizes:
        await db`select pg_relation_size('named_tools') named_bytes,pg_relation_size('legacy_tools') fallback_bytes`,
    }),
  );
  for (const type of ["agent.toolCall.created", "agent.toolCall.output", "agent.message.delta"]) {
    const payload = JSON.stringify({ name: "tool_benchmark", arguments: "x".repeat(1024) });
    const samples = { before: [] as number[], after: [] as number[] };
    for (let sample = -5; sample < 30; sample++) {
      for (const variant of sample % 2 === 0 ? ["before", "after"] : ["after", "before"]) {
        const table = `${variant}_events`;
        let plan: any;
        // Roll back each measured insertion; existing rows and indexes stay present.
        await db
          .begin(async (tx) => {
            const rows = await tx.unsafe(
              `explain (analyze,buffers,wal,format json)
            insert into ${table}(account_id,workspace_id,session_id,sequence,type,tool_name,payload)
            select $1::uuid,$2::uuid,$3::uuid,20000+n,$4,$5,$6::jsonb from generate_series(1,100) n`,
              [
                account,
                workspace,
                session,
                type,
                type === "agent.toolCall.created" ? "tool_benchmark" : null,
                payload,
              ],
            );
            plan = rows[0]["QUERY PLAN"][0];
            throw new Error("rollback-fixture");
          })
          .catch((error) => {
            if (error.message !== "rollback-fixture") throw error;
          });
        if (sample >= 0) samples[variant as keyof typeof samples].push(plan["Execution Time"]);
      }
    }
    console.log(
      JSON.stringify({
        probe: "index-only-insert-cost",
        type,
        rowsPerSample: 100,
        samples: 30,
        beforeMs: median(samples.before),
        afterMs: median(samples.after),
      }),
    );
  }
  for (const [index, name] of ["😀".repeat(512), "😀".repeat(513), "x".repeat(100000)].entries()) {
    await db.unsafe(
      `insert into after_events(account_id,workspace_id,session_id,sequence,type,tool_name,payload)
      values($1,$2,$3,$4,'agent.toolCall.created',$5,jsonb_build_object('name',$5::text))`,
      [account, workspace, session, 40000 + index, name],
    );
  }
  console.log(
    JSON.stringify({
      probe: "oversized-names-insert",
      rows: await db`select octet_length(tool_name) as bytes from after_events where sequence>=40000 order by sequence`,
    }),
  );
  const [icu] =
    await db`select exists(select 1 from pg_collation where collprovider='i') supported`;
  if (icu.supported) {
    await db.unsafe(
      `create collation public.probe_tool_name_fold (provider=icu, locale='und-u-ks-level1', deterministic=false)`,
    );
    const [row] = await db.unsafe(
      `select 'a'::text collate public.probe_tool_name_fold = $1::text as matches,
      octet_length($1::text) as bytes`,
      ["a" + "\u0301".repeat(1500)],
    );
    console.log(JSON.stringify({ probe: "nondeterministic-oversized-equality", ...row }));
  }
} finally {
  await db.end();
  await fixture.release();
}
