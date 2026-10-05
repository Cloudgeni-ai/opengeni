import postgres from "postgres";
const base = "postgres://opengeni:opengeni@127.0.0.1:28899/";
const root = postgres(base + "opengeni", { max: 1 });
const dbs = await root`select datname from pg_database where datname like 'og_test_template%'`;
await root.end();
for (const { datname } of dbs) {
  const s = postgres(base + datname, { max: 1, onnotice: () => {} });
  try {
    const [r] =
      await s`select (select count(*)::int from pg_tables where schemaname=$$public$$) c, (to_regclass($$session_turn_attempts$$) is not null)::text m`;
    console.log(datname, r.c, r.m);
  } catch {
    console.log(datname, "err");
  }
  await s.end();
}
