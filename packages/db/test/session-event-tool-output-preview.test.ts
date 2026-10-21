import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { SESSION_EVENT_STEP_TYPES } from "@opengeni/contracts/session-history";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  listSessionEventPage,
  SESSION_EVENT_TOOL_OUTPUT_PREVIEW_MAX_BYTES,
  withWorkspaceSubjectRls,
  type ListSessionEventPageOptions,
} from "../src";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-event-tool-output-preview");
  if (!acquired) throw new Error("PostgreSQL required for tool output preview reads");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

async function seed(
  rows: Array<{
    sequence: number;
    type: string;
    payload: unknown;
    codec?: number;
  }>,
) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Tool output preview",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Previews",
    subjectId: `preview-reader-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    tools: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const turnId = crypto.randomUUID();
  for (const row of rows) {
    await shared.admin`
      insert into session_events
        (account_id,workspace_id,session_id,turn_id,sequence,type,payload,payload_codec_version)
      values (${grant.accountId},${grant.workspaceId},${session.id},${turnId},${row.sequence},
        ${row.type},${shared.admin.json(row.payload as never)},${row.codec ?? null})`;
  }
  const read = (options: ListSessionEventPageOptions) =>
    withWorkspaceSubjectRls(client.db, grant.workspaceId, grant.subjectId, (tx) =>
      listSessionEventPage(tx, grant.workspaceId, session.id, options),
    );
  return { read };
}

const stepRead = {
  includeTypes: [...SESSION_EVENT_STEP_TYPES],
  before: Number.MAX_SAFE_INTEGER,
  direction: "before",
  limit: 200,
  payloadMode: "full",
} satisfies ListSessionEventPageOptions;

test("step reads bound large tool outputs and keep everything else exact", async () => {
  const longOutput = `Chunk ID: 1\nProcess exited with code 3\nOutput:\n${"x".repeat(60_000)}\nlast line`;
  const mcpText = `${"result line\n".repeat(4_000)}tail of result`;
  const receipt = { type: "retained_image", artifactId: "a1", available: true };
  const image = `data:image/png;base64,${"A".repeat(40_000)}`;
  const truncation = {
    truncated: true,
    surface: "durable_audit",
    reason: "payload_bytes_exceeded",
    fullEvidence: { available: false, reason: "not_retained" },
  };
  const { read } = await seed([
    { sequence: 1, type: "agent.toolCall.created", payload: { id: "c1", name: "exec_command" } },
    { sequence: 2, type: "agent.toolCall.output", payload: { id: "c1", output: "small" } },
    {
      sequence: 3,
      type: "agent.toolCall.output",
      payload: { id: "c2", output: longOutput, truncation },
    },
    {
      sequence: 4,
      type: "agent.toolCall.output",
      payload: {
        id: "c3",
        output: { isError: true, content: [{ type: "text", text: mcpText }, receipt] },
      },
    },
    // Inline media cannot be shortened: the output falls back to text.
    {
      sequence: 5,
      type: "agent.toolCall.output",
      payload: {
        id: "c4",
        output: [{ type: "input_image", image_url: image }],
        error: false,
        failed: true,
      },
    },
    // Large, but nothing long enough to shorten: exact.
    {
      sequence: 6,
      type: "agent.toolCall.output",
      payload: { id: "c5", output: Array.from({ length: 300 }, (_, index) => `item ${index}`) },
    },
    // Lossless-codec rows are never shortened.
    {
      sequence: 7,
      type: "agent.toolCall.output",
      payload: { id: "c6", output: "y".repeat(20_000) },
      codec: 1,
    },
    // Only tool outputs are previewed.
    {
      sequence: 8,
      type: "agent.toolCall.created",
      payload: { id: "c7", name: "apply_patch", arguments: { patch: "z".repeat(20_000) } },
    },
  ]);

  const exact = await read(stepRead);
  expect(exact.fullPayloadsExact).toBe(true);
  expect(
    exact.events.some((event) => JSON.stringify(event.payload).includes("outputPreview")),
  ).toBe(false);

  const page = await read({ ...stepRead, toolOutputPreview: true });
  expect(page.fullPayloadsExact).toBe(false);
  const bySequence = new Map(page.events.map((event) => [event.sequence, event]));
  const payload = (sequence: number) => bySequence.get(sequence)!.payload as Record<string, any>;

  expect(payload(1)).toEqual({ id: "c1", name: "exec_command" });
  expect(payload(2)).toEqual({ id: "c1", output: "small" });

  // A long string keeps its head and tail around an explicit marker; other
  // fields (the durable truncation fact) are kept.
  const exec = payload(3);
  expect(exec.id).toBe("c2");
  expect(exec.truncation).toEqual(truncation);
  expect(exec.output.startsWith("Chunk ID: 1\nProcess exited with code 3\n")).toBe(true);
  expect(exec.output.endsWith("x\nlast line")).toBe(true);
  expect(exec.output).toContain(
    `…[${longOutput.length - 1536} characters omitted from this preview]…`,
  );
  expect(exec.outputPreview).toEqual({
    truncated: true,
    reason: "tool_output_preview",
    shape: "structured",
    originalBytes: expect.any(Number),
    previewBytes: expect.any(Number),
  });
  expect(exec.outputPreview.originalBytes).toBeGreaterThan(60_000);
  expect(bytes(exec)).toBeLessThanOrEqual(SESSION_EVENT_TOOL_OUTPUT_PREVIEW_MAX_BYTES);

  // A structured result keeps its shape, flags and non-text items.
  const mcp = payload(4);
  expect(mcp.output.isError).toBe(true);
  expect(mcp.output.content[1]).toEqual(receipt);
  expect(mcp.output.content[0].type).toBe("text");
  expect(mcp.output.content[0].text.startsWith("result line\n")).toBe(true);
  expect(mcp.output.content[0].text.endsWith("tail of result")).toBe(true);
  expect(mcp.outputPreview.shape).toBe("structured");

  const media = payload(5);
  expect(media.outputPreview.shape).toBe("text");
  expect(media.id).toBe("c4");
  expect(media.error).toBe(false);
  // Status flags survive the text preview.
  expect(media.failed).toBe(true);
  expect(typeof media.output).toBe("string");
  expect(media.output).toContain("characters omitted from this preview");
  expect(bytes(media)).toBeLessThanOrEqual(SESSION_EVENT_TOOL_OUTPUT_PREVIEW_MAX_BYTES);

  expect(payload(6).output).toHaveLength(300);
  expect(payload(6).outputPreview).toBeUndefined();
  expect(payload(7).output).toBe("y".repeat(20_000));
  expect(payload(8).arguments.patch).toBe("z".repeat(20_000));

  // One row's exact payload is an ordinary full read around its sequence.
  const full = await read({
    includeTypes: ["agent.toolCall.output"],
    after: 2,
    before: 4,
    direction: "after",
    limit: 1,
    payloadMode: "full",
  });
  expect(full.events).toHaveLength(1);
  expect(full.fullPayloadsExact).toBe(true);
  expect((full.events[0]!.payload as Record<string, unknown>).output).toBe(longOutput);
}, 120_000);

test("previews let one step page hold many large outputs", async () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({
    sequence: index + 1,
    type: "agent.toolCall.output",
    payload: { id: `c${index}`, output: `${index}:${"o".repeat(60_000)}` },
  }));
  const { read } = await seed(rows);

  const exact = await read(stepRead);
  expect(exact.hasMore).toBe(true);
  expect(exact.truncatedBy).toBe("bytes");
  expect(exact.events.length).toBeLessThan(20);

  const previewed = await read({ ...stepRead, toolOutputPreview: true });
  expect(previewed.events).toHaveLength(40);
  expect(previewed.hasMore).toBe(false);
  expect(previewed.bytes).toBeLessThan(40 * 3_000);

  // The planned (metadata) path used by larger reads bounds them the same way.
  const planned = await read({ ...stepRead, limit: 1_000, toolOutputPreview: true });
  expect(planned.events).toHaveLength(40);
  expect(planned.hasMore).toBe(false);
}, 120_000);
