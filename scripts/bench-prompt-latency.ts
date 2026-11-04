#!/usr/bin/env bun
/** Small, explicitly invoked paid measurement through the public API.
 * Requires BENCH_API_BASE, BENCH_API_KEY_FILE ({token,workspaceId}) and BENCH_MODEL.
 * Two warm-ups, then ten alternating turns per arm. Never reads provider keys.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const base = process.env.BENCH_API_BASE;
const keyFile = process.env.BENCH_API_KEY_FILE;
const model = process.env.BENCH_MODEL;
if (!base || !keyFile || !model)
  throw new Error("Explicit API, credential file and model required");
const key = JSON.parse(await readFile(keyFile, "utf8")) as { token: string; workspaceId: string };
const output = resolve(process.argv[2] ?? ".startup/provider");
await mkdir(output, { recursive: true });
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}/v1/workspaces/${key.workspaceId}${path}`, {
    method,
    headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
  return await response.json();
};
type Event = {
  sequence: number;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};
const arms = [
  { name: "full", id: "", sequence: 0 },
  { name: "minimal", id: "", sequence: 0 },
];
const samples: Array<Record<string, unknown>> = [];
let costMicros = 0;
for (let round = -1; round < 10; round++) {
  for (const arm of arms) {
    // Only this benchmark's sessions receive the smaller configuration.
    const prompt = "Reply with exactly OK. Do not use any tools.";
    if (!arm.id) {
      const created = await api("POST", "/sessions", {
        title: `Prompt latency: ${arm.name}`,
        initialMessage: prompt,
        model,
        reasoningEffort: "medium",
        timeZone: "UTC",
        idempotencyKey: crypto.randomUUID(),
        ...(arm.name === "minimal"
          ? {
              agent: {
                capabilities: "none",
                identity: "You are a helpful assistant.",
                instructions: "Reply briefly.",
              },
              sandboxBackend: "none",
            }
          : {}),
      });
      arm.id = created.id;
    } else {
      await api("POST", `/sessions/${arm.id}/events`, {
        type: "user.message",
        clientEventId: crypto.randomUUID(),
        payload: { text: prompt, model, reasoningEffort: "medium", timeZone: "UTC" },
      });
    }
    const events: Event[] = [];
    const deadline = performance.now() + 120_000;
    for (;;) {
      const page = await api(
        "GET",
        `/sessions/${arm.id}/events?after=${arm.sequence}&limit=500&direction=after&mode=forensic&payloadMode=full`,
      );
      const fresh = (page.events ?? page.data ?? page) as Event[];
      events.push(...fresh);
      if (fresh.length) arm.sequence = fresh.at(-1)!.sequence;
      if (events.some((e) => e.type === "turn.failed"))
        throw new Error(`Measurement turn failed (${arm.name})`);
      if (events.some((e) => e.type === "turn.completed")) break;
      if (performance.now() > deadline)
        throw new Error(
          `Measurement timed out (${arm.name}); inspect its retained session before retrying`,
        );
      await Bun.sleep(250);
    }
    await writeFile(
      `${output}/${arm.name}-${round}.json`,
      JSON.stringify({ sessionId: arm.id, events }, null, 2),
    );
    const request = events.find(
      (e) => e.type === "agent.model.request" && e.payload.phase === "started",
    );
    const firstByte = events.find(
      (e) => e.type === "agent.model.request" && e.payload.phase === "first_byte",
    );
    const firstText = events.find(
      (e) => e.type === "agent.message.delta" || e.type === "agent.message.completed",
    );
    const usage = events.filter(
      (e) => e.type === "agent.model.usage" && e.payload.purpose === "main",
    );
    if (!request || !firstByte || !firstText || usage.length !== 1)
      throw new Error("Expected one complete model request");
    const wireAt =
      typeof firstByte.payload.initialWireDispatchedAt === "string"
        ? Date.parse(firstByte.payload.initialWireDispatchedAt)
        : null;
    const cost = events
      .filter((e) => e.type === "agent.model.usage")
      .reduce((sum, e) => sum + Number(e.payload.pricedCostMicros ?? 0), 0);
    costMicros += cost;
    const sample = {
      arm: arm.name,
      round,
      warmup: round < 0,
      provider: request.payload.provider,
      requestToFirstByteMs: Number(firstByte.payload.durationMs),
      wireToFirstByteMs: wireAt === null ? null : Date.parse(firstByte.occurredAt) - wireAt,
      wireToFirstTextMs: wireAt === null ? null : Date.parse(firstText.occurredAt) - wireAt,
      requestToFirstTextMs: Date.parse(firstText.occurredAt) - Date.parse(request.occurredAt),
      inputTokens: usage[0]!.payload.inputTokens,
      cachedTokens: usage[0]!.payload.cachedTokens,
      outputTokens: usage[0]!.payload.outputTokens,
      reasoningTokens: usage[0]!.payload.reasoningTokens,
      pricedCostMicros: cost,
    };
    samples.push(sample);
    await writeFile(
      `${output}/samples.json`,
      JSON.stringify({ model, costMicros, samples }, null, 2),
    );
    console.log(JSON.stringify(sample));
    // A bounded experiment, not a runtime quota or production workload control.
    if (costMicros > 3_000_000 || (round === -1 && costMicros * 11 > 5_000_000)) {
      throw new Error("Experiment spend estimate exceeds its small budget; no more calls started");
    }
  }
}
