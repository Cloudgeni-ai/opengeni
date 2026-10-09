import { basename, dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, appendFileSync } from "node:fs";
const command = basename(process.argv[1]!);
const args = process.argv.slice(2);
const root = process.env.MOCK_REMOTE!;
const failure = process.env.MOCK_FAILURE;
const local = (remote: string) => join(root, remote.replace(/^fixture:bucket\//, ""));
const input = async (): Promise<Buffer> => {
  const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};
function walk(dir: string, prefix = ""): { Path: string; Size: number }[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name), rel = prefix + name;
    return statSync(path).isDirectory() ? walk(path, rel + "/") : [{ Path: rel, Size: statSync(path).size }];
  });
}
appendFileSync(join(root, "..", "operations.log"), JSON.stringify({ command, args, service: process.env.PGSERVICE }) + "\n");
if (command === "age") {
  if (failure === "decrypt" && args.includes("--decrypt")) process.exit(1);
  const data = args.at(-1)?.endsWith(".age") ? readFileSync(args.at(-1)!) : await input();
  process.stdout.write(data);
} else if (command === "pg_dump" || command === "pg_dumpall") {
  if (failure === "dump" && process.env.PGSERVICE === "workflow") process.exit(1);
  process.stdout.write(command === "pg_dumpall" ? "CREATE ROLE test;" : "PGDMP test archive");
} else if (command === "psql") {
  console.log(failure === "nonempty-target" ? "4" : "0");
} else if (command === "pg_restore") {
  if (failure === "restore") process.exit(1);
  const data = await input();
  if (!data.toString().startsWith("PGDMP")) process.exit(1);
} else if (command === "rclone") {
  if (args[0] === "lsjson") {
    if (args.includes("--stat")) console.log(JSON.stringify({ Size: statSync(local(args[1]!)).size }));
    else {
      const found = walk(local(args[1]!));
      console.log(JSON.stringify(args.includes("--recursive") ? found : found.filter(o => !o.Path.includes("/"))));
    }
  } else if (args[0] === "copyto") {
    const target = args[2]!.startsWith("fixture:") ? local(args[2]!) : args[2]!;
    const source = args[1]!.startsWith("fixture:") ? local(args[1]!) : args[1]!;
    if (failure === "upload" && target.endsWith("workflow.dump.age")) process.exit(1);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
    if (failure === "index-ambiguous" && target.endsWith("CURRENT.json")) process.exit(1);
  } else if (args[0] === "cat") {
    const content = readFileSync(local(args[1]!));
    process.stdout.write(failure === "checksum" && args[1]!.endsWith(".dump.age") ? "PGDMP corrupt archive" : content);
  } else if (args[0] === "deletefile") {
    if (failure === "delete") process.exit(1);
    rmSync(local(args[1]!), { force: true });
  } else throw Error("Unexpected rclone command");
} else throw Error(`Unexpected command ${command}`);
