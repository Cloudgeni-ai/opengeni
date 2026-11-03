// Stand-in PostgreSQL tools for the runner test; restic itself is real.
import { basename, join } from "node:path";
import { appendFileSync } from "node:fs";
const command = basename(process.argv[1]!);
const args = process.argv.slice(2);
const failure = process.env.MOCK_FAILURE;
const input = async (): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};
appendFileSync(
  join(process.env.MOCK_ROOT!, "operations.log"),
  JSON.stringify({ command, args, service: process.env.PGSERVICE }) + "\n",
);
if (command === "pg_dump") {
  process.stdout.write(`PGDMP ${process.env.PGSERVICE} ${"row\n".repeat(50000)}`);
  if (failure === "dump" && process.env.PGSERVICE === "workflow") process.exit(1);
} else if (command === "pg_dumpall") {
  process.stdout.write("CREATE ROLE test;\n");
} else if (command === "psql") {
  console.log(failure === "nonempty-target" ? "4" : "0");
} else if (command === "pg_restore") {
  const data = await input();
  if (failure === "parse" && args.includes("--file=/dev/null")) process.exit(1);
  if (failure === "restore" && !args.includes("--file=/dev/null")) process.exit(1);
  if (!data.toString().startsWith("PGDMP")) process.exit(1);
} else throw Error(`Unexpected command ${command}`);
