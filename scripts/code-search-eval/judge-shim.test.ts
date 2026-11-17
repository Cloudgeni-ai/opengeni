import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeGrepStats } from "./harness/trajectory";

const dir = mkdtempSync(join(tmpdir(), "judge-shim-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fake Decision Models upstream; `status` switches its next answers. */
function upstream() {
  const seen: Array<{ auth: string | null; body: { model?: string; questions: Record<string, unknown> } }> = [];
  const state = { status: 200 };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model?: string; questions: Record<string, unknown> };
      seen.push({ auth: req.headers.get("authorization"), body });
      if (state.status !== 200) return Response.json({ error: { message: "no" } }, { status: state.status });
      return Response.json({
        model: body.model,
        answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "noul", noul: 0.7 }])),
        usage: { input_tokens: 1234 },
      });
    },
  });
  return { server, seen, state };
}

async function startShim(args: string[]) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = Bun.spawn(["bun", join(import.meta.dir, "judge-shim.ts"), "--port", String(port), ...args], {
    env: { ...process.env, DECISION_MODELS_API_KEY: "fake-key" },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
    } catch {
      // not up yet
    }
    await Bun.sleep(50);
  }
  return { proc, url: `http://127.0.0.1:${port}` };
}

const ask = (url: string) =>
  fetch(`${url}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer dummy" },
    body: JSON.stringify({ model: "jev-latest", state: { a: 1 }, questions: { e1: { type: "noul", instructions: "q" } } }),
  });

describe("judge shim (Decision Models mode)", () => {
  test("forwards with the real key and model, settles tokens, and stops on a credit error", async () => {
    const up = upstream();
    const ledger = join(dir, "ledger.jsonl");
    const log = join(dir, "log.jsonl");
    const { proc, url } = await startShim([
      "--mode", "dm", "--ledger", ledger, "--log", log, "--cap-tokens", "1000000",
      "--dm-base-url", `http://127.0.0.1:${up.server.port}`,
    ]);
    try {
      const ok = (await (await ask(url)).json()) as { answers: Record<string, { noul: number }> };
      expect(ok.answers.e1!.noul).toBe(0.7);
      expect(up.seen[0]!.auth).toBe("Bearer fake-key");
      expect(up.seen[0]!.body.model).toBe("s1-pro");
      const settled = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(settled.filter((e) => e.kind === "settle").map((e) => e.tokens)).toEqual([1234]);

      up.state.status = 402;
      expect((await ask(url)).status).toBe(402);
      up.state.status = 200;
      // Stopped for good: the upstream is not called again.
      const calls = up.seen.length;
      expect((await ask(url)).status).toBe(402);
      expect(up.seen.length).toBe(calls);
      const lines = readFileSync(log, "utf8");
      expect(lines).toContain('"kind":"stop"');
      expect(lines).not.toContain("fake-key");
    } finally {
      proc.kill();
      up.server.stop(true);
    }
  });

  test("refuses requests that would pass the token cap", async () => {
    const up = upstream();
    const { proc, url } = await startShim([
      "--mode", "dm", "--ledger", join(dir, "cap.jsonl"), "--log", join(dir, "cap-log.jsonl"),
      "--cap-tokens", "1000", "--dm-base-url", `http://127.0.0.1:${up.server.port}`,
    ]);
    try {
      expect((await ask(url)).status).toBe(402);
      expect(up.seen.length).toBe(0);
    } finally {
      proc.kill();
      up.server.stop(true);
    }
  });
});

describe("codeGrepStats", () => {
  test("counts calls, patterns, judge failures and early stops", () => {
    const events = [
      { type: "agent.toolCall.created", payload: { id: "1", name: "code_grep", arguments: JSON.stringify({ question: "q", patterns: ["a", "b"] }) } },
      { type: "agent.toolCall.output", payload: { id: "1", output: "code_grep: 3 files matched\nRelevance-judged 4 of 9 excerpts (stopped early: ...)" } },
      { type: "agent.toolCall.created", payload: { id: "2", name: "code_grep", arguments: { question: "q", patterns: ["c"] } } },
      { type: "agent.toolCall.output", payload: { id: "2", output: "Relevance judging failed (x); excerpts are in match order." } },
      { type: "agent.toolCall.created", payload: { id: "3", name: "exec_command", arguments: { cmd: "rg x" } } },
    ];
    const s = codeGrepStats(events as never);
    expect(s).toMatchObject({ calls: 2, patterns: 3, judgeFailed: 1, stoppedEarly: 1, errors: 0 });
  });
});
