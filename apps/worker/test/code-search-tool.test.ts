import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JevCircuitBreaker, JevUnavailableError, type CodeSearchWorkspace } from "@opengeni/jev";
import { createObservability } from "@opengeni/observability";
import { SandboxChannelAService, type ChannelASession } from "@opengeni/runtime/sandbox";
import { testSettings } from "@opengeni/testing";
import {
  codeSearchToolDefinitions,
  codeSearchWorkspaceFromChannel,
  createCodeSearchAttemptToolDefinition,
  type CodeSearchUsage,
} from "../src/activities/agent-turn/code-search";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const observability = createObservability(testSettings(), { component: "worker" });
const jevSettings = {
  jevApiKey: "jev-test-key-0123456789",
  jevBaseUrl: "https://jev.test",
  jevModel: "jev-latest",
  jevRequestTimeoutMs: 5_000,
};
const hasRipgrep = Bun.which("rg") !== null;

/** Runs the exact generated sandbox command in a host shell rooted at `root`. */
function hostShellSession(root: string): ChannelASession {
  return {
    exec: async (args) => {
      const proc = Bun.spawn(["/bin/sh", "-c", args.cmd], {
        cwd: resolve(root, args.workdir ?? "."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    },
    readFile: async (args) => await Bun.file(resolve(root, args.path)).bytes(),
  } as ChannelASession;
}

function fixtureWorkspace(): CodeSearchWorkspace {
  const root = mkdtempSync(join(tmpdir(), "worker-code-search-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "approval-policy.ts"),
    [
      "// Decides whether a GitHub action needs human approval.",
      "export function resolveGithubApprovalPolicy(settings: { approvalMode?: string }) {",
      "  return settings.approvalMode ?? 'ask';",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "README.md"), "Unrelated project notes.\n");
  return codeSearchWorkspaceFromChannel(
    new SandboxChannelAService({ session: hostShellSession(root) }),
  );
}

/** A Jev double: every yes/no question is "yes" with high probability. */
function fakeJevFetch(calls: { count: number }, status = 200): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.count++;
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { message: "service unavailable" } }), {
        status,
      });
    }
    const body = JSON.parse(String(init?.body)) as {
      questions: Record<string, { type: string; options?: string[] }>;
    };
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      if (question.type === "noul") answers[id] = { type: "noul", noul: 0.9 };
      else if (question.type === "choice")
        answers[id] = { type: "choice", choice: question.options?.[0] ?? "" };
      else answers[id] = { type: "score", score: 0.9 };
    }
    return new Response(
      JSON.stringify({ answers, usage: { input_tokens: 1_000 }, model: "jev-test" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

const context = { operationId: "op-1", caller: { kind: "model" } } as never;

describe("codeSearchToolDefinitions", () => {
  const base = {
    settings: jevSettings,
    backend: "docker" as const,
    observability,
    workspace: async () => fixtureWorkspace(),
  };

  test("offers the tool only when enabled, keyed, with compute, and the breaker is closed", () => {
    expect(codeSearchToolDefinitions({ ...base, enabled: false })).toEqual([]);
    expect(
      codeSearchToolDefinitions({
        ...base,
        enabled: true,
        settings: { ...jevSettings, jevApiKey: undefined },
      }),
    ).toEqual([]);
    expect(codeSearchToolDefinitions({ ...base, enabled: true, backend: "none" })).toEqual([]);

    const tripped = new JevCircuitBreaker({ failureThreshold: 1 });
    tripped.recordFailure(new JevUnavailableError("down"), 1_000);
    expect(
      codeSearchToolDefinitions({ ...base, enabled: true, breaker: tripped, now: () => 1_001 }),
    ).toEqual([]);

    const [definition] = codeSearchToolDefinitions({
      ...base,
      enabled: true,
      breaker: new JevCircuitBreaker(),
    });
    expect(definition?.modelName).toBe("code_search");
    expect(definition?.annotations?.readOnlyHint).toBe(true);
    expect(definition?.approval).toBe("none");
  });
});

describe("code_search tool execution", () => {
  test.skipIf(!hasRipgrep)("returns verbatim passages found through the sandbox", async () => {
    const calls = { count: 0 };
    const usage: CodeSearchUsage[] = [];
    const definition = createCodeSearchAttemptToolDefinition({
      settings: jevSettings,
      apiKey: jevSettings.jevApiKey,
      workspace: async () => fixtureWorkspace(),
      observability,
      recordUsage: async (entry) => {
        usage.push(entry);
      },
      breaker: new JevCircuitBreaker(),
      fetch: fakeJevFetch(calls),
    });
    const result = await definition.execute(
      {
        question: "Where is the GitHub approval policy resolved?",
        keywords: ["resolveGithubApprovalPolicy", "approvalMode", "approval"],
      },
      context,
    );
    expect(result.isError).toBe(false);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("src/approval-policy.ts");
    expect(text).toContain("resolveGithubApprovalPolicy");
    expect(calls.count).toBeGreaterThan(0);
    // Connection warm-up requests are not scored work and are not counted.
    expect(usage).toHaveLength(1);
    expect(usage[0]!.operationId).toBe("op-1");
    expect(usage[0]!.jevRequests).toBeGreaterThan(0);
    expect(usage[0]!.jevInputTokens).toBe(1_000 * usage[0]!.jevRequests);
    expect(usage[0]!.jevCostUsd).toBeGreaterThan(0);
  });

  test.skipIf(!hasRipgrep)("still returns the result when recording usage fails", async () => {
    const definition = createCodeSearchAttemptToolDefinition({
      settings: jevSettings,
      apiKey: jevSettings.jevApiKey,
      workspace: async () => fixtureWorkspace(),
      observability,
      recordUsage: async () => {
        throw new Error("database unavailable");
      },
      breaker: new JevCircuitBreaker(),
      fetch: fakeJevFetch({ count: 0 }),
    });
    const result = await definition.execute(
      { question: "Where is the approval policy?", keywords: ["approvalMode"] },
      context,
    );
    expect(result.isError).toBe(false);
  });

  test("reports invalid arguments to the model without calling Jev", async () => {
    const calls = { count: 0 };
    const definition = createCodeSearchAttemptToolDefinition({
      settings: jevSettings,
      apiKey: jevSettings.jevApiKey,
      workspace: async () => fixtureWorkspace(),
      observability,
      breaker: new JevCircuitBreaker(),
      fetch: fakeJevFetch(calls),
    });
    const result = await definition.execute({ keywords: ["x"] }, context);
    expect(result.isError).toBe(true);
    expect(calls.count).toBe(0);
  });

  test.skipIf(!hasRipgrep)(
    "reports a Jev outage, suggests searching manually, and trips the breaker",
    async () => {
      const breaker = new JevCircuitBreaker({ failureThreshold: 1 });
      const definition = createCodeSearchAttemptToolDefinition({
        settings: jevSettings,
        apiKey: jevSettings.jevApiKey,
        workspace: async () => fixtureWorkspace(),
        observability,
        breaker,
        fetch: fakeJevFetch({ count: 0 }, 503),
      });
      const result = await definition.execute(
        { question: "Where is the approval policy?", keywords: ["approvalMode"] },
        context,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain("exec_command");
      expect(breaker.isOpen(Date.now())).toBe(true);
    },
  );

  test("reports a workspace without ripgrep", async () => {
    const definition = createCodeSearchAttemptToolDefinition({
      settings: jevSettings,
      apiKey: jevSettings.jevApiKey,
      workspace: async () =>
        codeSearchWorkspaceFromChannel(
          new SandboxChannelAService({
            session: {
              exec: async () => ({
                stdout: "__OPENGENI_CODE_SEARCH_RG_END__127:0__",
                stderr: "",
                exitCode: 0,
              }),
            },
          }),
        ),
      observability,
      breaker: new JevCircuitBreaker(),
      fetch: fakeJevFetch({ count: 0 }),
    });
    const result = await definition.execute(
      { question: "Where is the approval policy?", keywords: ["approvalMode"] },
      context,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("ripgrep");
  });
});
