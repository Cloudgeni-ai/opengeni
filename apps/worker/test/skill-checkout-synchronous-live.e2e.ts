// Opt-in OPE-701 source acceptance. This never provisions infrastructure,
// reads connection/database credentials, or publishes a real workspace Skill.
// OPENGENI_OPE701_ACCEPTANCE=deterministic: scripted model, NOT live inference.
// OPENGENI_OPE701_ACCEPTANCE=codex: read-only existing CODEX_HOME/auth.json.
// Both require OPENGENI_OPE701_CANDIDATE_SHA to pin the parent's ready checkout.
import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";
import { setTracingDisabled } from "@openai/agents";
import type { UnixLocalSandboxClient } from "@openai/agents/sandbox/local";
import type { ModalRouterProviderCommand } from "@opengeni/contracts";
import { resolveModelProvider, withCodexCatalogProvider } from "@opengeni/config";
import {
  accessTokenExpiry,
  buildModelResolver,
  CODEX_CLIENT_VERSION,
  CODEX_FALLBACK_MODEL_SLUGS,
  codexRequestStorage,
  parseIdToken,
  type CodexRequestContext,
} from "@opengeni/codex";
import { assistantMessage, functionCall, ScriptedModel, testSettings } from "@opengeni/testing";
import {
  buildOpenGeniAgent,
  buildModelInstance,
  buildProviderClient,
  prepareAgentTools,
  runAgentStream,
  type TurnToolCancellationFence,
} from "@opengeni/runtime";
import {
  createSandboxClientForBackend,
  RoutingSandboxSession,
  SandboxChannelAService,
} from "@opengeni/runtime/sandbox";
import {
  parseExecBannerExitCode,
  stripExecBanner,
  type ChannelAExecArgs,
  type ChannelASession,
} from "../../../packages/runtime/src/sandbox/channel-a";
import type {
  ProviderCommandOutput,
  ProviderCommandPersistence,
} from "../../../packages/runtime/src/sandbox/provider-command-session";
import { installModalCommandSession } from "../../../packages/runtime/src/sandbox/providers/modal-command-session";
import {
  createSkillCheckoutAttemptToolDefinition,
  createSkillPublishAttemptToolDefinition,
} from "../src/activities/agent-turn/skill-checkout";
import type { SkillSaveRequest } from "../src/activities/agent-turn/skill-save";

const execFileAsync = promisify(execFile);
const mode = process.env.OPENGENI_OPE701_ACCEPTANCE;
const directory = "skills/ope-701-fixture";
const executeCommand = `bash ${directory}/scripts/fixture.sh`;
const skillId = "11111111-1111-4111-8111-111111111701";
const revisionId = "22222222-2222-4222-8222-222222222701";
const publishOperationId = "33333333-3333-4333-8333-333333333701";
const smallFiles = [
  {
    path: "SKILL.md",
    content:
      "---\nname: ope-701-fixture\ndescription: Harmless filesystem acceptance fixture\n---\nRun scripts/fixture.sh. No external services or credentials are used.\n",
  },
  {
    path: "scripts/fixture.sh",
    content: "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'fixture-execute-ok\\n'\n",
  },
  {
    path: "references/facts.md",
    content: Array.from(
      { length: 700 },
      (_, index) => `fixture fact ${index}: harmless data\n`,
    ).join(""),
  },
];
const publishArgs = {
  operationId: publishOperationId,
  skillId,
  expectedRevisionId: revisionId,
  expectedScopeVersion: 1,
  directory,
  reason: "Read-only traversal of an isolated acceptance fixture",
};

async function sourceIdentity() {
  const git = async (...args: string[]) => (await execFileAsync("git", args)).stdout.trim();
  const head = await git("rev-parse", "HEAD");
  expect(process.env.OPENGENI_OPE701_CANDIDATE_SHA).toMatch(/^[0-9a-f]{40}$/u);
  expect(head).toBe(process.env.OPENGENI_OPE701_CANDIDATE_SHA!);
  expect(await git("branch", "--show-current")).toBe("fix/ope-701-filesystem-command-completion");
  const sourcePaths = [
    "packages/runtime/src/sandbox/channel-a.ts",
    "packages/runtime/src/sandbox/routing/routing-session.ts",
    "packages/runtime/src/sandbox/synchronous-command.ts",
    "packages/runtime/src/sandbox/turn-tool-cancellation.ts",
    "apps/worker/src/activities/agent-turn/tool-environment.ts",
    "apps/worker/src/activities/agent-turn/skill-checkout.ts",
    "apps/worker/src/activities/agent-turn/skill-transfer.ts",
  ];
  expect(await git("diff", "HEAD", "--", ...sourcePaths)).toBe("");
  const hashes = await git("hash-object", ...sourcePaths);
  return { head, hashes: hashes.split("\n") };
}

function readOnlyCodexContext(): CodexRequestContext {
  const path = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  let auth: {
    tokens?: { access_token?: string; id_token?: string; account_id?: string };
  };
  try {
    auth = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Live Codex acceptance blocked: existing local Codex auth.json unavailable.");
  }
  const accessToken = auth.tokens?.access_token ?? "";
  const expires = accessTokenExpiry(accessToken);
  if (!expires || expires.getTime() <= Date.now()) {
    throw new Error("Live Codex acceptance blocked: local subscription token missing or expired.");
  }
  const identity = parseIdToken(auth.tokens?.id_token ?? "");
  const token = {
    accessToken,
    chatgptAccountId: identity.chatgptAccountId ?? auth.tokens?.account_id ?? null,
    isFedramp: identity.isFedramp,
  };
  return {
    clientVersion: CODEX_CLIENT_VERSION,
    getToken: async () => token,
    // The acceptance fixture must never refresh or write credentials.
    refresh: async () => token,
    resolveModel: buildModelResolver(CODEX_FALLBACK_MODEL_SLUGS),
  };
}

/** Real local processes, with deliberately paginated/delayed observation.
 * This is a Modal protocol adapter fixture, NOT a live Modal sandbox. Each
 * Start executes once using the real local SDK. Terminal observation is held
 * behind two empty running pages, including after all payload bytes arrived.
 */
function delayedTerminalBackend(native: ChannelASession) {
  type Execution = {
    command: ModalRouterProviderCommand;
    output: Buffer;
    physicalExitCode: number;
    offset: number;
    emptyPages: number;
    immediate: boolean;
  };
  const executions = new Map<string, Execution>();
  const legacyHandles = new Map<number, Execution>();
  let nextLegacyHandle = 10_000;
  const rejectedCommandBytes: number[] = [];
  const starts: string[] = [];
  const reads: Array<{
    execution: string;
    from: number;
    to: number;
    exitCode: number | null;
    immediate: boolean;
  }> = [];
  const captures: Array<{ execution: string; from: number; to: number; eof: boolean }> = [];
  const stored = new Map<string, ModalRouterProviderCommand>();
  const start = async (args: ChannelAExecArgs): Promise<Execution> => {
    let result: string;
    try {
      result = await native.execCommand!({
        ...args,
        tty: false,
        yieldTimeMs: 10_000,
        maxOutputTokens: 256_000,
      });
    } catch (error) {
      rejectedCommandBytes.push(Buffer.byteLength(args.cmd));
      throw error;
    }
    const exitCode = parseExecBannerExitCode(result);
    if (exitCode === null)
      throw new Error("Acceptance native process did not reach terminal proof.");
    const command: ModalRouterProviderCommand = {
      kind: "modal-router-v1",
      sandboxId: "sb-ope-701-fixture",
      taskId: "task-ope-701-fixture",
      execId: crypto.randomUUID(),
      streams: {
        stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
        stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
      },
    };
    const execution = {
      command,
      output: Buffer.from(stripExecBanner(result)),
      physicalExitCode: exitCode,
      offset: 0,
      emptyPages: 0,
      immediate: args.cmd.includes(executeCommand),
    };
    starts.push(command.execId);
    executions.set(command.execId, execution);
    return execution;
  };
  const read = (execution: Execution, baseline = execution.command): ProviderCommandOutput => {
    const from = baseline.streams.stdout.byteOffset;
    expect(from).toBe(execution.offset);
    const bytes = execution.output.subarray(from, execution.immediate ? undefined : from + 1024);
    const text = bytes.toString("utf8");
    // Fixture files and framing are ASCII; exact byte cursors need no UTF-8 remainder.
    expect(Buffer.byteLength(text)).toBe(bytes.length);
    execution.offset += bytes.length;
    const hasPayload = execution.offset < execution.output.length;
    const terminal = execution.immediate || (!hasPayload && !text && execution.emptyPages++ >= 2);
    const exitCode = terminal ? execution.physicalExitCode : null;
    const command = structuredClone(baseline);
    command.streams.stdout = {
      ...command.streams.stdout,
      byteOffset: execution.offset,
      eof: terminal,
      exitCode,
    };
    command.streams.stderr = { ...command.streams.stderr, eof: terminal, exitCode };
    execution.command = command;
    reads.push({
      execution: command.execId,
      from,
      to: execution.offset,
      exitCode,
      immediate: execution.immediate,
    });
    return {
      command,
      expected: structuredClone(baseline),
      chunks: text ? [{ stream: "stdout", chunkId: `${from}`, text }] : [],
      exitCode,
    };
  };
  const banner = (handle: number, page: ProviderCommandOutput) =>
    `${page.exitCode === null ? `Process running with session ID ${handle}` : `Process exited with code ${page.exitCode}`}\nOutput:\n${page.chunks.map((chunk) => chunk.text).join("")}`;
  const backend: ChannelASession & { state: unknown } = {
    state: (native as ChannelASession & { state: unknown }).state,
    supportsPty: () => true,
    execCommand: async (args) => {
      const execution = await start(args);
      const handle = nextLegacyHandle++;
      legacyHandles.set(handle, execution);
      return banner(handle, read(execution));
    },
    writeStdin: async (args) => {
      expect(args.chars ?? "").toBe("");
      const execution = legacyHandles.get(args.sessionId);
      if (!execution) throw new Error("Unknown acceptance process handle.");
      const page = read(execution);
      if (page.exitCode !== null) legacyHandles.delete(args.sessionId);
      return banner(args.sessionId, page);
    },
  };
  installModalCommandSession(backend, {
    start: async (args) => (await start(args)).command,
    read: async (command) => {
      const execution = executions.get(command.execId)!;
      return read(execution, command as ModalRouterProviderCommand);
    },
    readProbe: async () => {
      throw new Error("Acceptance does not use materialization probes.");
    },
    write: async () => {
      throw new Error("Acceptance must never send process stdin.");
    },
  });
  const persistence = (command: ModalRouterProviderCommand): ProviderCommandPersistence => {
    stored.set(command.execId, structuredClone(command));
    return {
      load: async () => structuredClone(stored.get(command.execId)!),
      acknowledge: async (next) => next,
      reserveInput: async () => {
        throw new Error("Acceptance must never reserve stdin.");
      },
      captureRouterPage: async (page) => {
        expect(page.expected).toEqual(stored.get(command.execId)!);
        expect(page.command.execId).toBe(command.execId);
        captures.push({
          execution: command.execId,
          from: page.expected.streams.stdout.byteOffset,
          to: page.command.streams.stdout.byteOffset,
          eof: page.command.streams.stdout.eof,
        });
        stored.set(command.execId, structuredClone(page.command));
        return { command: page.command, captured: true };
      },
    };
  };
  return { backend, starts, reads, captures, persistence, legacyHandles, rejectedCommandBytes };
}

for (const scenario of [
  { route: "deterministic", multibatch: false },
  { route: "deterministic", multibatch: true },
  { route: "codex", multibatch: false },
] as const) {
  const { route, multibatch } = scenario;
  test.skipIf(mode !== route)(
    `OPE-701 candidate agent tool cycle (${route}, ${multibatch ? "multi-command batch" : "small"}; delayed terminal adapter, real local processes)`,
    async () => {
      const source = await sourceIdentity();
      const files = multibatch
        ? [
            ...smallFiles.slice(0, 2),
            ...Array.from({ length: 6 }, (_, index) => ({
              path: `references/facts-${index}.md`,
              content: `# Fixture ${index}\n` + "h".repeat(12_000),
            })),
          ]
        : smallFiles;
      // Fail before sandbox creation if the explicitly requested live route is unavailable.
      const codexContext = route === "codex" ? readOnlyCodexContext() : null;
      const baseSettings = testSettings({
        sandboxBackend: "local",
        webSearchEnabled: false,
        lazyToolSearchEnabled: false,
        codexSubscriptionEnabled: route === "codex",
      });
      const settings = route === "codex" ? withCodexCatalogProvider(baseSettings) : baseSettings;
      setTracingDisabled(true);
      const client = createSandboxClientForBackend("local", settings) as UnixLocalSandboxClient;
      const native = await client.create({} as never);
      const root = (native as unknown as { state: { workspaceRootPath: string } }).state
        .workspaceRootPath;
      const delayed = delayedTerminalBackend(native as unknown as ChannelASession);
      const settlements: unknown[] = [];
      const terminalProofs: unknown[] = [];
      const events: unknown[] = [];
      const results: Array<{ tool: string; output: unknown; starts: number }> = [];
      let admissions = 0;
      let backgroundAdoptions = 0;
      let foregroundTerminalObservations = 0;
      let fence: TurnToolCancellationFence | undefined;
      let saved: SkillSaveRequest | undefined;
      const resolved = {
        session: delayed.backend,
        sandboxId: null,
        kind: "local",
        leaseEpoch: 1,
        providerInstanceId: root,
        activeEpoch: 0,
      };
      const routing = new RoutingSandboxSession({
        defaultResolved: resolved,
        readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
        resolveActiveBackend: async () => resolved,
        beforeMutation: async () => ++admissions,
        providerCommandHandle: (admission) => admission as number,
        providerCommandPersistence: (process) =>
          delayed.persistence(process.providerCommand as ModalRouterProviderCommand),
        captureProcessOutput: async () => {
          throw new Error("Modal byte cursors must use atomic capture, never legacy append/ack.");
        },
        adoptProcessAsBackgroundCommand: async () => {
          backgroundAdoptions++;
          throw new Error("Acceptance internal work must not adopt background lifetime.");
        },
        observeProcessTerminal: async () => {
          foregroundTerminalObservations++;
        },
        afterMutation: async (settlement) => {
          settlements.push(settlement);
        },
        settleProcess: async (input) => {
          terminalProofs.push(input.proof);
        },
      });
      const fs = new SandboxChannelAService({
        session: routing as unknown as ChannelASession,
        commandRunner: async (session: ChannelASession, args: ChannelAExecArgs) => {
          if (!fence) throw new Error("Fixture requires the actual turn cancellation controller.");
          return await fence.runSandboxCommandSynchronous(session, args);
        },
        workspaceRoot: root,
        leaseEpoch: 1,
        emit: async (items) => {
          events.push(...items);
        },
      });
      const checkout = createSkillCheckoutAttemptToolDefinition({
        authorize: async () => {},
        load: async (requested) => {
          expect(requested).toBe(skillId);
          return { skillId, revisionId, scopeVersion: 1, files };
        },
        filesystem: async () => fs,
      });
      const publish = createSkillPublishAttemptToolDefinition({
        authorize: async () => {},
        filesystem: async () => fs,
        save: async (request) => {
          saved = request;
          return {
            operationId: request.operationId,
            skillId,
            revisionId,
            outcome: "preserved",
            replayed: false,
          };
        },
      });
      for (const definition of [checkout, publish]) {
        const execute = definition.execute;
        definition.execute = async (...args) => {
          const before = delayed.starts.length;
          let output;
          try {
            output = await execute(...args);
          } catch (error) {
            const causes: string[] = [];
            let current: unknown = error;
            for (let index = 0; index < 6 && current instanceof Error; index++) {
              causes.push(`${current.name}: ${current.message}`);
              current = current.cause;
            }
            console.log(JSON.stringify({ adapterFailure: definition.modelName, causes }));
            throw error;
          }
          results.push({
            tool: definition.modelName,
            output,
            starts: delayed.starts.length - before,
          });
          expect([...delayed.legacyHandles.keys()]).toEqual([]);
          for (let handle = 1; handle <= admissions; handle++) {
            expect(routing.hasRetainedProcess(handle)).toBe(false);
          }
          return output;
        };
      }
      const prepared = await prepareAgentTools(settings, [], {
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        executionGeneration: 1,
        attemptToolDefinitions: [checkout, publish],
      }).catch(async (error) => {
        await native.close();
        throw error;
      });
      const scripted = new ScriptedModel([
        {
          output: [functionCall("skill_checkout", { skill: skillId, directory }, "checkout-fresh")],
        },
        {
          output: [
            functionCall(
              "exec_command",
              { cmd: executeCommand, tty: false, yield_time_ms: 10_000, max_output_tokens: 4096 },
              "execute-fixture",
            ),
          ],
        },
        {
          output: [
            functionCall("skill_checkout", { skill: skillId, directory }, "checkout-unchanged"),
          ],
        },
        { output: [functionCall("skill_publish", publishArgs, "publish-traversal")] },
        { output: [assistantMessage("ope-701-fixture-ok")] },
      ]);
      const modelId =
        process.env.OPENGENI_OPE701_CODEX_MODEL ?? `codex/${CODEX_FALLBACK_MODEL_SLUGS[1]}`;
      const provider = resolveModelProvider(settings, modelId)?.provider;
      if (codexContext) expect(provider?.kind).toBe("codex-subscription");
      const model = codexContext
        ? buildModelInstance(provider!, buildProviderClient(provider!, settings), modelId)
        : scripted;
      const agent = buildOpenGeniAgent(settings, [], {
        model,
        skillCatalog: [
          { id: skillId, name: "ope-701-fixture", description: "Harmless acceptance fixture" },
        ],
        mcpServers: prepared.mcpServers,
        onToolCancellationFence: (value) => {
          fence = value;
        },
        sessionInstructions: `Only handle this isolated fixture: call skill_checkout with skill ${skillId} and directory ${directory}; run exec_command with cmd ${executeCommand}; repeat the same checkout, then call skill_publish with ${JSON.stringify(publishArgs)}. Do not change files or use other services. Confirm all four tools succeeded before replying exactly ope-701-fixture-ok.`,
      });
      try {
        const run = async () => {
          const stream = await runAgentStream(
            agent,
            "Run the harmless fixture acceptance cycle.",
            settings,
            {
              ownedSandbox: { client, session: routing, deferredSetup: true },
              onRuntimeEvent: async (event) => {
                events.push(event);
              },
            },
          );
          for await (const event of stream) events.push(event);
          await stream.completed;
          return stream;
        };
        const result = codexContext
          ? await codexRequestStorage.run(codexContext, run)
          : await run();
        if (route === "deterministic" && results.length !== 3) {
          const input = scripted.requests.at(-1)?.input;
          console.log(
            JSON.stringify({
              toolCycleDiagnostics: Array.isArray(input)
                ? input.filter((item) => item.type === "function_call_result")
                : [],
            }),
          );
        }
        expect(result.finalOutput).toBe("ope-701-fixture-ok");
        expect(results.map((item) => item.tool)).toEqual([
          "skill_checkout",
          "skill_checkout",
          "skill_publish",
        ]);
        if (multibatch) {
          expect(results.map((item) => item.starts)).toEqual([3, 1, files.length + 3]);
        } else {
          expect(results.map((item) => item.starts)).toEqual([1, 1, 6]);
        }
        expect(JSON.stringify(results[0]!.output)).toContain(`"written":${files.length}`);
        expect(JSON.stringify(results[1]!.output)).toContain(`"unchanged":${files.length}`);
        expect(saved?.files).toHaveLength(files.length);
        expect(
          isDeepStrictEqual(
            new Map(saved!.files.map((file) => [file.path, file.content])),
            new Map(files.map((file) => [file.path, file.content])),
          ),
        ).toBe(true);
        expect(delayed.starts.length).toBeGreaterThanOrEqual(9);
        expect(new Set(delayed.starts).size).toBe(delayed.starts.length);
        expect(delayed.reads.some((read) => read.to > (multibatch ? 8_000 : 20_000))).toBe(true);
        expect(delayed.reads.filter((read) => read.exitCode !== null)).toHaveLength(
          delayed.starts.length,
        );
        expect(backgroundAdoptions).toBe(0);
        expect(foregroundTerminalObservations).toBe(0);
        expect(terminalProofs).toHaveLength(multibatch ? results[0]!.starts - 1 : 2);
        for (const proof of terminalProofs) {
          expect(proof).toEqual({
            outcome: "exited",
            exitCode: 0,
            reason: "provider_exit_banner",
          });
        }
        const pagesByExecution = new Map<string, typeof delayed.reads>();
        for (const page of delayed.reads) {
          const group = pagesByExecution.get(page.execution) ?? [];
          group.push(page);
          pagesByExecution.set(page.execution, group);
        }
        for (const pages of pagesByExecution.values()) {
          expect(pages[0]!.from).toBe(0);
          for (let index = 1; index < pages.length; index++) {
            expect(pages[index]!.from).toBe(pages[index - 1]!.to);
            expect(pages[index]!.immediate).toBe(pages[0]!.immediate);
          }
          expect(pages.at(-1)!.exitCode).toBe(0);
          if (!pages[0]!.immediate) {
            expect(pages.slice(0, -1).filter((page) => page.from === page.to)).toHaveLength(2);
          }
        }
        const largestRead = [...pagesByExecution.values()].sort(
          (left, right) => right.at(-1)!.to - left.at(-1)!.to,
        )[0]!;
        const capturesByExecution = new Map<string, typeof delayed.captures>();
        for (const capture of delayed.captures) {
          const group = capturesByExecution.get(capture.execution) ?? [];
          group.push(capture);
          capturesByExecution.set(capture.execution, group);
        }
        for (const captures of capturesByExecution.values()) {
          for (let index = 1; index < captures.length; index++) {
            expect(captures[index]!.from).toBe(captures[index - 1]!.to);
          }
        }
        const cursorTrajectories = [...pagesByExecution.entries()].map(([execution, pages]) => ({
          execution,
          offsets: pages.map((page) => [page.from, page.to]),
          emptyRunningPages: pages.slice(0, -1).filter((page) => page.from === page.to).length,
          terminalExitCode: pages.at(-1)!.exitCode,
        }));
        const capturedCursorTrajectories = [...capturesByExecution.entries()].map(
          ([execution, pages]) => ({
            execution,
            offsets: pages.map((page) => [page.from, page.to]),
            terminal: pages.at(-1)!.eof,
          }),
        );
        await fence!.waitForQuiescence();
        expect(JSON.stringify(events)).not.toMatch(
          /command\.background|background_command_completed|background_command_result|session\.command\.finished/u,
        );
        if (route === "deterministic") {
          expect(scripted.calls).toBe(5);
          expect(JSON.stringify(scripted.requests.at(-1)!.input)).toContain("fixture-execute-ok");
        }
        expect(await sourceIdentity()).toEqual(source);
        console.log(
          JSON.stringify({
            acceptance: route,
            scenario: multibatch ? "multi-command batch" : "small",
            liveInference: route === "codex",
            model: codexContext ? modelId : "ScriptedModel",
            transport: codexContext
              ? "buildAgent -> codex-subscription Responses -> codexSubscriptionFetch"
              : "buildAgent -> ScriptedModel -> native tool gateway",
            source,
            sandbox: "real local SDK processes; delayed Modal-protocol adapter fixture",
            starts: delayed.starts.length,
            admissions,
            toolStarts: results.map((item) => ({ tool: item.tool, starts: item.starts })),
            cursorTrajectories,
            capturedCursorTrajectories,
            largestOutput: {
              bytes: largestRead.at(-1)!.to,
              pages: largestRead.length,
              startOffset: largestRead[0]!.from,
              finalOffset: largestRead.at(-1)!.to,
              emptyRunningPages: largestRead.slice(0, -1).filter((page) => page.from === page.to)
                .length,
              terminalExitCode: largestRead.at(-1)!.exitCode,
            },
            terminalProofs,
            mutationSettlements: settlements.length,
            backgroundAdoptions,
            foregroundTerminalObservations,
            publishedFixtureFiles: saved?.files.length,
            durableDatabaseEventsVerified: false,
            liveModalVerified: false,
          }),
        );
      } finally {
        await prepared.close();
        await native.close();
      }
    },
    180_000,
  );
}
