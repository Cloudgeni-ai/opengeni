/** Synthetic read-cost probe; authority and recovery are covered by real-PG suites. */
import postgres from "postgres";
import { historyCallId, historyItemType } from "../../packages/db/src/session-tool-call-settlement";

const url = process.env.OPENGENI_TEST_PG_URL;
if (!url || new URL(url).hostname !== "127.0.0.1") {
  throw new Error("OPENGENI_TEST_PG_URL must name a disposable loopback PostgreSQL fixture");
}
const db = postgres(url, { max: 1 });
try {
  await db.begin(async (tx) => {
    await tx`create temporary table history_identity_probe(position int primary key,item jsonb,item_ordered json) on commit drop`;
    await tx`insert into history_identity_probe
      select n, body,body::json from generate_series(1,64) n
      cross join lateral (select jsonb_build_object('type',case when n%2=0 then 'function_call_result' else 'function_call' end,
        'callId','call_'||((n+1)/2),'output',(select string_agg(md5(n::text||':'||j::text),'') from generate_series(1,2048) j)) body) b`;
    const variants = {
      full: `select position,item_ordered as item from history_identity_probe order by position desc limit 32`,
      identity: `select page.position,jsonb_build_object('type',identity.type,'callId',identity."callId",'call_id',identity.call_id,'id',identity.id,
        'providerData',jsonb_build_object('callId',identity."providerData"->'callId','call_id',identity."providerData"->'call_id')) as item
        from (select position,item from history_identity_probe order by position desc limit 32) page
        cross join lateral jsonb_to_record(case when jsonb_typeof(page.item) in ('object','null') then page.item else '{}'::jsonb end)
          as identity(type jsonb,"callId" jsonb,call_id jsonb,id jsonb,"providerData" jsonb)
        order by page.position desc`,
    };
    let expected: string | undefined;
    const samples: Record<string, number[]> = {};
    for (let round = 0; round < 20; round++) {
      for (const [name, query] of Object.entries(variants)) {
        const start = performance.now();
        const rows = await tx.unsafe(query);
        const elapsedMs = performance.now() - start;
        const identities = JSON.stringify(
          rows.map((row) => [row.position, historyCallId(row.item), historyItemType(row.item)]),
        );
        expected ??= identities;
        if (identities !== expected) throw new Error(`Identity mismatch in ${name}`);
        (samples[name] ??= []).push(elapsedMs);
        console.log(
          JSON.stringify({
            name,
            round,
            elapsedMs,
            decodedJsonBytes: Buffer.byteLength(JSON.stringify(rows)),
          }),
        );
      }
    }
    console.log(
      JSON.stringify({
        summary: Object.fromEntries(
          Object.entries(samples).map(([name, values]) => [
            name,
            {
              medianMs: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)],
              samples: values.length,
            },
          ]),
        ),
      }),
    );
  });
} finally {
  await db.end();
}
