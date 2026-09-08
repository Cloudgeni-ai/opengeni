import { describe, expect, test } from "bun:test";
import { configuredProviders } from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import { compactionHistoryFixture as longHistory } from "../../../scripts/operator/compaction-history";
import {
  CompactionProviderResponseError,
  compactionProviderFailureDiagnostics,
  EmptyCompactionSummaryError,
  buildCompactionReplacementHistory,
  estimateTokens,
  prepareCompactionPromptInput,
  sanitizeHistoryItemsForModel,
  summarizeForCompaction,
} from "../src/index";

type Item = Record<string, unknown>;
type Options = NonNullable<Parameters<typeof summarizeForCompaction>[2]>;
const settings = testSettings({ openaiProvider: "azure", openaiModel: "gpt-5.6-sol" });
const missingReasoning =
  "Item 'msg_fixture' of type 'message' was provided without its required 'reasoning' item: 'rs_fixture'.";

function provider(create: (request: Item) => Promise<unknown>): NonNullable<Options["client"]> {
  return { responses: { create } } as unknown as NonNullable<Options["client"]>;
}

function response(text: string) {
  return {
    id: "resp_summary",
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    ],
  };
}

function assertProviderDependencies(input: Item[]) {
  // Azure resolves stored response ids even when their full inline content is
  // present. This provider fixture models the observed dependency, not our fix.
  for (const item of input) {
    if (item.id === "msg_fixture" && !input.some((other) => other.id === "rs_fixture")) {
      throw Object.assign(new Error(missingReasoning), {
        status: 400,
        type: "invalid_request_error",
        code: null,
        param: "input",
        headers: new Headers({ "x-request-id": "req_fixture" }),
      });
    }
  }
}

describe("portable compaction provider identity", () => {
  test("reproduces Azure's missing reasoning rejection and compacts long structured history", async () => {
    const raw = longHistory();
    const original = JSON.stringify(raw);
    expect(estimateTokens(raw)).toBeGreaterThan(244_800);
    const prepared = prepareCompactionPromptInput(sanitizeHistoryItemsForModel(raw), 214_200);
    expect(prepared.rewrittenToolOutputs).toBeGreaterThan(0);
    const inputBefore = JSON.stringify(prepared.input);
    const requests: Item[] = [];
    const usages: unknown[] = [];
    const options: Options = {
      client: provider(async (request) => {
        requests.push(JSON.parse(JSON.stringify(request)) as Item);
        assertProviderDependencies(request.input as Item[]);
        return response(
          "Fixture release is blue; inspection and patch completed. Continue verification.",
        );
      }),
      api: "responses",
      model: "gpt-5.6-sol",
      maxOutputTokens: 20_000,
      systemInstructions: "Preserve verified facts.",
      promptCacheKey: "fixture-cache",
      onUsage: (usage) => {
        usages.push(usage);
      },
    };
    const summary = await summarizeForCompaction(settings, prepared.input, options);
    expect(summary).toContain("Fixture release is blue");
    expect(requests).toHaveLength(1);
    const fixed = requests[0]!;
    expect((fixed.input as Item[]).every((item) => !("id" in item))).toBe(true);
    expect(fixed).toMatchObject({
      model: "gpt-5.6-sol",
      max_output_tokens: 20_000,
      tools: [],
      tool_choice: "none",
      instructions: "Preserve verified facts.",
      prompt_cache_key: "fixture-cache",
      stream: false,
    });
    const wire = fixed.input as Item[];
    expect(wire).toContainEqual(
      expect.objectContaining({
        type: "function_call",
        call_id: "call_49",
        arguments: JSON.stringify({ id: "resource_49", token: "literal-fixture-content" }),
      }),
    );
    expect(wire).toContainEqual(
      expect.objectContaining({
        type: "function_call_output",
        call_id: "call_49",
        status: "completed",
      }),
    );
    expect(wire).toContainEqual(
      expect.objectContaining({ type: "tool_search_call", call_id: "search_fixture" }),
    );
    expect(wire).toContainEqual(
      expect.objectContaining({ type: "tool_search_output", call_id: "search_fixture" }),
    );
    expect(wire).toContainEqual(
      expect.objectContaining({
        type: "apply_patch_call_output",
        call_id: "patch_fixture",
        status: "completed",
      }),
    );
    expect(usages).toHaveLength(1);
    const replacement = buildCompactionReplacementHistory(raw, summary);
    expect(estimateTokens(replacement)).toBeLessThan(estimateTokens(raw));
    expect(replacement.at(-1)).toMatchObject({ opengeni_context_summary: true });
    expect(sanitizeHistoryItemsForModel(replacement)).toEqual(replacement);
    expect(JSON.stringify(raw)).toBe(original);
    expect(JSON.stringify(prepared.input)).toBe(inputBefore);
  });

  test("forbids historical tool execution even when no tool schemas are supplied", async () => {
    const summary = await summarizeForCompaction(settings, longHistory(), {
      client: provider(async (request) =>
        request.tool_choice === "none"
          ? response("Verified checkpoint.")
          : {
              id: "resp_historical_tool",
              output: [
                {
                  type: "function_call",
                  id: "fc_again",
                  call_id: "call_again",
                  name: "inspect",
                  arguments: "{}",
                  status: "completed",
                },
              ],
            },
      ),
    });
    expect(summary).toBe("Verified checkpoint.");
    await expect(
      summarizeForCompaction(settings, longHistory(), {
        client: provider(async () => ({
          output: [{ type: "function_call", call_id: "again", name: "inspect", arguments: "{}" }],
        })),
      }),
    ).rejects.toBeInstanceOf(EmptyCompactionSummaryError);
  });

  test.each([
    { execution: "client", call_id: "search_fixture" },
    { execution: "client", callId: "search_fixture" },
    { providerData: { execution: "client", call_id: "search_fixture" } },
    { providerData: { call_id: "search_fixture" } },
    { providerData: { callId: "search_fixture" } },
  ])("detaches every correlated client tool-search shape: %j", async (shape) => {
    const raw: Item[] = [
      { type: "tool_search_call", id: "tsc_fixture", arguments: { query: "inspect" }, ...shape },
      { type: "tool_search_output", id: "tso_fixture", tools: [], ...shape },
    ];
    const before = structuredClone(raw);
    await summarizeForCompaction(settings, raw, {
      client: provider(async (request) => {
        const input = request.input as Item[];
        for (const item of input) {
          expect(item.id).toBeUndefined();
          expect(item.call_id).toBe("search_fixture");
        }
        return response("Verified search result.");
      }),
    });
    expect(raw).toEqual(before);
  });

  test.each([
    "codex-subscription",
    "xai-subscription",
    "vercel-gateway-managed",
    "api-key",
  ] as const)(
    "does not add Azure tool selection policy to %s; tool-only summaries still fail closed",
    async (kind) => {
      const other = {
        ...configuredProviders(settings)[0]!,
        kind,
        builtin: false,
        wireProfile: "openai" as const,
      };
      await expect(
        summarizeForCompaction(settings, [], {
          provider: other,
          client: provider(async (request) => {
            expect(request.tool_choice).toBeUndefined();
            const result = {
              ...response(""),
              status: "completed",
              output: [
                {
                  type: "function_call",
                  id: "fc_again",
                  call_id: "again",
                  name: "inspect",
                  arguments: "{}",
                  status: "completed",
                },
              ],
            };
            if (request.stream)
              return (async function* () {
                yield { type: "response.completed", response: result };
              })();
            return result;
          }),
        }),
      ).rejects.toBeInstanceOf(EmptyCompactionSummaryError);
    },
  );

  test("detaches shell and computer identities without losing actions, results or safety checks", async () => {
    const safetyChecks = [{ id: "check_fixture", code: "fixture", message: "Synthetic check" }];
    const raw: Item[] = [
      {
        type: "shell_call",
        id: "sh_fixture",
        callId: "shell_fixture",
        status: "completed",
        action: { commands: ["echo fixture"], timeoutMs: 1000, maxOutputLength: 100 },
        providerData: { id: "sh_fixture" },
      },
      {
        type: "shell_call_output",
        id: "sho_fixture",
        callId: "shell_fixture",
        output: [{ stdout: "fixture", stderr: "", outcome: { type: "exit", exitCode: 0 } }],
        providerData: { id: "sho_fixture" },
      },
      {
        type: "computer_call",
        id: "cu_fixture",
        callId: "computer_fixture",
        status: "completed",
        action: { type: "screenshot" },
        providerData: { id: "cu_fixture", pendingSafetyChecks: safetyChecks },
      },
      {
        type: "computer_call_result",
        id: "cuo_fixture",
        callId: "computer_fixture",
        output: { type: "computer_screenshot", data: "data:image/png;base64,fixture" },
        providerData: { id: "cuo_fixture", acknowledgedSafetyChecks: safetyChecks },
      },
    ];
    const before = structuredClone(raw);
    const prepared = prepareCompactionPromptInput(sanitizeHistoryItemsForModel(raw), 214_200);
    let wire: Item[] = [];
    await summarizeForCompaction(settings, prepared.input, {
      client: provider(async (request) => {
        wire = request.input as Item[];
        for (const item of wire) {
          if (typeof item.id === "string" && /^(sh|sho|cu|cuo)_fixture$/.test(item.id)) {
            throw Object.assign(new Error(missingReasoning), { status: 400 });
          }
        }
        return response("Shell succeeded; screenshot and safety acknowledgment recorded.");
      }),
    });
    expect(wire).toContainEqual(
      expect.objectContaining({
        type: "shell_call",
        call_id: "shell_fixture",
        action: { commands: ["echo fixture"], timeout_ms: 1000, max_output_length: 100 },
      }),
    );
    expect(wire).toContainEqual(
      expect.objectContaining({
        type: "shell_call_output",
        call_id: "shell_fixture",
        output: [{ stdout: "fixture", stderr: "", outcome: { type: "exit", exit_code: 0 } }],
      }),
    );
    expect(wire).toContainEqual(
      expect.objectContaining({
        type: "computer_call",
        call_id: "computer_fixture",
        action: { type: "screenshot" },
        pending_safety_checks: safetyChecks,
      }),
    );
    expect(wire).toContainEqual(
      expect.objectContaining({
        type: "computer_call_output",
        call_id: "computer_fixture",
        output: { type: "computer_screenshot", image_url: "data:image/png;base64,fixture" },
        acknowledged_safety_checks: safetyChecks,
      }),
    );
    expect(raw).toEqual(before);
  });

  test("rejects incomplete provider text before it can become a checkpoint", async () => {
    const raw = longHistory();
    const before = structuredClone(raw);
    const usages: unknown[] = [];
    await expect(
      summarizeForCompaction(settings, raw, {
        client: provider(async () => ({
          ...response("A plausible but truncated summary"),
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        })),
        onUsage: (usage) => {
          usages.push(usage);
        },
      }),
    ).rejects.toBeInstanceOf(CompactionProviderResponseError);
    expect(usages).toHaveLength(1);
    expect(raw).toEqual(before);
  });

  test("detaches web-search and reasoning ids but preserves required hosted ids and semantic links", async () => {
    const raw: Item[] = [
      {
        type: "hosted_tool_call",
        id: "ws_fixture",
        name: "web_search_call",
        status: "completed",
        providerData: {
          type: "web_search_call",
          id: "ws_fixture",
          action: { type: "search", query: "fixture" },
        },
      },
      {
        type: "reasoning",
        id: "rs_plain",
        content: [{ type: "input_text", text: "Verified context." }],
      },
      {
        type: "hosted_tool_call",
        id: "fs_fixture",
        name: "file_search_call",
        status: "completed",
        providerData: {
          type: "file_search_call",
          id: "fs_fixture",
          queries: ["fixture"],
          results: [],
        },
      },
      {
        type: "hosted_tool_call",
        id: "approval_fixture",
        name: "mcp_approval_request",
        providerData: {
          type: "mcp_approval_request",
          id: "approval_fixture",
          name: "inspect",
          arguments: "{}",
          server_label: "fixture",
        },
      },
      {
        type: "hosted_tool_call",
        name: "mcp_approval_response",
        providerData: {
          type: "mcp_approval_response",
          id: "response_fixture",
          approval_request_id: "approval_fixture",
          approve: true,
        },
      },
      {
        type: "unknown",
        id: "program_fixture",
        providerData: { type: "program", id: "program_fixture", code: "inspect()" },
      },
      {
        type: "function_call",
        id: "fc_fixture",
        callId: "call_fixture",
        name: "inspect",
        arguments: "{}",
        caller: { type: "program", callerId: "program_fixture" },
      },
      { type: "function_call_result", callId: "call_fixture", name: "inspect", output: "done" },
      {
        type: "tool_search_call",
        id: "server_search_fixture",
        arguments: { query: "fixture" },
        providerData: { execution: "server" },
      },
    ];
    const original = JSON.stringify(raw);
    let wire: Item[] = [];
    await summarizeForCompaction(settings, raw, {
      client: provider(async (request) => {
        wire = request.input as Item[];
        return response("Verified.");
      }),
    });
    expect(wire).toContainEqual(
      expect.objectContaining({
        type: "reasoning",
        id: undefined,
        summary: [{ type: "summary_text", text: "Verified context." }],
      }),
    );
    expect(wire).toContainEqual(
      expect.objectContaining({
        type: "web_search_call",
        id: undefined,
        action: { type: "search", query: "fixture" },
      }),
    );
    expect(wire).toContainEqual(
      expect.objectContaining({ type: "file_search_call", id: "fs_fixture" }),
    );
    expect(wire).toContainEqual(
      expect.objectContaining({ type: "mcp_approval_request", id: "approval_fixture" }),
    );
    expect(wire).toContainEqual(
      expect.objectContaining({
        type: "mcp_approval_response",
        approval_request_id: "approval_fixture",
      }),
    );
    expect(wire).toContainEqual(
      expect.objectContaining({ type: "program", id: "program_fixture" }),
    );
    expect(wire).toContainEqual(
      expect.objectContaining({
        type: "function_call",
        call_id: "call_fixture",
        caller: { type: "program", caller_id: "program_fixture" },
      }),
    );
    expect(wire).toContainEqual(
      expect.objectContaining({ type: "tool_search_call", id: "server_search_fixture" }),
    );
    expect(JSON.stringify(raw)).toBe(original);
  });

  test("classifies only bounded recognized provider diagnostics through nested errors", () => {
    const nested = { cause: { error: { message: missingReasoning } } };
    expect(compactionProviderFailureDiagnostics(nested)).toMatchObject({
      rejectionReason: "missing_required_reasoning_item",
    });
    const cycle: Record<string, unknown> = { message: "private input must stay private" };
    cycle.cause = cycle;
    for (const error of [
      cycle,
      { message: missingReasoning + " private trailing data" },
      { message: missingReasoning.replace("msg_fixture", "x".repeat(2000)) },
      { error: { message: "Authorization: Bearer fixture-secret" } },
    ]) {
      const diagnostics = compactionProviderFailureDiagnostics(error);
      expect(diagnostics).not.toHaveProperty("rejectionReason");
      expect(JSON.stringify(diagnostics)).not.toMatch(/private|fixture-secret|Authorization/);
    }
  });

  test("preserves history on provider failure and persists only a closed diagnosis", async () => {
    const raw = longHistory();
    const original = JSON.stringify(raw);
    const prepared = prepareCompactionPromptInput(raw, 214_200);
    try {
      await summarizeForCompaction(settings, prepared.input, {
        client: provider(async () => {
          throw Object.assign(new Error(missingReasoning), {
            status: 400,
            type: "invalid_request_error",
            error: { message: "private conversation and credential content" },
          });
        }),
      });
      throw new Error("Expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CompactionProviderResponseError);
      expect((error as CompactionProviderResponseError).diagnostics).toMatchObject({
        httpStatus: 400,
        rejectionReason: "missing_required_reasoning_item",
      });
      const persisted = JSON.stringify(error) + (error as Error).message;
      expect(persisted).not.toContain("private conversation");
      expect(persisted).not.toContain("msg_fixture");
      expect(persisted).not.toContain("rs_fixture");
    }
    expect(JSON.stringify(raw)).toBe(original);
    await expect(
      summarizeForCompaction(settings, prepared.input, {
        client: provider(async () => response("")),
      }),
    ).rejects.toBeInstanceOf(EmptyCompactionSummaryError);
    expect(JSON.stringify(raw)).toBe(original);
  });
});
