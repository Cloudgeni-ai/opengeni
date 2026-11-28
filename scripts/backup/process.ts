import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";

export type Command = {
  binary: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /**
   * In a pipeline: the next command may stop reading once it has what it needs,
   * so this command ending on a closed output is not a failure. The next
   * command's own exit status still decides the result.
   */
  outputMayClose?: boolean;
};
export class CommandError extends Error {
  constructor(
    readonly binary: string,
    readonly exitCode: number | null,
    readonly signal: string | null,
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
async function distribute(from: Readable, to: Writable[], end = true): Promise<void> {
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
  if (end) for (const reader of open()) reader.end();
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
 * In-process `checks` read the same bytes and fail the group by erroring.
 */
export async function fanout(
  source: Command,
  consumers: Command[],
  checks: Writable[] = [],
): Promise<string[]> {
  const producer = start(source);
  producer.stdin!.end();
  const children = consumers.map(start);
  const outputs = consumers.map(() => collector());
  const work: Promise<unknown>[] = [
    exited(producer, source),
    ...children.map((child, i) => exited(child, consumers[i]!)),
    ...children.map((child, i) => pipeline(child.stdout!, outputs[i]!.sink)),
    ...checks.map((check) => finished(check)),
    distribute(producer.stdout!, [...children.map((child) => child.stdin!), ...checks]),
  ];
  await settle([producer, ...children], work);
  return outputs.map((output) => output.text());
}

/**
 * Feed the outputs of several pipelines, one after another, into one consumer's
 * input, then close it. Any failed process fails the whole group.
 */
export async function concatenate(parts: Command[][], consumer: Command): Promise<void> {
  const sink = start(consumer);
  const all: ChildProcess[] = [sink];
  const work: Promise<unknown>[] = [
    exited(sink, consumer),
    pipeline(sink.stdout!, new Writable({ write: (_chunk, _encoding, callback) => callback() })),
  ];
  const feed = (async () => {
    for (const part of parts) {
      if (part.length === 0) throw Error("Empty process pipeline");
      const children = part.map(start);
      all.push(...children);
      children[0]!.stdin!.end();
      const steps: Promise<unknown>[] = children.map((child, i) =>
        exited(child, part[i]!).catch((error: unknown) => {
          if (
            part[i]!.outputMayClose &&
            i < children.length - 1 &&
            error instanceof CommandError &&
            error.signal === "SIGPIPE"
          )
            return;
          throw error;
        }),
      );
      for (let i = 0; i < children.length - 1; i++)
        steps.push(distribute(children[i]!.stdout!, [children[i + 1]!.stdin!]));
      steps.push(distribute(children.at(-1)!.stdout!, [sink.stdin!], false));
      await Promise.all(steps);
      if (sink.stdin!.destroyed) throw new CommandError(consumer.binary, null, "input closed");
    }
    sink.stdin!.end();
  })();
  work.push(feed);
  await settle(all, work);
}

/**
 * Start a long-lived command, send it `input` without closing its input, and
 * wait for its first output line. `release` sends `closing`, closes the input
 * and waits for a clean exit. Used to hold a database transaction open.
 */
export async function hold(
  command: Command,
  input: string,
  closing: string,
): Promise<{ line: string; release: () => Promise<void> }> {
  const child = start(command);
  child.stdin!.on("error", () => undefined);
  const exit = exited(child, command);
  exit.catch(() => undefined);
  let buffered = "";
  const line = await new Promise<string>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString();
      const end = buffered.indexOf("\n");
      if (end >= 0) {
        child.stdout!.off("data", onData);
        child.stdout!.resume();
        resolve(buffered.slice(0, end).trim());
      } else if (buffered.length > 4096) reject(Error(`Unexpected ${command.binary} output`));
    };
    child.stdout!.on("data", onData);
    exit.then(
      () => reject(Error(`${command.binary} exited early`)),
      (error: unknown) => reject(error),
    );
    child.stdin!.write(input);
  }).catch(async (error: unknown) => {
    child.kill("SIGTERM");
    await exit.catch(() => undefined);
    throw error;
  });
  child.stdout!.on("data", () => undefined);
  let released: Promise<void> | undefined;
  return {
    line,
    release: () =>
      (released ??= (async () => {
        child.stdin!.end(closing);
        await exit;
      })()),
  };
}
