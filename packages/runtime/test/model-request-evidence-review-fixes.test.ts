import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CODEX_PHYSICAL_REQUEST, type CodexPhysicalRequestInit } from "@opengeni/codex";
import { assessModelRequestEvidence, type ModelRequestEvidence } from "@opengeni/contracts";
import {
  beginModelRequestEvidence,
  captureModelUsageEvidence,
  publicResponsesEvidence,
  registerModelEvidenceSecrets,
  withModelEvidencePurpose,
  withModelRequestEvidence,
} from "../src/model-request-evidence";
import { instrumentedModelFetch } from "../src/model-provider-client";

type Purpose = "main" | "session-title" | "compaction";
const completed = (id: string, text = "public result") => ({
  type: "response.completed",
  response: {
    id,
    status: "completed",
    output: [{ type: "message", id: "message", content: [{ type: "output_text", text }] }],
  },
});
const encode = (events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const delta = (text: string, item = "message", output = 0) => ({
  type: "response.output_text.delta",
  item_id: item,
  output_index: output,
  content_index: 0,
  delta: text,
});
const request = (id: string): CodexPhysicalRequestInit => ({
  method: "POST",
  body: "{}",
  [CODEX_PHYSICAL_REQUEST]: { requestId: id, transportAttempt: 1 },
});
async function committedUsage(id: string, purpose: Purpose = "main") {
  await captureModelUsageEvidence({
    sourceKey: id,
    purpose,
    eventId: `usage-${id}`,
    sequence: 10,
    payload: {
      sourceKey: id,
      purpose,
      inputTokens: 100,
      outputTokens: 30,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    },
  });
}
async function receive(
  id: string,
  events: unknown[],
  purpose: Purpose = "main",
  byteChunks = false,
) {
  const text = encode(events);
  const fetcher = instrumentedModelFetch("codex-subscription", (async () => {
    const bytes = new TextEncoder().encode(text);
    const body = byteChunks
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
            controller.close();
          },
        })
      : text;
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch);
  expect(await (await fetcher("https://fixture.invalid/v1/responses", request(id))).text()).toBe(
    text,
  );
  await committedUsage(id, purpose);
}
async function captured(id: string, events: unknown[], secret?: string, byteChunks = false) {
  const records: ModelRequestEvidence[] = [];
  await withModelRequestEvidence(
    async (record) => {
      records.push(record);
    },
    async () => {
      if (secret) registerModelEvidenceSecrets([secret]);
      await receive(id, events, "main", byteChunks);
    },
  );
  return records;
}
const responseEvents = (records: ModelRequestEvidence[], id: string) =>
  (
    records.find((record) => record.kind === "response" && record.responseId === id)!.content as {
      events: Record<string, any>[];
    }
  ).events;

describe("reviewed per-request evidence counterexamples", () => {
  test("every split of an exact registered credential is redacted before delta persistence", async () => {
    // Generate synthetic values here, never copy operator/reviewer credentials into fixtures.
    const secret = randomUUID();
    for (let cut = 1; cut < secret.length; cut++) {
      const records = await captured(
        "split",
        [
          delta("before:" + secret.slice(0, cut)),
          delta(secret.slice(cut) + ":after"),
          completed("split", "before:" + secret + ":after"),
        ],
        secret,
      );
      const events = responseEvents(records, "split");
      expect(
        events
          .filter((e) => e.type.endsWith(".delta"))
          .map((e) => e.delta)
          .join(""),
      ).toBe("before:[REDACTED:injected-credential]:after");
      expect(JSON.stringify(records)).not.toContain(secret);
      expect(records.find((r) => r.kind === "response")!.redacted).toBe(true);
      expect(assessModelRequestEvidence(records).complete).toBe(true);
    }
  });

  test("multibyte source byte boundaries and UTF-16 delta splits preserve unrelated source", async () => {
    const secret = randomUUID() + "é😀";
    const pieces = secret.split(""); // Also splits the surrogate pair across JSON delta strings.
    const records = await captured(
      "unicode",
      [delta("任务:"), ...pieces.map((p) => delta(p)), delta(":✓"), completed("unicode", secret)],
      secret,
      true,
    );
    const joined = responseEvents(records, "unicode")
      .filter((e) => e.type.endsWith(".delta"))
      .map((e) => e.delta)
      .join("");
    expect(joined).toBe("任务:[REDACTED:injected-credential]:✓");
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(assessModelRequestEvidence(records).complete).toBe(true);
  });

  test("concurrent main/title/compaction and a child never concatenate unrelated physical streams", async () => {
    const records: ModelRequestEvidence[] = [],
      child: ModelRequestEvidence[] = [];
    const secret = randomUUID();
    await withModelRequestEvidence(
      async (record) => {
        records.push(record);
      },
      async () => {
        registerModelEvidenceSecrets([secret]);
        await Promise.all(
          (["main", "session-title", "compaction"] as const).map((purpose) =>
            withModelEvidencePurpose(purpose, () =>
              receive(
                purpose,
                [delta(secret.slice(0, 7)), delta(secret.slice(7)), completed(purpose, secret)],
                purpose,
              ),
            ),
          ),
        );
        await withModelRequestEvidence(
          async (record) => {
            child.push(record);
          },
          async () => {
            registerModelEvidenceSecrets([secret]);
            await receive("child", [
              delta(secret.slice(0, 5)),
              delta(secret.slice(5)),
              completed("child", secret),
            ]);
          },
        );
        // Neither separate response contains the whole credential. Do not mask task text
        // merely because two unrelated responses can be concatenated into that value.
        await Promise.all([
          receive("left", [delta(secret.slice(0, 9)), completed("left")]),
          receive("right", [delta(secret.slice(9)), completed("right")]),
        ]);
      },
    );
    for (const purpose of ["main", "session-title", "compaction"]) {
      expect(
        responseEvents(records, purpose)
          .filter((e) => e.type.endsWith(".delta"))
          .map((e) => e.delta)
          .join(""),
      ).toBe("[REDACTED:injected-credential]");
    }
    expect(responseEvents(records, "left")[0]!.delta).toBe(secret.slice(0, 9));
    expect(responseEvents(records, "right")[0]!.delta).toBe(secret.slice(9));
    expect(JSON.stringify(child)).not.toContain(secret);
    expect(assessModelRequestEvidence(records).complete).toBe(true);
    expect(assessModelRequestEvidence(child).complete).toBe(true);
  });

  test("separate output items are not joined; late item IDs associate actual fragments", async () => {
    const secret = randomUUID();
    const a = { ...delta(secret.slice(0, 10)), item_id: undefined };
    const records = await captured(
      "items",
      [
        a,
        delta(secret.slice(10)),
        delta(secret.slice(0, 10), "other", 1),
        delta(secret.slice(10), "third", 2),
        completed("items", secret),
      ],
      secret,
    );
    const events = responseEvents(records, "items");
    expect(
      events
        .filter((e) => e.output_index === 0)
        .map((e) => e.delta)
        .join(""),
    ).toBe("[REDACTED:injected-credential]");
    expect(events.find((e) => e.item_id === "other")!.delta).toBe(secret.slice(0, 10));
    expect(events.find((e) => e.item_id === "third")!.delta).toBe(secret.slice(10));
  });

  test("function arguments and public reasoning summaries redact their own exact streams", async () => {
    const secret = randomUUID();
    for (const type of [
      "response.function_call_arguments.delta",
      "response.reasoning_summary_text.delta",
    ]) {
      const records = await captured(
        "public",
        [
          { ...delta(secret.slice(0, 11)), type },
          { ...delta(secret.slice(11)), type },
          completed("public"),
        ],
        secret,
      );
      expect(
        responseEvents(records, "public")
          .filter((e) => e.type === type)
          .map((e) => e.delta)
          .join(""),
      ).toBe("[REDACTED:injected-credential]");
    }
  });

  test("failed and cancelled prefixes redact reconstructed credentials without inventing a terminal", async () => {
    for (const failure of ["error", "cancel"] as const) {
      const secret = randomUUID();
      const records: ModelRequestEvidence[] = [];
      const prefix = encode([
        delta("before:" + secret.slice(0, 13)),
        delta(secret.slice(13) + ":after"),
      ]);
      await withModelRequestEvidence(
        async (record) => {
          records.push(record);
        },
        async () => {
          registerModelEvidenceSecrets([secret]);
          const observer = beginModelRequestEvidence("codex-subscription", request("partial"))!;
          await observer.requestBody("{}");
          let delivered = false;
          const source = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!delivered) {
                delivered = true;
                controller.enqueue(new TextEncoder().encode(prefix));
              } else if (failure === "error")
                controller.error(new Error("synthetic stream failure"));
            },
          });
          const response = observer.observeResponse(
            new Response(source, { headers: { "content-type": "text/event-stream" } }),
          );
          if (failure === "error")
            await expect(response.text()).rejects.toThrow("synthetic stream failure");
          else {
            const reader = response.body!.getReader();
            await reader.read();
            void reader.cancel();
          }
        },
      );
      const record = records.find((r) => r.kind === "response")!;
      expect(record.status).toBe("unavailable");
      expect(record.redacted).toBe(true);
      const events = (record.content as any).events as Record<string, any>[];
      expect(events.map((e) => e.delta).join("")).toBe(
        "before:[REDACTED:injected-credential]:after",
      );
      expect(JSON.stringify(records)).not.toContain(secret);
      expect(assessModelRequestEvidence(records).complete).toBe(false);
    }
  });

  test("nested JSON credentials redact every bounded escape layer, without masking task text", async () => {
    const secret = randomUUID() + '"\\\n';
    for (let layers = 1; layers <= 5; layers++) {
      let body = JSON.stringify({ credential: secret, task: "sk-legitimate-task-content" });
      for (let i = 1; i < layers; i++) body = JSON.stringify({ output: body });
      const records: ModelRequestEvidence[] = [];
      await withModelRequestEvidence(
        async (record) => {
          records.push(record);
        },
        async () => {
          registerModelEvidenceSecrets([secret]);
          await beginModelRequestEvidence("codex-subscription", request("nested"))!.requestBody(
            body,
          );
        },
      );
      let decoded = JSON.parse((records.find((r) => r.kind === "request")!.content as any).body);
      for (let i = 1; i < layers; i++) decoded = JSON.parse(decoded.output);
      expect(decoded.credential).toBe("[REDACTED:injected-credential]");
      expect(decoded.task).toBe("sk-legitimate-task-content");
    }
  });

  test("event and terminal response identities cannot contradict in either order", async () => {
    const badEvents = [
      [{ ...delta("source"), response_id: "other" }, completed("actual")],
      [
        { type: "response.created", response: { id: "actual" } },
        { ...delta("source"), response_id: "other" },
        completed("actual"),
      ],
      [
        { ...delta("source"), response_id: "actual" },
        { ...delta("source"), response_id: "other" },
        completed("actual"),
      ],
      [{ ...completed("actual"), response_id: "other" }],
    ];
    for (const events of badEvents) {
      const records = await captured("actual", events);
      expect(records.find((r) => r.kind === "response")!.status).toBe("unavailable");
      expect(assessModelRequestEvidence(records).complete).toBe(false);
      expect(publicResponsesEvidence(encode(events)).unsupported).toBe(true);
    }
    const good = await captured("actual", [
      { ...delta("source"), response_id: "actual" },
      completed("actual"),
    ]);
    expect(assessModelRequestEvidence(good).complete).toBe(true);
    expect(
      publicResponsesEvidence(encode([{ type: "response.completed", response_id: "event-only" }]))
        .responseId,
    ).toBeUndefined();
  });

  test("strict assessor rejects impossible or invalid known usage; legitimate nulls stay null", async () => {
    const good = await captured("usage", [completed("usage")]);
    for (const patch of [
      { inputTokens: 1.5 },
      { outputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { cachedTokens: 101 },
      { cacheWriteTokens: 101 },
      { cachedTokens: 95, cacheWriteTokens: 10 },
      { reasoningTokens: 31 },
      { cachedTokens: -1 },
      { reasoningTokens: 0.5 },
      { cacheWriteTokens: "1" },
    ]) {
      const records = structuredClone(good);
      Object.assign(records.find((r) => r.kind === "usage")!.content as object, patch);
      expect(assessModelRequestEvidence(records).complete).toBe(false);
      expect(records.find((r) => r.kind === "usage")!.content).toMatchObject(patch);
    }
    for (const patch of [
      { cachedTokens: 100 },
      { cacheWriteTokens: 100 },
      { reasoningTokens: 30 },
      { cachedTokens: 70, cacheWriteTokens: 30 },
      { cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    ]) {
      const records = structuredClone(good);
      Object.assign(records.find((r) => r.kind === "usage")!.content as object, patch);
      expect(assessModelRequestEvidence(records).complete).toBe(true);
    }
    expect((good.find((r) => r.kind === "usage")!.content as any).cachedTokens).toBeNull();
    expect(assessModelRequestEvidence(good).complete).toBe(true);
  });
});
