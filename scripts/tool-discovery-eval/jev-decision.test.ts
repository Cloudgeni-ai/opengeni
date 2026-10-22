import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Tool } from "@openai/agents";
import { JevClient, jevCostUsd, type JevFetch } from "../../packages/jev/src/client";
import { LazyToolRuntime } from "../../packages/runtime/src/lazy-tool-transport";
import {
  createToolSelector,
  TOOL_SELECTION_PROTOCOL,
} from "../../packages/runtime/src/tool-discovery-decision";
import { createJevDecisionModel as jevBackend } from "../../packages/jev/src/decision-model";
import type { DecisionUsage } from "../../packages/decisions/src";

const createJevDecisionModel = (
  providerClient: JevClient,
  onUsage?: (usage: DecisionUsage) => void,
) => createToolSelector(jevBackend(providerClient), onUsage ? { onUsage } : {});

const candidates = [
  { name: "tasks__get", description: "Get task", inputFields: ["id"] },
  { name: "tasks__read", description: "Read task", inputFields: ["id"] },
  { name: "tasks__delete", description: "Delete task", inputFields: ["id"] },
];
const catalog = candidates.map((candidate) => ({
  name: candidate.name,
  description: candidate.description,
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
}));

function client(fetch: JevFetch) {
  return new JevClient({ apiKey: "test-only-not-a-credential", fetch });
}

function response(probabilities: unknown[]) {
  return Response.json({
    model: "jev-test-version",
    usage: { input_tokens: 1000 },
    answers: Object.fromEntries(
      probabilities.map((probability, id) => [id, { type: "noul", noul: probability }]),
    ),
  });
}

describe("Jev decision eval adapter", () => {
  test("uses the existing client, typed questions and exact candidate identities", async () => {
    let receipt: DecisionUsage | undefined;
    const choose = createJevDecisionModel(
      client(async (url, init) => {
        expect(url).toBe("https://api.typesafe.ai/v1/systemone");
        const body = JSON.parse(String(init.body));
        expect(body.model).toBe("jev-latest");
        expect(body.state.query).toBe("read task then delete task");
        expect(body.state.candidates.map((c: { name: string }) => c.name)).toEqual(
          candidates.map((c) => c.name),
        );
        expect(body.questions["0"].type).toBe("noul");
        expect(body.questions["0"].instructions.candidateName).toBe("tasks__get");
        expect(body.state).not.toHaveProperty("parameters");
        return response([0.8, 0.2, 0.9]);
      }),
      (result) => {
        receipt = result;
      },
    );
    expect(await choose({ query: "read task then delete task", candidates })).toEqual([
      "tasks__delete",
      "tasks__get",
    ]);
    expect(receipt?.model).toBe("jev-test-version");
    expect(receipt?.inputTokens).toBe(1000);
    expect(receipt?.requests).toBe(1);
    expect(receipt?.costUsd).toBe(jevCostUsd(1000));
  });

  test("uses the frozen exclusive threshold and stable tie order, including no matches", async () => {
    expect(
      await createJevDecisionModel(client(async () => response([0.5, 0.5, 0])))({
        query: "task",
        candidates,
      }),
    ).toEqual([]);
    expect(
      await createJevDecisionModel(client(async () => response([0.7, 0.7, 0.5])))({
        query: "task",
        candidates,
      }),
    ).toEqual(["tasks__get", "tasks__read"]);
  });

  test.each([-0.1, 1.1, "not-a-probability"])(
    "rejects the whole selection for invalid score %s but retains usage",
    async (invalid) => {
      let receipt: DecisionUsage | undefined;
      const choose = createJevDecisionModel(
        client(async () => response([0.9, invalid, 0])),
        (r) => {
          receipt = r;
        },
      );
      await expect(choose({ query: "task", candidates })).rejects.toThrow("invalid typed answers");
      expect(receipt?.inputTokens).toBe(1000);
    },
  );

  test("does not call a provider for an empty pool or pre-aborted input", async () => {
    const choose = createJevDecisionModel(
      client(async () => {
        throw new Error("unexpected fetch");
      }),
    );
    expect(await choose({ query: "task", candidates: [] })).toEqual([]);
    const controller = new AbortController();
    controller.abort(new Error("cancel selection"));
    await expect(choose({ query: "task", candidates, signal: controller.signal })).rejects.toThrow(
      "cancel selection",
    );
  });

  test("forwards in-flight cancellation instead of converting it to an empty selection", async () => {
    const controller = new AbortController();
    const choose = createJevDecisionModel(
      client(async (_, init) => {
        controller.abort(new Error("stop in flight"));
        expect(init.signal?.aborted).toBe(true);
        throw controller.signal.reason;
      }),
    );
    await expect(choose({ query: "task", candidates, signal: controller.signal })).rejects.toThrow(
      "stop in flight",
    );
  });

  test("provider unavailability uses the existing runtime fallback without revealing diagnostics", async () => {
    const choose = createJevDecisionModel(
      client(async () =>
        Response.json({ error: { message: "test-private-provider-diagnostic" } }, { status: 401 }),
      ),
    );
    const runtime = new LazyToolRuntime(
      "generic_dispatch",
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      false,
      undefined,
      undefined,
      undefined,
      choose,
    );
    runtime.refresh(
      catalog.map(
        (tool) =>
          ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: false,
          }) as Tool,
      ),
    );
    const result = await runtime.prepareSearch({ query: "task" });
    expect(JSON.parse(result.output).fallback).toBe("decision_model_unavailable");
    expect(result.output).not.toContain("test-private-provider-diagnostic");
  });
});

describe("Jev eval command wiring (local mock endpoints, no paid calls)", () => {
  test("retrieval, offline replay, trajectories and resume use the same generic interface", async () => {
    const directory = mkdtempSync(join(tmpdir(), "opengeni-jev-test-"));
    let decisionRequests = 0;
    let unavailable = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json();
        if (new URL(request.url).pathname === "/v1/systemone") {
          decisionRequests++;
          if (unavailable) return new Response(null, { status: 401 });
          return Response.json({
            model: "jev-test-version",
            usage: { input_tokens: 1000 },
            answers: Object.fromEntries(
              Object.entries(body.questions).map(([id, q]) => [
                id,
                {
                  type: "noul",
                  noul:
                    (q as { instructions: { candidateName: string } }).instructions
                      .candidateName === "tasks__get"
                      ? 0.9
                      : 0.1,
                },
              ]),
            ),
          });
        }
        if (new URL(request.url).pathname !== "/chat/completions")
          return new Response(null, { status: 404 });
        const searched = body.messages.some((message: { role: string }) => message.role === "tool");
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: searched ? "invoke" : "search",
                    type: "function",
                    function: {
                      name: searched ? "tool_invoke" : "tool_search",
                      arguments: JSON.stringify(
                        searched ? { name: "tasks__get", arguments: {} } : { query: "task" },
                      ),
                    },
                  },
                ],
              },
            },
          ],
          usage: { cost: 0.001 },
        });
      },
    });
    const root = resolve(import.meta.dir, "../..");
    const paths = {
      catalog: join(directory, "catalog.json"),
      queries: join(directory, "queries.json"),
      decision: join(directory, "decision.json"),
      agent: join(directory, "agent.json"),
    };
    const run = async (script: string, args: string[], expectedFailure?: string) => {
      const child = Bun.spawn([process.execPath, join(root, "scripts", script), ...args], {
        cwd: root,
        env: {
          ...process.env,
          OPENGENI_JEV_API_KEY: "test-only-not-a-credential",
          OPENGENI_JEV_BASE_URL: server.url.origin,
          DECISION_MODEL_API_KEY: "test-only-agent-key",
          DECISION_MODEL_BASE_URL: server.url.origin,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (expectedFailure) {
        expect(stderr).toContain(expectedFailure);
        expect(code).not.toBe(0);
      } else {
        expect(stderr).toBe("");
        expect(code).toBe(0);
      }
      return stdout;
    };
    try {
      await Bun.write(paths.catalog, JSON.stringify(catalog));
      await Bun.write(
        paths.queries,
        JSON.stringify([
          { id: "test", source: "synthetic", query: "task", expected: ["tasks__get"] },
        ]),
      );
      const shared = ["--catalog", paths.catalog, "--queries", paths.queries];
      const decisionArgs = [
        ...shared,
        "--backend",
        "jev",
        "--model",
        "jev-latest",
        "--out",
        paths.decision,
      ];
      await run("tool-discovery-decision-eval.ts", decisionArgs);
      const decision = await Bun.file(paths.decision).json();
      expect(decision.metadata.instruction).toEqual(TOOL_SELECTION_PROTOCOL);
      expect(decision.rows[0]).toMatchObject({
        top1: true,
        selected: ["tasks__get"],
        outputTokens: null,
        model: "jev-test-version",
        costSource: "estimate",
        requests: 1,
      });
      await run("tool-discovery-decision-eval.ts", decisionArgs);
      expect(decisionRequests).toBe(1);
      await run(
        "tool-discovery-decision-eval.ts",
        decisionArgs.map((arg) => (arg === "jev-latest" ? "jev-different-version" : arg)),
        "different experiment",
      );
      expect(decisionRequests).toBe(1);
      const replay = await run("tool-discovery-eval.ts", [
        ...shared,
        "--decision-results",
        paths.decision,
      ]);
      expect(replay).toContain('"nativeDecision"');
      expect(decisionRequests).toBe(1);
      const agentArgs = [
        ...shared,
        "--out",
        paths.agent,
        "--model",
        "test-agent",
        "--decision-backend",
        "jev",
        "--decision-model",
        "jev-latest",
        "--implementation",
        "mock-test",
      ];
      const agentOutput = await run("tool-discovery-agent-eval.ts", agentArgs);
      expect(agentOutput).toContain('"p95Ms"');
      const trajectories = await Bun.file(paths.agent).json();
      expect(trajectories.rows.find((row: { arm: string }) => row.arm === "after")).toMatchObject({
        correct: true,
        decisionCalls: 1,
        decisionFailures: 0,
        decisionHttpChunks: 1,
        decisionOutputTokens: null,
        decisionModels: ["jev-test-version"],
        decisionCostSources: ["estimate"],
        decisionModelCostUsd: jevCostUsd(1000),
      });
      await run("tool-discovery-agent-eval.ts", agentArgs);
      expect(decisionRequests).toBe(2);
      const warmDecisionPath = join(directory, "decision-warm.json");
      const warmDecisionArgs = [
        ...decisionArgs.map((arg) => (arg === paths.decision ? warmDecisionPath : arg)),
        "--warmup",
      ];
      await run("tool-discovery-decision-eval.ts", warmDecisionArgs);
      const warmed = await Bun.file(warmDecisionPath).json();
      expect(warmed.metadata.warmup).toBe(true);
      expect(warmed.warmups).toHaveLength(1);
      expect(warmed.warmups[0].usage.costUsd).toBe(jevCostUsd(1000));
      expect(warmed.rows).toHaveLength(1);
      expect(decisionRequests).toBe(4);
      await run("tool-discovery-decision-eval.ts", warmDecisionArgs);
      expect(decisionRequests).toBe(4);
      const warmAgentPath = join(directory, "agent-warm.json");
      const warmAgentArgs = [
        ...agentArgs.map((arg) => (arg === paths.agent ? warmAgentPath : arg)),
        "--warmup",
      ];
      await run("tool-discovery-agent-eval.ts", warmAgentArgs);
      const warmAgent = await Bun.file(warmAgentPath).json();
      expect(warmAgent.warmups.map((row: { kind: string }) => row.kind)).toEqual([
        "main-agent",
        "decision-model",
      ]);
      expect(warmAgent.rows).toHaveLength(2);
      expect(warmAgent.rows.find((row: { arm: string }) => row.arm === "after").decisionCalls).toBe(
        1,
      );
      expect(decisionRequests).toBe(6);
      await run("tool-discovery-agent-eval.ts", warmAgentArgs);
      expect(decisionRequests).toBe(6);
      await run(
        "tool-discovery-agent-eval.ts",
        [
          ...warmAgentArgs.map((arg) =>
            arg === warmAgentPath ? join(directory, "warm-with-cold-baseline.json") : arg,
          ),
          "--reuse-baseline",
          paths.agent,
        ],
        "requires a warmed baseline",
      );
      expect(decisionRequests).toBe(6);
      unavailable = true;
      const unavailablePath = join(directory, "agent-unavailable.json");
      await run(
        "tool-discovery-agent-eval.ts",
        agentArgs.map((arg) => (arg === paths.agent ? unavailablePath : arg)),
      );
      const failed = await Bun.file(unavailablePath).json();
      expect(failed.rows.find((row: { arm: string }) => row.arm === "after")).toMatchObject({
        decisionCalls: 1,
        decisionFailures: 1,
        decisionHttpChunks: 0,
        decisionModelCostUsd: null,
      });
      const failedPath = join(directory, "decision-unavailable.json");
      await run(
        "tool-discovery-decision-eval.ts",
        decisionArgs.map((arg) => (arg === paths.decision ? failedPath : arg)),
        "HTTP 401",
      );
      expect(await Bun.file(failedPath).exists()).toBe(false);
    } finally {
      server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
