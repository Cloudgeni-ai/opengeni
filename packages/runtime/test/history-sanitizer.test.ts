import { describe, expect, test } from "bun:test";
import {
  computerCallNormalizingFetch,
  normalizeComputerCallActions,
  rewriteComputerCallsToActionsOnly,
  rewriteEmptyComputerCallOutputImageUrls,
  sanitizeHistoryItemsForModel,
  stripReasoningEncryptedContent,
} from "../src/history-sanitizer";

// The exact 1×1 transparent PNG placeholder used by the SDK (agents-core
// toolExecution.mjs) and now also by our wire-level backstop.
const PLACEHOLDER =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

// Item shapes mirror the SDK's canonical history representation
// (`type` discriminator, camelCase `callId`) that is persisted verbatim into
// session_history_items and replayed into the Responses API.
function reasoning(id: string) {
  return { type: "reasoning", id, content: [{ type: "input_text", text: "thinking" }] };
}
function userMessage(text: string) {
  return { type: "message", role: "user", content: text };
}
function assistantMessage(text: string) {
  return { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] };
}
function functionCall(callId: string, name = "tool") {
  return { type: "function_call", callId, name, arguments: "{}", status: "completed" };
}
function functionResult(callId: string) {
  return { type: "function_call_result", callId, status: "completed", output: { type: "text", text: "ok" } };
}

describe("sanitizeHistoryItemsForModel", () => {
  test("drops an orphaned function_call_result whose function_call is absent", () => {
    // This is the session-bricking corruption: a tool output replayed without
    // its tool call (observed live for journal / goal-pause tools near turn
    // boundaries). The API 400s on the whole request until it is removed.
    const items = [
      userMessage("do the thing"),
      functionResult("call_orphan"),
      assistantMessage("done"),
    ];
    const result = sanitizeHistoryItemsForModel(items);
    expect(result).toEqual([items[0], items[2]]);
    expect(result.some((item) => (item as any).type === "function_call_result")).toBe(false);
  });

  test("drops a result whose call appears only AFTER it (still an orphan to the API)", () => {
    const call = functionCall("call_late");
    const result = functionResult("call_late");
    // Result before its call: the API still rejects it.
    const items = [userMessage("hi"), result, call];
    const sanitized = sanitizeHistoryItemsForModel(items);
    // The result is dropped; the now-dangling call is dropped too (no result
    // after it), leaving just the user message.
    expect(sanitized).toEqual([items[0]]);
  });

  test("drops a dangling function_call that has no result", () => {
    const items = [
      userMessage("hi"),
      reasoning("rs_1"),
      functionCall("call_dangling"),
    ];
    const result = sanitizeHistoryItemsForModel(items);
    // The dangling call is dropped, and the reasoning item that produced it is
    // dropped with it (Responses API ties reasoning to its following call).
    expect(result).toEqual([items[0]]);
  });

  test("keeps reasoning when its following call is well-formed", () => {
    const items = [
      userMessage("hi"),
      reasoning("rs_keep"),
      functionCall("call_ok"),
      functionResult("call_ok"),
      assistantMessage("done"),
    ];
    const result = sanitizeHistoryItemsForModel(items);
    expect(result).toEqual(items);
  });

  test("leaves a well-formed history byte-identical (same references and order)", () => {
    const items = [
      userMessage("first"),
      functionCall("call_a"),
      functionResult("call_a"),
      assistantMessage("a done"),
      userMessage("second"),
      reasoning("rs_b"),
      functionCall("call_b"),
      functionResult("call_b"),
      assistantMessage("b done"),
    ];
    const result = sanitizeHistoryItemsForModel(items);
    expect(result).toHaveLength(items.length);
    result.forEach((item, index) => {
      // Same reference, not a clone — the valid items pass through untouched.
      expect(item).toBe(items[index]);
    });
  });

  test("keeps valid pairs while dropping an orphan in a parallel tool-call batch", () => {
    // Parallel batch where one call/result pair is intact and a second result
    // was orphaned (its call lost to a write-path desync). Only the orphan goes.
    const items = [
      userMessage("go"),
      functionCall("call_a"),
      functionCall("call_b"),
      functionResult("call_a"),
      functionResult("call_b"),
      functionResult("call_ghost"),
      assistantMessage("done"),
    ];
    const result = sanitizeHistoryItemsForModel(items);
    expect(result).toEqual([
      items[0], items[1], items[2], items[3], items[4], items[6],
    ]);
  });

  test("accepts snake_case call_id correlation as well as camelCase callId", () => {
    const call = { type: "function_call", call_id: "call_snake", name: "t", arguments: "{}" };
    const orphan = { type: "function_call_result", call_id: "call_missing", output: { type: "text", text: "x" } };
    const result = { type: "function_call_result", call_id: "call_snake", output: { type: "text", text: "ok" } };
    const items = [userMessage("hi"), call, result, orphan];
    const sanitized = sanitizeHistoryItemsForModel(items);
    expect(sanitized).toEqual([items[0], call, result]);
  });

  test("empty input returns empty", () => {
    expect(sanitizeHistoryItemsForModel([])).toEqual([]);
  });

  test("does not mutate the input array or its items", () => {
    const orphan = functionResult("call_x");
    const items = [userMessage("hi"), orphan];
    const snapshot = JSON.stringify(items);
    sanitizeHistoryItemsForModel(items);
    expect(items).toHaveLength(2);
    expect(JSON.stringify(items)).toBe(snapshot);
  });
});

describe("normalizeComputerCallActions", () => {
  test("normalizes a computer_call carrying BOTH action and actions to exactly one (keeps actions)", () => {
    // The live Azure 400: a freshly-emitted screenshot computer_call carries
    // both the legacy singular `action` and the GA batched `actions`. The GA
    // computer tool (how gpt-5.5 serializes it) accepts ONLY the plural
    // `actions`; the `action`-only form is rejected too. So we keep `actions`.
    const conflicted = {
      type: "computer_call",
      callId: "cu_1",
      status: "completed",
      action: { type: "screenshot" },
      actions: [{ type: "screenshot" }],
    };
    const items = [userMessage("take a screenshot"), conflicted];
    const result = normalizeComputerCallActions(items);
    const normalized = result[1] as Record<string, unknown>;
    expect("actions" in normalized).toBe(true);
    expect("action" in normalized).toBe(false);
    expect(normalized.actions).toEqual([{ type: "screenshot" }]);
    // Other identifying fields survive untouched.
    expect(normalized.callId).toBe("cu_1");
    expect(normalized.status).toBe("completed");
    // The non-computer item passes through by reference (byte-identical).
    expect(result[0]).toBe(items[0]);
  });

  test("passes through items without the conflict byte-identical (same references)", () => {
    const actionOnly = { type: "computer_call", callId: "cu_a", status: "completed", action: { type: "screenshot" } };
    const actionsOnly = { type: "computer_call", callId: "cu_b", status: "completed", actions: [{ type: "click", x: 1, y: 2 }] };
    const items = [userMessage("hi"), actionOnly, functionCall("call_1"), actionsOnly];
    const result = normalizeComputerCallActions(items);
    // No conflict anywhere → every item is the same reference, order preserved.
    expect(result).toHaveLength(items.length);
    result.forEach((item, i) => expect(item).toBe(items[i]));
  });

  test("does not mutate the input array or its items", () => {
    const conflicted = {
      type: "computer_call",
      callId: "cu_1",
      status: "completed",
      action: { type: "screenshot" },
      actions: [{ type: "screenshot" }],
    };
    const items = [conflicted];
    const snapshot = JSON.stringify(items);
    normalizeComputerCallActions(items);
    expect(JSON.stringify(items)).toBe(snapshot);
    expect("actions" in conflicted).toBe(true);
  });

  test("empty input returns empty", () => {
    expect(normalizeComputerCallActions([])).toEqual([]);
  });
});

describe("rewriteComputerCallsToActionsOnly", () => {
  test("collapses a both-fields computer_call to actions-only", () => {
    const body = {
      model: "gpt-5.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "screenshot" }] },
        {
          type: "computer_call",
          call_id: "cu_1",
          status: "completed",
          action: { type: "screenshot" },
          actions: [{ type: "screenshot" }],
        },
      ],
    };
    const changed = rewriteComputerCallsToActionsOnly(body);
    expect(changed).toBe(true);
    const cc = body.input[1] as Record<string, unknown>;
    expect("action" in cc).toBe(false);
    expect(cc.actions).toEqual([{ type: "screenshot" }]);
    // Identifying fields and the non-computer item survive.
    expect(cc.call_id).toBe("cu_1");
    expect(body.input[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "screenshot" }],
    });
  });

  test("wraps an action-only computer_call into actions-only", () => {
    const body = {
      input: [{ type: "computer_call", call_id: "cu_x", action: { type: "click", x: 3, y: 4 } }],
    };
    const changed = rewriteComputerCallsToActionsOnly(body);
    expect(changed).toBe(true);
    const cc = body.input[0] as Record<string, unknown>;
    expect("action" in cc).toBe(false);
    expect(cc.actions).toEqual([{ type: "click", x: 3, y: 4 }]);
  });

  test("leaves an already actions-only computer_call unchanged (no-op)", () => {
    const body = {
      input: [{ type: "computer_call", call_id: "cu_y", actions: [{ type: "scroll" }] }],
    };
    const changed = rewriteComputerCallsToActionsOnly(body);
    expect(changed).toBe(false);
  });

  test("ignores bodies with no computer_call and non-array input", () => {
    expect(rewriteComputerCallsToActionsOnly({ input: [{ type: "message" }] })).toBe(false);
    expect(rewriteComputerCallsToActionsOnly({ input: "nope" })).toBe(false);
    expect(rewriteComputerCallsToActionsOnly(null)).toBe(false);
    expect(rewriteComputerCallsToActionsOnly("string")).toBe(false);
  });
});

describe("computerCallNormalizingFetch", () => {
  test("rewrites a both-fields computer_call request body to actions-only on the wire", async () => {
    let seenBody: string | undefined;
    const base = (async (_url: unknown, init?: { body?: unknown }) => {
      seenBody = init?.body as string;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const wrapped = computerCallNormalizingFetch(base);
    const originalBody = JSON.stringify({
      input: [
        {
          type: "computer_call",
          call_id: "cu_1",
          action: { type: "screenshot" },
          actions: [{ type: "screenshot" }],
        },
      ],
    });
    await wrapped("https://aoai/openai/v1/responses", { method: "POST", body: originalBody });

    expect(seenBody).toBeDefined();
    const sent = JSON.parse(seenBody as string);
    const cc = sent.input[0];
    expect("action" in cc).toBe(false);
    expect(cc.actions).toEqual([{ type: "screenshot" }]);
  });

  test("forwards a non-computer_call request untouched (same init reference)", async () => {
    let seenInit: unknown;
    const base = (async (_url: unknown, init?: unknown) => {
      seenInit = init;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const wrapped = computerCallNormalizingFetch(base);
    const init = { method: "POST", body: JSON.stringify({ input: [{ type: "message" }] }) };
    await wrapped("https://aoai/openai/v1/responses", init);
    // No computer_call → original init forwarded by reference (untouched).
    expect(seenInit).toBe(init);
  });

  test("forwards non-string / streaming bodies untouched", async () => {
    let seenInit: unknown;
    const base = (async (_url: unknown, init?: unknown) => {
      seenInit = init;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const wrapped = computerCallNormalizingFetch(base);
    const init = { method: "GET" };
    await wrapped("https://aoai/openai/v1/responses", init);
    expect(seenInit).toBe(init);
  });
});

describe("rewriteEmptyComputerCallOutputImageUrls", () => {
  // ROOT CAUSE: when an action (click/type/scroll/drag) times out at the 15 s
  // yield window, SandboxComputer.x() throws ComputerActionError; agents-core
  // toolExecution.mjs catch sets output='' and builds the wire item:
  //   {type:"computer_call_output",output:{type:"computer_screenshot",image_url:""}}
  // Azure rejects the whole request: "400 Invalid input[N].output.image_url".
  // This rewriter is the wire-level backstop that replaces empty/missing
  // image_urls with the 1×1 transparent PNG placeholder before Azure sees them.

  test("replaces an empty image_url on a computer_call_output with the placeholder", () => {
    // The exact wire shape the SDK produces on action-timeout: image_url is "".
    const body = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "click the button" }] },
        {
          type: "computer_call_output",
          call_id: "cu_1",
          output: { type: "computer_screenshot", image_url: "" },
        },
      ],
    };
    const changed = rewriteEmptyComputerCallOutputImageUrls(body);
    expect(changed).toBe(true);
    const out = (body.input[1] as Record<string, unknown>).output as Record<string, unknown>;
    expect(out.image_url).toBe(PLACEHOLDER);
    // Sibling fields and non-computer items are untouched.
    expect(out.type).toBe("computer_screenshot");
    expect((body.input[1] as Record<string, unknown>).call_id).toBe("cu_1");
    expect(body.input[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "click the button" }],
    });
  });

  test("replaces a missing image_url (undefined) with the placeholder", () => {
    const body = {
      input: [
        {
          type: "computer_call_output",
          call_id: "cu_2",
          output: { type: "computer_screenshot" },
        },
      ],
    };
    const changed = rewriteEmptyComputerCallOutputImageUrls(body);
    expect(changed).toBe(true);
    const out = (body.input[0] as Record<string, unknown>).output as Record<string, unknown>;
    expect(out.image_url).toBe(PLACEHOLDER);
  });

  test("replaces a null image_url with the placeholder", () => {
    const body = {
      input: [
        {
          type: "computer_call_output",
          call_id: "cu_3",
          output: { type: "computer_screenshot", image_url: null },
        },
      ],
    };
    const changed = rewriteEmptyComputerCallOutputImageUrls(body);
    expect(changed).toBe(true);
    const out = (body.input[0] as Record<string, unknown>).output as Record<string, unknown>;
    expect(out.image_url).toBe(PLACEHOLDER);
  });

  test("leaves a valid non-empty data-URI image_url untouched (no change)", () => {
    // A real screenshot — must never be overwritten by the backstop.
    const realDataUri = "data:image/png;base64,abc123def456";
    const body = {
      input: [
        {
          type: "computer_call_output",
          call_id: "cu_4",
          output: { type: "computer_screenshot", image_url: realDataUri },
        },
      ],
    };
    const changed = rewriteEmptyComputerCallOutputImageUrls(body);
    expect(changed).toBe(false);
    const out = (body.input[0] as Record<string, unknown>).output as Record<string, unknown>;
    expect(out.image_url).toBe(realDataUri);
  });

  test("leaves the placeholder itself untouched when already present (idempotent)", () => {
    // If the item was already patched (e.g. replayed history from a prior turn)
    // it must not be double-replaced.
    const body = {
      input: [
        {
          type: "computer_call_output",
          call_id: "cu_5",
          output: { type: "computer_screenshot", image_url: PLACEHOLDER },
        },
      ],
    };
    const changed = rewriteEmptyComputerCallOutputImageUrls(body);
    expect(changed).toBe(false);
    const out = (body.input[0] as Record<string, unknown>).output as Record<string, unknown>;
    expect(out.image_url).toBe(PLACEHOLDER);
  });

  test("handles multiple items: patches empty, leaves valid, skips non-computer items", () => {
    const realDataUri = "data:image/png;base64,validdata";
    const body = {
      input: [
        { type: "message", role: "user", content: "go" },
        { type: "computer_call_output", call_id: "cu_a", output: { type: "computer_screenshot", image_url: "" } },
        { type: "function_call_result", call_id: "fn_1", output: { type: "text", text: "ok" } },
        { type: "computer_call_output", call_id: "cu_b", output: { type: "computer_screenshot", image_url: realDataUri } },
        { type: "computer_call_output", call_id: "cu_c", output: { type: "computer_screenshot", image_url: null } },
      ],
    };
    const changed = rewriteEmptyComputerCallOutputImageUrls(body);
    expect(changed).toBe(true);
    // cu_a (empty "")  → replaced
    const outA = (body.input[1] as Record<string, unknown>).output as Record<string, unknown>;
    expect(outA.image_url).toBe(PLACEHOLDER);
    // function_call_result → untouched
    expect((body.input[2] as Record<string, unknown>).call_id).toBe("fn_1");
    // cu_b (valid) → untouched
    const outB = (body.input[3] as Record<string, unknown>).output as Record<string, unknown>;
    expect(outB.image_url).toBe(realDataUri);
    // cu_c (null) → replaced
    const outC = (body.input[4] as Record<string, unknown>).output as Record<string, unknown>;
    expect(outC.image_url).toBe(PLACEHOLDER);
  });

  test("returns false and is a no-op for non-array input, null, and non-object bodies", () => {
    expect(rewriteEmptyComputerCallOutputImageUrls({ input: [{ type: "message" }] })).toBe(false);
    expect(rewriteEmptyComputerCallOutputImageUrls({ input: "nope" })).toBe(false);
    expect(rewriteEmptyComputerCallOutputImageUrls(null)).toBe(false);
    expect(rewriteEmptyComputerCallOutputImageUrls("string")).toBe(false);
  });
});

describe("computerCallNormalizingFetch — empty image_url backstop (action-timeout 400)", () => {
  test("patches an empty image_url on a computer_call_output before sending to provider", async () => {
    // The exact scenario: action timed out → SDK set image_url:"" → Azure would 400.
    // The wrapping fetch must replace it with the placeholder so Azure accepts it.
    let seenBody: string | undefined;
    const base = (async (_url: unknown, init?: { body?: unknown }) => {
      seenBody = init?.body as string;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const wrapped = computerCallNormalizingFetch(base);
    const originalBody = JSON.stringify({
      input: [
        {
          type: "computer_call_output",
          call_id: "cu_timeout",
          output: { type: "computer_screenshot", image_url: "" },
        },
      ],
    });
    await wrapped("https://aoai/openai/v1/responses", { method: "POST", body: originalBody });

    expect(seenBody).toBeDefined();
    const sent = JSON.parse(seenBody as string);
    const out = sent.input[0].output;
    expect(out.image_url).toBe(PLACEHOLDER);
    // The type field is preserved.
    expect(out.type).toBe("computer_screenshot");
  });

  test("applies both rewrites in one pass: actions-only + empty image_url fix", async () => {
    // A body that has both problems: a computer_call with both fields AND a
    // computer_call_output with an empty image_url. Both are fixed in one parse.
    let seenBody: string | undefined;
    const base = (async (_url: unknown, init?: { body?: unknown }) => {
      seenBody = init?.body as string;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const wrapped = computerCallNormalizingFetch(base);
    const originalBody = JSON.stringify({
      input: [
        {
          type: "computer_call",
          call_id: "cu_act",
          action: { type: "click", x: 10, y: 20 },
          actions: [{ type: "click", x: 10, y: 20 }],
        },
        {
          type: "computer_call_output",
          call_id: "cu_act",
          output: { type: "computer_screenshot", image_url: "" },
        },
      ],
    });
    await wrapped("https://aoai/openai/v1/responses", { method: "POST", body: originalBody });

    expect(seenBody).toBeDefined();
    const sent = JSON.parse(seenBody as string);
    // computer_call → actions-only
    const cc = sent.input[0];
    expect("action" in cc).toBe(false);
    expect(cc.actions).toEqual([{ type: "click", x: 10, y: 20 }]);
    // computer_call_output → placeholder
    const out = sent.input[1].output;
    expect(out.image_url).toBe(PLACEHOLDER);
  });
});

describe("stripReasoningEncryptedContent", () => {
  test("drops providerData.encrypted_content (snake) but preserves reasoning text", () => {
    const item = {
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "I considered the options" }],
      content: [{ type: "input_text", text: "visible chain of thought" }],
      providerData: { encrypted_content: "gAAAA-account-A-blob", other: "keep" },
    } as any;
    const out = stripReasoningEncryptedContent(item) as any;
    // The opaque blob is gone…
    expect("encrypted_content" in out.providerData).toBe(false);
    // …but the visible reasoning text and every other field survive.
    expect(out.providerData.other).toBe("keep");
    expect(out.summary).toEqual(item.summary);
    expect(out.content).toEqual(item.content);
    expect(out.id).toBe("rs_1");
    // Non-mutating: the input keeps its blob.
    expect(item.providerData.encrypted_content).toBe("gAAAA-account-A-blob");
  });

  test("drops providerData.encryptedContent (camel) too", () => {
    const item = {
      type: "reasoning",
      providerData: { encryptedContent: "blob", encrypted_content: "blob2" },
    } as any;
    const out = stripReasoningEncryptedContent(item) as any;
    expect("encryptedContent" in out.providerData).toBe(false);
    expect("encrypted_content" in out.providerData).toBe(false);
  });

  test("clears a top-level encrypted_content (compaction item shape)", () => {
    const item = { type: "compaction", encrypted_content: "blob", summary: "kept" } as any;
    const out = stripReasoningEncryptedContent(item) as any;
    expect("encrypted_content" in out).toBe(false);
    expect(out.summary).toBe("kept");
  });

  test("returns the SAME reference when there is nothing encrypted to strip", () => {
    const reasoningNoBlob = { type: "reasoning", content: [{ type: "input_text", text: "t" }] } as any;
    expect(stripReasoningEncryptedContent(reasoningNoBlob)).toBe(reasoningNoBlob);
  });

  test("leaves non-reasoning items untouched (by reference)", () => {
    const message = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "hello" }],
      // A message would never carry this, but prove we never touch it.
      providerData: { encrypted_content: "should-not-be-removed" },
    } as any;
    const out = stripReasoningEncryptedContent(message);
    expect(out).toBe(message);
    expect((out as any).providerData.encrypted_content).toBe("should-not-be-removed");
  });
});
