import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { CodeExecRegistry, HeadTailBuffer, cleanTerminalOutput } from "../src/sandbox/code-exec-tool";

const running = (id: number, out: string) => `Chunk ID: a\nWall time: 1.0 seconds\nProcess running with session ID ${id}\nOutput:\n${out}`;
const exited = (code: number, out: string) => `Chunk ID: b\nWall time: 1.0 seconds\nProcess exited with code ${code}\nOutput:\n${out}`;

function registry(execResults: string[], pollResults: string[]) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const reg = new CodeExecRegistry();
  const fake = (name: string, results: string[]) => ({
    name,
    description: name,
    parameters: {},
    invoke: async (_ctx: unknown, input: string) => {
      calls.push({ tool: name, args: JSON.parse(input) });
      return results.shift() ?? exited(0, "");
    },
  });
  reg.register([fake("exec_command", execResults), fake("write_stdin", pollResults)]);
  const run = (code: string) => reg.tool().invoke({} as never, JSON.stringify({ code })) as Promise<string>;
  return { run, calls };
}

afterEach(() => setSystemTime());

describe("nested exec stdin", () => {
  test("closes stdin for run-to-completion commands so stdin readers finish", async () => {
    const { run, calls } = registry([exited(0, "a.go:1://go:generate")], []);
    const out = await run(`text(await tools.exec_command({cmd: "rg -n 'go:generate'"}))`);
    expect(calls[0]!.args.cmd).toBe("exec </dev/null\nrg -n 'go:generate'");
    expect(out).toContain("a.go:1://go:generate");
  });

  test("string shorthand also closes stdin", async () => {
    const { run, calls } = registry([exited(0, "ok")], []);
    await run(`await tools.exec_command("rg x")`);
    expect(calls[0]!.args.cmd).toBe("exec </dev/null\nrg x");
  });

  test("keeps stdin for tty, background and non-POSIX shells", async () => {
    const { run, calls } = registry([exited(0, ""), running(7, ""), exited(0, "")], []);
    await run(`
      await tools.exec_command({cmd: "python3", tty: true});
      await tools.exec_command({cmd: "server", background: true});
      await tools.exec_command({cmd: "print(1)", shell: "/usr/bin/python3"});
    `);
    expect(calls.map((c) => c.args.cmd)).toEqual(["python3", "server", "print(1)"]);
    expect(calls[1]!.args.background).toBeUndefined();
  });
});

describe("nested exec draining", () => {
  test("drains a yielded command to its exit and joins the output", async () => {
    const { run, calls } = registry([running(3, "one\n")], [running(3, "two\n"), exited(0, "three\n")]);
    const out = await run(`text(await tools.exec_command({cmd: "make", max_output_tokens: 500}))`);
    expect(out).toContain("Process exited with code 0");
    expect(out).toContain("one\ntwo\nthree\n");
    expect(calls.slice(1).every((c) => c.tool === "write_stdin" && c.args.max_output_tokens === 500)).toBe(true);
  });

  test("returns the running session after five silent minutes instead of blocking", async () => {
    let now = Date.parse("2026-10-09T10:00:00Z");
    setSystemTime(new Date(now));
    const polls = Array.from({ length: 20 }, () => running(9, ""));
    const reg = new CodeExecRegistry();
    let pollCount = 0;
    reg.register([
      { name: "exec_command", description: "", parameters: {}, invoke: async () => running(9, "started\n") },
      {
        name: "write_stdin",
        description: "",
        parameters: {},
        invoke: async () => {
          pollCount += 1;
          now += 30_000;
          setSystemTime(new Date(now));
          return polls.shift()!;
        },
      },
    ]);
    const out = (await reg.tool().invoke({} as never, JSON.stringify({ code: `text(await tools.exec_command("cat"))` }))) as string;
    expect(pollCount).toBe(10);
    expect(out).toContain("Process running with session ID 9");
    expect(out).toContain("started");
    expect(out).toContain("no output for 300s; returned the running session 9");
  });
});

describe("output shaping", () => {
  test("strips ANSI codes and collapses progress redraws", () => {
    const raw = "\u001b[36mBuilding\u001b[0m fastapi\n 10%\r 50%\r100%\r\ndone\u001b[2K\n";
    expect(cleanTerminalOutput(raw)).toBe("Building fastapi\n100%\ndone\n");
  });

  test("keeps head and tail within the budget and reports what was cut", () => {
    const buffer = new HeadTailBuffer(20);
    for (let i = 0; i < 50; i += 1) buffer.push(`line${i}\n`);
    const text = buffer.text();
    expect(text.startsWith("Total output lines: 50\n\nline0\nline")).toBe(true);
    expect(text.endsWith("line49\n")).toBe(true);
    expect(text).toMatch(/\.\.\.\d+ tokens truncated\.\.\./u);
  });

  test("returns small output unchanged", () => {
    const buffer = new HeadTailBuffer(100);
    buffer.push("abc");
    buffer.push("def");
    expect(buffer.text()).toBe("abcdef");
  });

  test("bounds the whole exec result", async () => {
    const { run } = registry([], []);
    const out = await run(`for (let i = 0; i < 6000; i++) text(String(i));`);
    expect(out.length).toBeLessThan(6_000 * 4 + 200);
    expect(out).toContain("\n0\n1\n2".slice(1));
    expect(out.endsWith("5999")).toBe(true);
    expect(out).toContain("tokens truncated");
  });
});
