import postgres from "postgres";
const sql = postgres("postgres://opengeni:opengeni@127.0.0.1:28899/og_test_template_fdc9364ea1f0", {
  max: 1,
});
const rows =
  await sql`select p.oid::regproc::text fn, prosrc from pg_proc p where prosrc ~* 'insert\\s+into\\s+(public\\.)?session_events\\b'`;
for (const r of rows) {
  const s: string = r.prosrc;
  const idx = (re: RegExp) => {
    const m = re.exec(s);
    return m ? m.index : -1;
  };
  const cursor = idx(/from\s+(public\.)?session_event_cursors[\s\S]{0,300}?for\s+update/i);
  const sess = idx(
    /from\s+(public\.)?sessions\b[\s\S]{0,400}?for\s+(no key update|update|share|key share)/i,
  );
  const turn = idx(
    /from\s+(public\.)?session_turns\b[\s\S]{0,400}?for\s+(no key update|update|share|key share)/i,
  );
  const att = idx(
    /from\s+(public\.)?session_turn_attempts\b[\s\S]{0,400}?for\s+(no key update|update|share|key share)/i,
  );
  const ins = idx(/insert\s+into\s+(public\.)?session_events\b/i);
  const helper = idx(/lock_session_event_write|session_event_write_prefix|lock_session_event/i);
  console.log(JSON.stringify({ fn: r.fn, sess, cursor, turn, att, ins, helper }));
}
await sql.end();
