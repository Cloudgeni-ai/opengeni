import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JevCircuitBreaker, JevUnavailableError, type CodeSearchWorkspace } from "@opengeni/jev";
import { createObservability } from "@opengeni/observability";
import {
  ChannelAUnavailableError,
  SandboxChannelAService,
  type ChannelASession,
} from "@opengeni/runtime/sandbox";
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

/** A workspace with no files, so a search finishes without scoring anything with Jev. */
const emptyWorkspace: CodeSearchWorkspace = {
  ripgrep: async () => ({ stdout: "", exitCode: 1, truncated: false, timedOut: false }),
  readText: async () => null,
  pathKinds: async (paths) => Object.fromEntries(paths.map((path) => [path, "missing" as const])),
};

/** A breaker whose cooldown has passed, so it lets one trial call through. */
function halfOpenBreaker(): JevCircuitBreaker {
  // A long cooldown that already ran out: a trial that fails reopens it for a minute.
  const breaker = new JevCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
  breaker.recordFailure(new JevUnavailableError("down"), Date.now() - 120_000);
  expect(breaker.status().state).toBe("half_open");
  return breaker;
}

/**
 * A Jev double: every yes/no question is "yes" with high probability. With
 * `statusCheckStatus`, only the final sufficiency check gets that HTTP status.
 */
function fakeJevFetch(
  calls: { count: number },
  status = 200,
  statusCheckStatus?: number,
): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.count++;
    const failWith =
      statusCheckStatus !== undefined && String(init?.body).includes('"overall"')
        ? statusCheckStatus
        : status;
    if (failWith !== 200) {
      return new Response(JSON.stringify({ error: { message: "service unavailable" } }), {
        status: failWith,
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

/** A promise the test opens by hand, to hold a call at a chosen point. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((done) => {
    open = done;
  });
  return { open, opened };
}

const trialArgs = {
  question: "Where is the GitHub approval policy resolved?",
  keywords: ["resolveGithubApprovalPolicy", "approvalMode"],
};

function trialDefinition(
  breaker: JevCircuitBreaker,
  overrides: { workspace?: () => Promise<CodeSearchWorkspace>; fetch?: typeof fetch } = {},
) {
  return createCodeSearchAttemptToolDefinition({
    settings: jevSettings,
    apiKey: jevSettings.jevApiKey,
    workspace: overrides.workspace ?? (async () => fixtureWorkspace()),
    observability,
    breaker,
    fetch: overrides.fetch ?? fakeJevFetch({ count: 0 }),
  });
}

describe("codeSearchToolDefinitions", () => {
  const base = {
    settings: jevSettings,
    backend: "docker" as const,
    observability,
    workspace: async () => fixtureWorkspace(),
  };

  test("offers the tool only when enabled, keyed, and with compute", () => {
    expect(codeSearchToolDefinitions({ ...base, enabled: false })).toEqual([]);
    expect(
      codeSearchToolDefinitions({
        ...base,
        enabled: true,
        settings: { ...jevSettings, jevApiKey: undefined },
      }),
    ).toEqual([]);
    expect(codeSearchToolDefinitions({ ...base, enabled: true, backend: "none" })).toEqual([]);

    const [definition] = codeSearchToolDefinitions({
      ...base,
      enabled: true,
      breaker: new JevCircuitBreaker(),
    });
    expect(definition?.modelName).toBe("code_search");
    expect(definition?.annotations?.readOnlyHint).toBe(true);
    expect(definition?.approval).toBe("none");
  });

  test("a tripped breaker keeps the tool and its schema, and refuses calls at once", async () => {
    // The tool list is the start of the model's cached prompt, and sessions move
    // between workers whose breakers disagree, so Jev health must not change it.
    const closed = codeSearchToolDefinitions({
      ...base,
      enabled: true,
      breaker: new JevCircuitBreaker(),
    });
    const tripped = new JevCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
    tripped.recordFailure(new JevUnavailableError("down"), Date.now());
    expect(tripped.isOpen(Date.now())).toBe(true);
    const calls = { workspace: 0, jev: 0 };
    const whileOpen = codeSearchToolDefinitions({
      ...base,
      enabled: true,
      breaker: tripped,
      workspace: async () => {
        calls.workspace += 1;
        return fixtureWorkspace();
      },
    });
    expect(whileOpen).toHaveLength(1);
    const shape = (definitions: typeof closed) =>
      definitions.map((definition) => ({
        identity: definition.identity,
        modelName: definition.modelName,
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations,
        approval: definition.approval,
      }));
    expect(JSON.stringify(shape(whileOpen))).toBe(JSON.stringify(shape(closed)));

    const result = await whileOpen[0]!.execute(trialArgs, context);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("unavailable right now");
    expect(calls.workspace).toBe(0);
  });

  test("is not offered on a Windows Connected Machine, whose shell cannot run the search", () => {
    const enabled = {
      ...base,
      enabled: true,
      backend: "selfhosted" as const,
      breaker: new JevCircuitBreaker(),
    };
    expect(codeSearchToolDefinitions({ ...enabled, machineWorkspaceRoot: "C:\\repo" })).toEqual([]);
    expect(
      codeSearchToolDefinitions({ ...enabled, machineWorkspaceRoot: "\\\\server\\share\\repo" }),
    ).toEqual([]);
    expect(
      codeSearchToolDefinitions({ ...enabled, machineWorkspaceRoot: "/workspace/repo" }),
    ).toHaveLength(1);
    expect(codeSearchToolDefinitions({ ...enabled, machineWorkspaceRoot: null })).toHaveLength(1);
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

  test.skipIf(!hasRipgrep)(
    "counts an outage of the final status check against the breaker",
    async () => {
      const breaker = new JevCircuitBreaker({ failureThreshold: 1 });
      const definition = createCodeSearchAttemptToolDefinition({
        settings: jevSettings,
        apiKey: jevSettings.jevApiKey,
        workspace: async () => fixtureWorkspace(),
        observability,
        breaker,
        fetch: fakeJevFetch({ count: 0 }, 200, 503),
      });
      const result = await definition.execute(
        {
          question: "Where is the GitHub approval policy resolved?",
          keywords: ["resolveGithubApprovalPolicy", "approvalMode"],
        },
        context,
      );
      // The Jev-scored pack is still returned, with an unknown status.
      expect(result.isError).toBe(false);
      expect((result.content[0] as { text: string }).text).toContain(
        "evidence rating unknown (check failed)",
      );
      expect(breaker.isOpen(Date.now())).toBe(true);
    },
  );

  test("a search that never asked Jev leaves a half-open breaker for the next trial", async () => {
    const breaker = halfOpenBreaker();
    const calls = { count: 0 };
    const definition = createCodeSearchAttemptToolDefinition({
      settings: jevSettings,
      apiKey: jevSettings.jevApiKey,
      workspace: async () => emptyWorkspace,
      observability,
      breaker,
      fetch: fakeJevFetch(calls),
    });
    const result = await definition.execute(
      { question: "Where is the approval policy?", keywords: ["approvalMode"] },
      context,
    );
    expect(result.isError).toBe(false);
    expect(breaker.status().state).toBe("half_open");
    expect(breaker.status().consecutiveFailures).toBe(1);
    // The trial slot was released, so the next call may still be the trial.
    expect(breaker.tryAcquire(Date.now())?.trial).toBe(true);
  });

  test("refuses a second call while a half-open trial is in flight", async () => {
    const breaker = halfOpenBreaker();
    let releaseWorkspace!: () => void;
    const workspaceGate = new Promise<void>((open) => {
      releaseWorkspace = open;
    });
    let workspaceCalls = 0;
    const definition = createCodeSearchAttemptToolDefinition({
      settings: jevSettings,
      apiKey: jevSettings.jevApiKey,
      workspace: async () => {
        workspaceCalls++;
        await workspaceGate;
        return emptyWorkspace;
      },
      observability,
      breaker,
      fetch: fakeJevFetch({ count: 0 }),
    });
    const args = { question: "Where is the approval policy?", keywords: ["approvalMode"] };
    const trial = definition.execute(args, context);
    const refused = await definition.execute(args, context);
    expect(refused.isError).toBe(true);
    expect((refused.content[0] as { text: string }).text).toContain("unavailable");
    expect(workspaceCalls).toBe(1);
    expect(breaker.status().trialInFlight).toBe(true);

    releaseWorkspace();
    expect((await trial).isError).toBe(false);
    expect(breaker.status()).toMatchObject({ state: "half_open", trialInFlight: false });
  });

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

describe("a half-open trial ends on every path", () => {
  test("the workspace cannot be reached: the next call may be the trial", async () => {
    const breaker = halfOpenBreaker();
    const result = await trialDefinition(breaker, {
      workspace: async () => {
        throw new ChannelAUnavailableError("sandbox is gone");
      },
    }).execute(trialArgs, context);
    expect(result.isError).toBe(true);
    expect(breaker.status()).toMatchObject({
      state: "half_open",
      trialInFlight: false,
      consecutiveFailures: 1,
    });
    expect(breaker.tryAcquire(Date.now())?.trial).toBe(true);
  });

  test.skipIf(!hasRipgrep)("Jev rejects the request: the next call may be the trial", async () => {
    const breaker = halfOpenBreaker();
    const result = await trialDefinition(breaker, {
      fetch: fakeJevFetch({ count: 0 }, 400),
    }).execute(trialArgs, context);
    expect(result.isError).toBe(true);
    expect(breaker.status()).toMatchObject({
      state: "half_open",
      trialInFlight: false,
      consecutiveFailures: 1,
    });
    expect(breaker.tryAcquire(Date.now())?.trial).toBe(true);
  });

  test("the call is cancelled: the next call may be the trial", async () => {
    const breaker = halfOpenBreaker();
    const controller = new AbortController();
    const cancelling: CodeSearchWorkspace = {
      ...emptyWorkspace,
      ripgrep: async (_args, options) => {
        controller.abort(new Error("turn cancelled"));
        options.signal?.throwIfAborted();
        throw new Error("unreachable");
      },
    };
    const call = trialDefinition(breaker, { workspace: async () => cancelling }).execute(
      trialArgs,
      { ...(context as object), signal: controller.signal } as never,
    );
    await expect(call).rejects.toThrow("turn cancelled");
    expect(breaker.status()).toMatchObject({
      state: "half_open",
      trialInFlight: false,
      consecutiveFailures: 1,
    });
    expect(breaker.tryAcquire(Date.now())?.trial).toBe(true);
  });

  test.skipIf(!hasRipgrep)("Jev answers: the breaker closes", async () => {
    const breaker = halfOpenBreaker();
    const result = await trialDefinition(breaker).execute(trialArgs, context);
    expect(result.isError).toBe(false);
    expect(breaker.status()).toMatchObject({
      state: "closed",
      trialInFlight: false,
      consecutiveFailures: 0,
    });
  });

  test.skipIf(!hasRipgrep)("Jev is down: the breaker reopens", async () => {
    const breaker = halfOpenBreaker();
    const result = await trialDefinition(breaker, {
      fetch: fakeJevFetch({ count: 0 }, 503),
    }).execute(trialArgs, context);
    expect(result.isError).toBe(true);
    expect(breaker.status()).toMatchObject({
      state: "open",
      trialInFlight: false,
      consecutiveFailures: 2,
    });
    expect(breaker.tryAcquire(Date.now())).toBeNull();
  });

  test("a call admitted while closed does not end a trial that started later", async () => {
    const breaker = new JevCircuitBreaker({ failureThreshold: 1, cooldownMs: 1 });
    const early = gate();
    const noJev = trialDefinition(breaker, {
      workspace: async () => {
        await early.opened;
        return emptyWorkspace;
      },
    }).execute(trialArgs, context);
    const noWorkspace = trialDefinition(breaker, {
      workspace: async () => {
        await early.opened;
        throw new ChannelAUnavailableError("sandbox is gone");
      },
    }).execute(trialArgs, context);

    // Another call's outage opens the breaker, and its cooldown passes.
    breaker.recordFailure(new JevUnavailableError("down"), Date.now() - 1_000);
    expect(breaker.status().state).toBe("half_open");
    const late = gate();
    let trialWorkspaceCalls = 0;
    const trialTool = trialDefinition(breaker, {
      workspace: async () => {
        trialWorkspaceCalls++;
        await late.opened;
        return emptyWorkspace;
      },
    });
    const trial = trialTool.execute(trialArgs, context);
    expect(breaker.status().trialInFlight).toBe(true);

    early.open();
    expect((await noJev).isError).toBe(false);
    expect((await noWorkspace).isError).toBe(true);
    expect(breaker.status()).toMatchObject({ state: "half_open", trialInFlight: true });
    expect((await trialTool.execute(trialArgs, context)).isError).toBe(true);
    expect(trialWorkspaceCalls).toBe(1);

    late.open();
    expect((await trial).isError).toBe(false);
    expect(breaker.status()).toMatchObject({ state: "half_open", trialInFlight: false });
  });
});
