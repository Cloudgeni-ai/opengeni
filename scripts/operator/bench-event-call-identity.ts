import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";

// Isolated migrated fixture, no live database or provider traffic. This measures
// only the metadata-trigger insertion overhead, not full event append latency.
const fixture = await acquireSharedTestDatabase("bench-event-call-identity");
if (!fixture) throw new Error("A disposable PostgreSQL fixture is required");
const db = postgres(fixture.adminUrl, { max: 1, onnotice: () => undefined });
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
try {
  await db`create temporary table before_events(type text, payload jsonb, tool_name text, tool_call_id text)`;
  await db`create temporary table after_events(like before_events)`;
  await db.unsafe(`create function pg_temp.old_tool_name() returns trigger language plpgsql as $$
    begin NEW.tool_name := NEW.payload ->> 'name'; return NEW; end $$`);
  await db.unsafe(`create trigger old_tool_name before insert on before_events for each row
    when (NEW.type = 'agent.toolCall.created') execute function pg_temp.old_tool_name()`);
  await db.unsafe(`create trigger new_tool_identity before insert on after_events for each row
    when (NEW.type in ('agent.toolCall.created','agent.toolCall.output')
      or NEW.tool_name is not null or NEW.tool_call_id is not null)
    execute function session_events_fill_tool_identity()`);
  for (const type of ["agent.toolCall.created", "agent.toolCall.output", "agent.message.delta"]) {
    const body = Array.from({ length: 1024 }, () => crypto.randomUUID().replaceAll("-", "")).join(
      "",
    );
    const payload = {
      callId: "benchmark-call",
      name: "benchmark_tool",
      arguments: body,
      output: body,
    };
    const times: Record<string, number[]> = { before: [], after: [] };
    for (let index = 0; index < 35; index++) {
      for (const name of index % 2 === 0 ? ["before", "after"] : ["after", "before"]) {
        await db.unsafe(`truncate ${name}_events`);
        const rows = await db.unsafe(
          `explain (analyze, format json)
          insert into ${name}_events(type,payload) select $1,$2::jsonb from generate_series(1,64)`,
          [type, JSON.stringify(payload)],
        );
        if (index >= 5) times[name]!.push(rows[0]["QUERY PLAN"][0]["Execution Time"]);
      }
    }
    console.log(
      JSON.stringify({
        type,
        rowsPerSample: 64,
        samples: 30,
        payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
        beforeMs: median(times.before!),
        afterMs: median(times.after!),
        extraMsPerRow: (median(times.after!) - median(times.before!)) / 64,
      }),
    );
  }
} finally {
  await db.end();
  await fixture.release();
}
