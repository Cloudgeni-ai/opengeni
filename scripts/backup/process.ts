import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type Command = { binary: string; args: string[]; env?: NodeJS.ProcessEnv };
export async function run(
  commands: Command[],
  options: {
    input?: Readable;
    output?: Writable;
    collect?: boolean;
  } = {},
): Promise<string> {
  if (commands.length === 0) throw Error("Empty process pipeline");
  // Provider diagnostics can include connection details. Report only binary/status.
  const children = commands.map((command) =>
    spawn(command.binary, command.args, {
      env: command.env ?? process.env,
      stdio: ["pipe", "pipe", "ignore"],
    }),
  );
  const exits = children.map(
    (child, i) =>
      new Promise<void>((resolve, reject) => {
        child.on("error", () => reject(Error(`Unable to start ${commands[i]!.binary}`)));
        child.on("exit", (code, signal) =>
          code === 0
            ? resolve()
            : reject(Error(`${commands[i]!.binary} failed (${code ?? signal})`)),
        );
      }),
  );
  let result = "";
  const sink =
    options.output ??
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (options.collect) {
          result += chunk.toString();
          if (Buffer.byteLength(result) > 8 * 1024 * 1024)
            return callback(Error("Metadata exceeds 8 MiB"));
        }
        callback();
      },
    });
  const pumps: Promise<void>[] = [];
  if (options.input) pumps.push(pipeline(options.input, children[0]!.stdin));
  else children[0]!.stdin.end();
  for (let i = 0; i < children.length - 1; i++)
    pumps.push(pipeline(children[i]!.stdout, children[i + 1]!.stdin));
  pumps.push(pipeline(children.at(-1)!.stdout, sink));
  const terminate = () => {
    for (const child of children) child.kill("SIGTERM");
  };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  try {
    await Promise.all([...exits, ...pumps]);
  } catch (error) {
    terminate();
    await Promise.allSettled([...exits, ...pumps]);
    throw error;
  } finally {
    process.off("SIGTERM", terminate);
    process.off("SIGINT", terminate);
  }
  return result;
}
