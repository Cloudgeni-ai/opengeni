import { describe, expect, test } from "bun:test";
import {
  computerCallNormalizingFetch,
  elideSupersededViewImagePairs,
  normalizeComputerCallActions,
  rewriteComputerCallsToActionsOnly,
  rewriteEmptyComputerCallOutputImageUrls,
  sanitizeHistoryItemsForModel,
  stripReasoningEncryptedContent,
  stripReasoningIdentityFromSerializedRunState,
} from "../src/history-sanitizer";

// The legible "screen capture failed" error card the wire-level backstop now
// substitutes for an EMPTY computer_call_output image_url (replacing the old 1×1
// transparent blank the model misread as a real empty desktop).
import { SCREENSHOT_FAILURE_CARD_IMAGE_URL as FAILURE_CARD } from "../src/screenshot-error-card";

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
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  };
}
function functionCall(callId: string, name = "tool") {
  return { type: "function_call", callId, name, arguments: "{}", status: "completed" };
}
function functionResult(callId: string) {
  return {
    type: "function_call_result",
    callId,
    status: "completed",
    output: { type: "text", text: "ok" },
  };
}

function viewImageCall(callId: string, path: string) {
  return {
    type: "function_call",
    callId,
    name: "view_image",
    arguments: JSON.stringify({ path }),
    status: "completed",
  };
}
// tool_search items (progressive connector disclosure). The SDK holds the wire
// shape: snake_case call_id, arguments round-tripped as-is (an object).
function toolSearchCall(callId: string) {
  return {
    type: "tool_search_call",
    call_id: callId,
    status: "completed",
    execution: "client",
    arguments: { query: "send an email" },
  };
}
function toolSearchOutput(callId: string) {
  return {
    type: "tool_search_output",
    call_id: callId,
    status: "completed",
    execution: "client",
    tools: [{ type: "function", name: "codex_apps__gmail_send_email" }],
  };
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
    const items = [userMessage("hi"), reasoning("rs_1"), functionCall("call_dangling")];
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
    expect(result).toEqual([items[0], items[1], items[2], items[3], items[4], items[6]]);
  });

  test("accepts snake_case call_id correlation as well as camelCase callId", () => {
    const call = { type: "function_call", call_id: "call_snake", name: "t", arguments: "{}" };
    const orphan = {
      type: "function_call_result",
      call_id: "call_missing",
      output: { type: "text", text: "x" },
    };
    const result = {
      type: "function_call_result",
      call_id: "call_snake",
      output: { type: "text", text: "ok" },
    };
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

describe("elideSupersededViewImagePairs", () => {
  test("keeps only the newest fully-paired image observation for the same path", () => {
    const items = [
      userMessage("inspect both"),
      reasoning("rs-old"),
      viewImageCall("img-old", "/tmp/a.png"),
      functionResult("img-old"),
      viewImageCall("img-b", "/tmp/b.png"),
      functionResult("img-b"),
      reasoning("rs-new"),
      viewImageCall("img-new", "/tmp/a.png"),
      functionResult("img-new"),
    ];

    const out = elideSupersededViewImagePairs(items);
    expect(out).toEqual([items[0], items[4], items[5], items[6], items[7], items[8]]);
  });

  test("does not discard the last valid image when a newer call is incomplete", () => {
    const items = [
      viewImageCall("img-valid", "/tmp/a.png"),
      functionResult("img-valid"),
      viewImageCall("img-inflight", "/tmp/a.png"),
    ];

    expect(elideSupersededViewImagePairs(items)).toEqual(items);
  });

  test("leaves distinct image paths and non-image tools byte-identical", () => {
    const items = [
      viewImageCall("img-a", "/tmp/a.png"),
      functionResult("img-a"),
      viewImageCall("img-b", "/tmp/b.png"),
      functionResult("img-b"),
      functionCall("other", "memory_search"),
      functionResult("other"),
    ];

    const out = elideSupersededViewImagePairs(items);
    expect(out).toEqual(items);
    expect(out[0]).toBe(items[0]);
  });
});

describe("normalizeComputerCallActions", () => {
  test("normalizes a computer_call carrying BOTH action and actions to exactly one (keeps actions)", () => {
    // The live Azure 400: a freshly-emitted screenshot computer_call carries
    // both the legacy singular `action` and the GA batched `actions`. The GA
    // computer tool (how gpt-5.6-sol serializes it) accepts ONLY the plural
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
    const actionOnly = {
      type: "computer_call",
      callId: "cu_a",
      status: "completed",
      action: { type: "screenshot" },
    };
    const actionsOnly = {
      type: "computer_call",
      callId: "cu_b",
      status: "completed",
      actions: [{ type: "click", x: 1, y: 2 }],
    };
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
      model: "gpt-5.6-sol",
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
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "click the button" }],
        },
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
    expect(out.image_url).toBe(FAILURE_CARD);
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
    expect(out.image_url).toBe(FAILURE_CARD);
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
    expect(out.image_url).toBe(FAILURE_CARD);
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
          output: { type: "computer_screenshot", image_url: FAILURE_CARD },
        },
      ],
    };
    const changed = rewriteEmptyComputerCallOutputImageUrls(body);
    expect(changed).toBe(false);
    const out = (body.input[0] as Record<string, unknown>).output as Record<string, unknown>;
    expect(out.image_url).toBe(FAILURE_CARD);
  });

  test("handles multiple items: patches empty, leaves valid, skips non-computer items", () => {
    const realDataUri = "data:image/png;base64,validdata";
    const body = {
      input: [
        { type: "message", role: "user", content: "go" },
        {
          type: "computer_call_output",
          call_id: "cu_a",
          output: { type: "computer_screenshot", image_url: "" },
        },
        { type: "function_call_result", call_id: "fn_1", output: { type: "text", text: "ok" } },
        {
          type: "computer_call_output",
          call_id: "cu_b",
          output: { type: "computer_screenshot", image_url: realDataUri },
        },
        {
          type: "computer_call_output",
          call_id: "cu_c",
          output: { type: "computer_screenshot", image_url: null },
        },
      ],
    };
    const changed = rewriteEmptyComputerCallOutputImageUrls(body);
    expect(changed).toBe(true);
    // cu_a (empty "")  → replaced
    const outA = (body.input[1] as Record<string, unknown>).output as Record<string, unknown>;
    expect(outA.image_url).toBe(FAILURE_CARD);
    // function_call_result → untouched
    expect((body.input[2] as Record<string, unknown>).call_id).toBe("fn_1");
    // cu_b (valid) → untouched
    const outB = (body.input[3] as Record<string, unknown>).output as Record<string, unknown>;
    expect(outB.image_url).toBe(realDataUri);
    // cu_c (null) → replaced
    const outC = (body.input[4] as Record<string, unknown>).output as Record<string, unknown>;
    expect(outC.image_url).toBe(FAILURE_CARD);
  });

  test("returns false and is a no-op for non-array input, null, and non-object bodies", () => {
    expect(rewriteEmptyComputerCallOutputImageUrls({ input: [{ type: "message" }] })).toBe(false);
    expect(rewriteEmptyComputerCallOutputImageUrls({ input: "nope" })).toBe(false);
    expect(rewriteEmptyComputerCallOutputImageUrls(null)).toBe(false);
    expect(rewriteEmptyComputerCallOutputImageUrls("string")).toBe(false);
  });

  test("BLANK-MASQUERADE FIX: the substitute is a LEGIBLE PNG card, NOT the old 1×1 transparent blank", () => {
    // Regression guard for the 0.1.3 incident: a hard capture failure must reach the
    // model as a legible error image, never a tiny transparent blank it reads as a
    // real empty desktop.
    const OLD_BLANK_1x1 =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
    const body = {
      input: [
        {
          type: "computer_call_output",
          call_id: "cu_x",
          output: { type: "computer_screenshot", image_url: "" },
        },
      ],
    };
    rewriteEmptyComputerCallOutputImageUrls(body);
    const out = (body.input[0] as Record<string, unknown>).output as Record<string, unknown>;
    const url = out.image_url as string;
    // A real PNG data URI...
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    // ...that is NOT the old blank, and is substantial enough to carry rendered text.
    expect(url).not.toBe(OLD_BLANK_1x1);
    expect(url.length).toBeGreaterThan(2000);
    // The decoded bytes are a valid PNG (signature) — a malformed image would 400.
    const png = Buffer.from(url.slice("data:image/png;base64,".length), "base64");
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
    expect(out.image_url).toBe(FAILURE_CARD);
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
    expect(out.image_url).toBe(FAILURE_CARD);
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
    const reasoningNoBlob = {
      type: "reasoning",
      content: [{ type: "input_text", text: "t" }],
    } as any;
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

describe("stripReasoningIdentityFromSerializedRunState", () => {
  // The approval RunState replay path
  // replay a serialized RunState blob that has no per-item producer tag. When the
  // resuming codex account differs from the freezing one, this neutralizes EVERY
  // reasoning item's account-bound identity (encrypted_content + provider id)
  // wherever it lives in the blob, while preserving message / tool / compaction
  // content. Both HOLE A vectors (foreign blob 400, foreign rs_ id rejection) are
  // closed because neither the blob nor the id survives.

  const fullBlob = () =>
    JSON.stringify({
      $schemaVersion: "1.12",
      originalInput: [
        {
          type: "reasoning",
          id: "rs_orig",
          content: [{ type: "input_text", text: "t" }],
          providerData: { encrypted_content: "enc-orig", keep: "yes" },
        },
        { type: "message", role: "user", content: "the question" },
      ],
      modelResponses: [
        {
          output: [
            {
              type: "reasoning",
              id: "rs_resp",
              content: [],
              providerData: { encryptedContent: "enc-resp-camel" },
            },
            { type: "function_call", callId: "call_1", name: "t", arguments: "{}" },
          ],
        },
      ],
      lastModelResponse: {
        output: [
          {
            type: "reasoning",
            id: "rs_last",
            content: [],
            providerData: { encrypted_content: "enc-last" },
          },
        ],
      },
      generatedItems: [
        {
          type: "reasoning_item",
          rawItem: {
            type: "reasoning",
            id: "rs_gen",
            content: [],
            providerData: { encrypted_content: "enc-gen" },
          },
        },
        {
          type: "message_output_item",
          rawItem: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "the answer" }],
          },
        },
      ],
    });

  test("strips encrypted_content (snake+camel) and the rs_ id from reasoning in every location", () => {
    const out = stripReasoningIdentityFromSerializedRunState(fullBlob());
    const parsed = JSON.parse(out);
    // No encrypted blob survives anywhere…
    for (const enc of ["enc-orig", "enc-resp-camel", "enc-last", "enc-gen"]) {
      expect(out).not.toContain(enc);
    }
    // …no foreign rs_ id survives anywhere…
    for (const id of ["rs_orig", "rs_resp", "rs_last", "rs_gen"]) {
      expect(out).not.toContain(id);
    }
    // …a non-blob providerData sibling on a reasoning item is preserved…
    expect(parsed.originalInput[0].providerData.keep).toBe("yes");
    // …and all message / tool content survives.
    expect(out).toContain("the question");
    expect(out).toContain("the answer");
    expect(out).toContain("call_1");
  });

  test("returns the SAME string reference when there is no reasoning to strip (no-op)", () => {
    const blob = JSON.stringify({
      $schemaVersion: "1.12",
      originalInput: [{ type: "message", role: "user", content: "hi" }],
      modelResponses: [],
      generatedItems: [
        {
          type: "message_output_item",
          rawItem: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }],
          },
        },
      ],
    });
    expect(stripReasoningIdentityFromSerializedRunState(blob)).toBe(blob);
  });

  test("leaves compaction items untouched (their encrypted_content is a required field)", () => {
    const blob = JSON.stringify({
      $schemaVersion: "1.12",
      originalInput: [{ type: "compaction", encrypted_content: "comp-blob", summary: "kept" }],
      modelResponses: [],
      generatedItems: [],
    });
    // No reasoning anywhere → byte-identical (same reference); compaction intact.
    expect(stripReasoningIdentityFromSerializedRunState(blob)).toBe(blob);
  });

  test("forwards a non-JSON string unchanged (same reference)", () => {
    const sentinel = "not-json-cleared-state-sentinel";
    expect(stripReasoningIdentityFromSerializedRunState(sentinel)).toBe(sentinel);
  });
});

describe("sanitizeHistoryItemsForModel: tool_search pairing (progressive connector disclosure)", () => {
  test("keeps a well-formed tool_search_call -> tool_search_output pair byte-identical", () => {
    const items = [
      userMessage("check mail"),
      toolSearchCall("ts1"),
      toolSearchOutput("ts1"),
      assistantMessage("ok"),
    ];
    const out = sanitizeHistoryItemsForModel(items);
    expect(out).toEqual(items);
    expect(out[1]).toBe(items[1]); // same references
  });

  test("drops an orphaned tool_search_output whose call is absent (live 400: 'No tool call found for tool search output')", () => {
    const items = [userMessage("check mail"), toolSearchOutput("ts1"), assistantMessage("ok")];
    const out = sanitizeHistoryItemsForModel(items);
    expect(out.map((i) => i.type)).toEqual(["message", "message"]);
  });

  test("drops a dangling tool_search_call with no output (live 400: 'No tool output found for tool search call')", () => {
    const items = [userMessage("check mail"), toolSearchCall("ts1"), assistantMessage("ok")];
    const out = sanitizeHistoryItemsForModel(items);
    expect(out.map((i) => i.type)).toEqual(["message", "message"]);
  });

  test("drops a reasoning item stranded by a dropped dangling tool_search_call", () => {
    const items = [
      userMessage("q"),
      reasoning("rs1"),
      toolSearchCall("ts1"),
      assistantMessage("a"),
    ];
    const out = sanitizeHistoryItemsForModel(items);
    expect(out.map((i) => i.type)).toEqual(["message", "message"]);
  });

  test("correlates a tool_search pair whose call id rides ONLY providerData (SDK getToolSearchProviderCallId shape)", () => {
    const call = {
      type: "tool_search_call",
      status: "completed",
      execution: "client",
      arguments: { query: "x" },
      providerData: { call_id: "tsP" },
    };
    const output = {
      type: "tool_search_output",
      status: "completed",
      execution: "client",
      tools: [],
      providerData: { call_id: "tsP" },
    };
    const items = [userMessage("q"), call, output];
    expect(sanitizeHistoryItemsForModel(items)).toEqual(items);
  });

  test("tool_search pairing never disturbs function_call pairing in the same history", () => {
    const items = [
      userMessage("q"),
      toolSearchCall("ts1"),
      toolSearchOutput("ts1"),
      functionCall("fc1", "codex_apps__gmail_send_email"),
      functionResult("fc1"),
      toolSearchOutput("ts-orphan"), // orphan output — only this drops
      assistantMessage("done"),
    ];
    const out = sanitizeHistoryItemsForModel(items);
    expect(out.map((i) => (i as { type: string }).type)).toEqual([
      "message",
      "tool_search_call",
      "tool_search_output",
      "function_call",
      "function_call_result",
      "message",
    ]);
  });
});
