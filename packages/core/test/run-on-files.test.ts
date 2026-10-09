import { expect, spyOn, test } from "bun:test";
import { ControlRequest, ControlResponse, OpState } from "@opengeni/agent-proto";
import * as db from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import { MockAgentResponder } from "@opengeni/runtime/sandbox";
import { testSettings } from "@opengeni/testing";
import { fileContentDigest } from "../../runtime/src/sandbox/selfhosted/file-transfer";
import { runOnSandbox } from "../src/sandbox/fleet";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const PATH = "/workspace/synthetic.txt";
const CONTENT = "Synthetic UTF-8 content: ø🙂\n".repeat(45_000);

async function fixture(options: {
  content?: string;
  original?: string;
  capable?: boolean;
  afterStart?: "revoke" | "replace" | "unauthorized";
}) {
  let live: db.EnrollmentRecord | null = {
    id: "33333333-3333-4333-8333-333333333333",
    workspaceId: WORKSPACE,
    status: "active",
    connectionInstanceId: "runner-a",
    workspaceRoot: "/workspace",
    agentCapabilities: { transactionalFsWrite: options.capable !== false },
    opStream: false,
  } as db.EnrollmentRecord;
  const sandbox = spyOn(db, "getSandbox").mockResolvedValue({
    id: TARGET,
    workspaceId: WORKSPACE,
    kind: "selfhosted",
    enrollmentId: live.id,
    name: "Synthetic machine",
    scope: "workspace",
  } as db.SandboxRecord);
  const enrollment = spyOn(db, "getLiveEnrollmentConnection").mockImplementation(async () => live);
  const files = new MockAgentResponder({
    files: options.original === undefined ? {} : { [PATH]: options.original },
  });
  const requests: ControlRequest[] = [];
  const sizes: number[] = [];
  const chunks: Uint8Array[] = [];
  let operationId = "";
  let digest = "";
  let committed: Uint8Array | undefined;
  const connection = {
    request: async (subject: string, payload: Uint8Array, opts: { timeout: number }) => {
      if (payload.byteLength > 1024 * 1024) {
        throw Object.assign(new Error("MAX_PAYLOAD_EXCEEDED"), { code: "MAX_PAYLOAD_EXCEEDED" });
      }
      sizes.push(payload.byteLength);
      const request = ControlRequest.decode(payload);
      requests.push(request);
      const op = request.op;
      let response: ControlResponse;
      if (op?.$case === "opStart" && op.opStart.op?.$case === "fsWrite") {
        operationId = request.requestId;
        digest = op.opStart.op.fsWrite.contentDigest;
        expect(op.opStart.op.fsWrite.expectedAbsent).toBe(options.original === undefined);
        expect(op.opStart.op.fsWrite.expectedBaseDigest).toBe(
          options.original === undefined ? "" : fileContentDigest(Buffer.from(options.original)),
        );
        response = ControlResponse.fromPartial({
          requestId: request.requestId,
          result: {
            $case: "opStart",
            opStart: {
              accepted: true,
              status: { opId: operationId, state: OpState.OP_STATE_RUNNING },
            },
          },
        });
        if (options.afterStart === "revoke") live = { ...live!, agentCapabilities: {} };
        if (options.afterStart === "replace") live = { ...live!, connectionInstanceId: "runner-b" };
        if (options.afterStart === "unauthorized") live = null;
      } else if (op?.$case === "writeChunk") {
        expect(op.writeChunk.opId).toBe(operationId);
        expect(op.writeChunk.seq).toBe(String(chunks.length));
        expect(op.writeChunk.offset).toBe(
          String(chunks.reduce((sum, bytes) => sum + bytes.length, 0)),
        );
        chunks.push(op.writeChunk.bytes);
        if (op.writeChunk.last) {
          committed = Buffer.concat(chunks);
          expect(fileContentDigest(committed)).toBe(digest);
        }
        response = ControlResponse.fromPartial({
          requestId: request.requestId,
          result: { $case: "writeChunk", writeChunk: { seq: op.writeChunk.seq } },
        });
      } else if (op?.$case === "opQuery") {
        expect(op.opQuery.opId).toBe(operationId);
        response = ControlResponse.fromPartial({
          requestId: request.requestId,
          result: {
            $case: "opStatus",
            opStatus: {
              opId: operationId,
              state: committed ? OpState.OP_STATE_COMPLETE : OpState.OP_STATE_RUNNING,
              exit: committed
                ? {
                    exitCode: 0,
                    digests: { content: digest },
                    totals: { content: String(committed.length) },
                  }
                : undefined,
            },
          },
        });
      } else {
        response = await files.request(subject, request, { timeoutMs: opts.timeout });
        // The production read API is chunked; the generic mock returns the whole file.
        if (op?.$case === "fsRead" && response.result?.$case === "fsRead") {
          response.result.fsRead.content = response.result.fsRead.content.slice(
            Number(op.fsRead.offset),
            Number(op.fsRead.offset) + Number(op.fsRead.length),
          );
        }
      }
      return { data: ControlResponse.encode(response).finish() };
    },
  };
  try {
    const result = await runOnSandbox(
      {
        db: {} as db.Database,
        settings: testSettings({ agentOpStreamEnabled: false }),
        bus: { getRequestConnection: async () => connection } as unknown as EventBus,
      },
      {
        accountId: WORKSPACE,
        workspaceId: WORKSPACE,
        sessionId: TARGET,
        sessionBackend: "selfhosted",
        sessionGroupId: TARGET,
      },
      TARGET,
      { kind: "write", path: PATH, content: options.content ?? CONTENT },
    );
    return { result, requests, sizes, chunks, committed, files };
  } finally {
    sandbox.mockRestore();
    enrollment.mockRestore();
  }
}

test.each([false, true])(
  "run_on chunks a supported large write (existing: %p)",
  async (existing) => {
    const result = await fixture({ original: existing ? CONTENT : undefined });
    expect(result.result).toMatchObject({ ok: true, bytesWritten: Buffer.byteLength(CONTENT) });
    expect(Buffer.from(result.committed!).toString()).toBe(CONTENT);
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(Math.max(...result.sizes)).toBeLessThan(1024 * 1024);
    expect(result.requests.filter((request) => request.op?.$case === "opStart")).toHaveLength(1);
    expect(result.requests.some((request) => request.op?.$case === "fsWrite")).toBe(false);
  },
);

test.each(["revoke", "replace", "unauthorized"] as const)(
  "run_on rechecks authority and pins the file-transfer route: %s",
  async (afterStart) => {
    const result = await fixture({ afterStart });
    expect(result.result.ok).toBe(false);
    expect(result.result.reason).toContain("No mutation was replayed");
    expect(result.chunks).toHaveLength(0);
    expect(result.committed).toBeUndefined();
    expect(result.requests.filter((request) => request.op?.$case === "opStart")).toHaveLength(1);
    expect(result.requests.some((request) => request.op?.$case === "fsWrite")).toBe(false);
  },
);

test("run_on preserves legacy small writes and refuses oversized messages without a capable runner", async () => {
  const small = await fixture({ capable: false, content: "small" });
  expect(small.result).toMatchObject({ ok: true, bytesWritten: 5 });
  expect(small.files.fileText(PATH)).toBe("small");
  const large = await fixture({ capable: false });
  expect(large.result).toMatchObject({ ok: false, kind: "write" });
  expect(large.result.reason).toContain("per-message size limit");
  expect(large.requests).toHaveLength(0);
});
