import { expect, test } from "bun:test";
import { Agent, Runner, tool } from "@openai/agents";
import { ScriptedModel, assistantMessage, functionCall } from "@opengeni/testing";
import {
  ModelRequestCaptureModel,
  withModelCallLifecycle,
} from "../../../packages/runtime/src/model-request-capture";
import { installLazyToolRuntime } from "../../../packages/runtime/src/lazy-tool-transport";
import type { LazyToolTransport } from "../../../packages/runtime/src/lazy-tool-transport";
import { createModelCallAdmission } from "../src/activities/agent-turn/model-call-admission";
import { BudgetExhaustedError } from "../src/activities/agent-turn/admission";
import { instrumentedModelFetch } from "../../../packages/runtime/src/model-provider-client";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture(admit: () => Promise<void>, lazy: LazyToolTransport | null = null) {
  const controller = new AbortController();
  const barrier = createModelCallAdmission({ signal: controller.signal, admit });
  const model = new ScriptedModel([
    { output: [functionCall("local", {}, "first-call")] },
    { output: [assistantMessage("must not dispatch")] },
  ]);
  let tools = 0;
  const agent = new Agent({
    name: "producer-admission-race",
    model: lazy ? model : new ModelRequestCaptureModel(model),
    tools: [
      tool({
        name: "local",
        description: "Offline fixture",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        strict: false,
        execute: async () => {
          tools++;
          return "local result";
        },
      }),
    ],
  });
  if (lazy) {
    installLazyToolRuntime(agent, lazy, new Set());
  }
  const stream = await withModelCallLifecycle(barrier, () =>
    new Runner({ tracingDisabled: true }).run(agent, "test", { stream: true }),
  );
  void stream.completed.catch(() => undefined);
  const iterator = stream.toStream()[Symbol.asyncIterator]();
  let terminal;
  while (true) {
    const next = await iterator.next();
    if (next.done) throw new Error("No first terminal response");
    if (next.value.type === "raw_model_stream_event" && next.value.data.type === "response_done") {
      terminal = next.value;
      break;
    }
  }
  return { controller, barrier, model, stream, iterator, terminal, tools: () => tools };
}

test.each([null, "openai_native", "codex_native", "generic_dispatch"] as const)(
  "real SDK producer waits for unfinished response settlement (lazy=%s)",
  async (lazy) => {
    let admissions = 0;
    const ctx = await fixture(async () => {
      admissions++;
    }, lazy);
    try {
      expect(ctx.model.calls).toBe(1);
      expect(admissions).toBe(1);
      await Bun.sleep(10);
      expect(ctx.tools()).toBe(1);
      expect(admissions).toBe(1);
      expect(ctx.model.calls).toBe(1);
      ctx.controller.abort(new Error("fixture cancelled during settlement"));
      await expect(ctx.stream.completed).rejects.toThrow("fixture cancelled during settlement");
      expect(ctx.model.calls).toBe(1);
    } finally {
      ctx.barrier.close();
      void ctx.iterator.return?.().catch(() => undefined);
    }
  },
);

test.each([null, "openai_native", "codex_native", "generic_dispatch"] as const)(
  "settled response cannot bypass delayed producer admission (lazy=%s)",
  async (lazy) => {
    const admissionStarted = deferred();
    const releaseAdmission = deferred();
    const exhausted = new BudgetExhaustedError("member allowance exhausted", null, {
      code: "allowance_exhausted",
      scope: "member",
      subjectId: "user:frozen",
      resetsAt: null,
      message: "member allowance exhausted",
    });
    let admissions = 0;
    const ctx = await fixture(async () => {
      if (++admissions === 1) return;
      admissionStarted.resolve();
      await releaseAdmission.promise;
      throw exhausted;
    }, lazy);
    try {
      // Settlement is already finished, but that is not permission for a new call.
      ctx.barrier.settle(ctx.terminal);
      await admissionStarted.promise;
      expect(ctx.tools()).toBe(1);
      expect(ctx.model.calls).toBe(1);
      releaseAdmission.resolve();
      await expect(ctx.stream.completed).rejects.toBe(exhausted);
      expect(ctx.model.calls).toBe(1);
    } finally {
      ctx.barrier.close();
      void ctx.iterator.return?.().catch(() => undefined);
    }
  },
);

test("consumer settlement failure releases the producer with the original error, not a retry", async () => {
  const ctx = await fixture(async () => {});
  const error = new Error("debit settlement failed");
  try {
    ctx.barrier.fail(error);
    await expect(ctx.stream.completed).rejects.toBe(error);
    expect(ctx.model.calls).toBe(1);
  } finally {
    ctx.barrier.close();
    void ctx.iterator.return?.().catch(() => undefined);
  }
});

test.each([null, "openai_native", "codex_native", "generic_dispatch"] as const)(
  "settled and admitted responses permit ordinary SDK progress (lazy=%s)",
  async (lazy) => {
    const ctx = await fixture(async () => {}, lazy);
    try {
      ctx.barrier.settle(ctx.terminal);
      while (true) {
        const next = await ctx.iterator.next();
        if (next.done) break;
        ctx.barrier.settle(next.value);
      }
      await ctx.stream.completed;
      expect(ctx.model.calls).toBe(2);
      expect(ctx.tools()).toBe(1);
      expect(ctx.stream.finalOutput).toBe("must not dispatch");
    } finally {
      ctx.barrier.close();
      void ctx.iterator.return?.().catch(() => undefined);
    }
  },
);

test("literal provider fetch revalidates admission after settled response and request preparation", async () => {
  const started = deferred();
  const released = deferred();
  const controller = new AbortController();
  const exhausted = new BudgetExhaustedError("workspace allowance exhausted", null);
  const barrier = createModelCallAdmission({
    signal: controller.signal,
    admit: async () => {
      started.resolve();
      await released.promise;
      throw exhausted;
    },
  });
  let fetches = 0;
  const fetch = instrumentedModelFetch("offline", (async () => {
    fetches++;
    return new Response("{}");
  }) as typeof globalThis.fetch);
  try {
    const event = { type: "response_done" } as Parameters<typeof barrier.onModelResponse>[0];
    barrier.onModelResponse(event);
    barrier.settle({ type: "raw_model_stream_event", data: event });
    const pending = withModelCallLifecycle(barrier, () =>
      fetch("https://offline.invalid/v1/responses", { method: "POST", body: "{}" }),
    );
    await started.promise;
    expect(fetches).toBe(0);
    released.resolve();
    await expect(pending).rejects.toBe(exhausted);
    expect(fetches).toBe(0);
  } finally {
    barrier.close();
  }
});

test("cancellation releases producer admission even while its read remains pending", async () => {
  const started = deferred();
  const controller = new AbortController();
  const barrier = createModelCallAdmission({
    signal: controller.signal,
    admit: async () => {
      started.resolve();
      await new Promise(() => {});
    },
  });
  const pending = barrier.beforeModelRequest();
  await started.promise;
  const reason = new Error("cancel during admission");
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  barrier.close();
});

test.each(["response-id", null])(
  "SDK retry-normalized terminal copies settle the receipt (%s)",
  async (id) => {
    const barrier = createModelCallAdmission({
      signal: new AbortController().signal,
      admit: async () => {},
    });
    const event = {
      type: "response_done",
      response: { ...(id ? { id } : {}), usage: {}, output: [] },
    } as Parameters<typeof barrier.onModelResponse>[0];
    const pending = barrier.onModelResponse(event);
    expect(barrier.onModelResponse(structuredClone(event))).toBe(pending);
    barrier.settle({ type: "raw_model_stream_event", data: structuredClone(event) });
    await pending;
    await barrier.beforeModelRequest();
    barrier.close();
  },
);
