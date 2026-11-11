import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type Command = { binary: string; args: string[]; env?: NodeJS.ProcessEnv };
export class CommandError extends Error {
  constructor(
    readonly binary: string,
    readonly exitCode: number | null,
    signal: string | null,
  ) {
    super(`${binary} failed (${exitCode ?? signal})`);
  }
}

// Tool diagnostics can include connection details, so stderr is dropped and
// failures report only the binary and status. Operators can opt in.
const stderr = () => (process.env.OPENGENI_BACKUP_DIAGNOSTICS === "1" ? "inherit" : "ignore");

function start(command: Command): ChildProcess {
  return spawn(command.binary, command.args, {
    env: command.env ?? process.env,
    stdio: ["pipe", "pipe", stderr()],
  });
}
function exited(child: ChildProcess, command: Command): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.on("error", () => reject(Error(`Unable to start ${command.binary}`)));
    child.on("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new CommandError(command.binary, code, signal)),
    );
  });
}
function collector(limit = 8 * 1024 * 1024): { sink: Writable; text: () => string } {
  let result = "";
  return {
    sink: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        result += chunk.toString();
        if (Buffer.byteLength(result) > limit) return callback(Error("Output exceeds 8 MiB"));
        callback();
      },
    }),
    text: () => result,
  };
}
async function settle(children: ChildProcess[], work: Promise<unknown>[]): Promise<void> {
  const terminate = () => {
    for (const child of children) child.kill("SIGTERM");
  };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  try {
    await Promise.all(work);
  } catch (error) {
    terminate();
    await Promise.allSettled(work);
    throw error;
  } finally {
    process.off("SIGTERM", terminate);
    process.off("SIGINT", terminate);
  }
}

/**
 * Copy one process's output into the inputs of others; backpressure follows
 * the slowest reader. Exit codes decide success: a reader may exit as soon as
 * it has parsed what it needs (pg_restore stops after the last archive block),
 * so a closed input only stops copying to that reader. When every reader has
 * left while the writer still has data, the writer's output is closed, so it
 * fails on its next write instead of blocking.
 */
async function distribute(from: Readable, to: Writable[]): Promise<void> {
  for (const reader of to) reader.on("error", () => undefined);
  const open = () => to.filter((reader) => !reader.destroyed && !reader.writableEnded);
  const drained = (reader: Writable) =>
    new Promise<void>((resolve) => {
      const done = () => {
        for (const event of ["drain", "close", "error"]) reader.off(event, done);
        resolve();
      };
      for (const event of ["drain", "close", "error"]) reader.on(event, done);
    });
  try {
    for await (const chunk of from) {
      const readers = open();
      if (readers.length === 0) {
        from.destroy();
        return;
      }
      await Promise.all(
        readers.map((reader) => (reader.write(chunk) ? undefined : drained(reader))),
      );
    }
  } catch {
    // The writer's exit status reports a failed read.
  }
  for (const reader of open()) reader.end();
}

/** Run a pipeline of commands; returns the last command's output when collecting. */
export async function run(
  commands: Command[],
  options: { output?: Writable; collect?: boolean } = {},
): Promise<string> {
  if (commands.length === 0) throw Error("Empty process pipeline");
  const children = commands.map(start);
  const exits = children.map((child, i) => exited(child, commands[i]!));
  const collected = collector();
  const sink =
    options.output ??
    (options.collect
      ? collected.sink
      : new Writable({ write: (_chunk, _encoding, callback) => callback() }));
  const pumps: Promise<void>[] = [];
  children[0]!.stdin!.end();
  for (let i = 0; i < children.length - 1; i++)
    pumps.push(distribute(children[i]!.stdout!, [children[i + 1]!.stdin!]));
  pumps.push(pipeline(children.at(-1)!.stdout!, sink));
  await settle(children, [...exits, ...pumps]);
  return collected.text();
}

/**
 * Stream one command's output into several consumers at once (backpressure
 * follows the slowest), and return each consumer's output. Any failed process
 * fails the whole group; a consumer that finishes early stops receiving data.
 */
export async function fanout(source: Command, consumers: Command[]): Promise<string[]> {
  const producer = start(source);
  producer.stdin!.end();
  const children = consumers.map(start);
  const outputs = consumers.map(() => collector());
  const work: Promise<unknown>[] = [
    exited(producer, source),
    ...children.map((child, i) => exited(child, consumers[i]!)),
    ...children.map((child, i) => pipeline(child.stdout!, outputs[i]!.sink)),
    distribute(
      producer.stdout!,
      children.map((child) => child.stdin!),
    ),
  ];
  await settle([producer, ...children], work);
  return outputs.map((output) => output.text());
}
