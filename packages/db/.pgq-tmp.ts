import postgres from "postgres";
const sql = postgres(process.env.URL!, { max: 1 });
const q = process.argv[2]!;
const rows = await sql.unsafe(q);
for (const r of rows) console.log(JSON.stringify(r));
await sql.end();
