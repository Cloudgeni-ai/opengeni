import { expect, test } from "bun:test";
import { ControlRequest, ControlResponse, ErrorCode, OpState } from "@opengeni/agent-proto";
import { fileContentDigest, transferEditorFile } from "../src/sandbox/selfhosted/file-transfer";
import { NatsControlRpc, agentErrorToControlError } from "../src/sandbox/selfhosted/control-rpc";
import { renderSelfhostedFault } from "../src/sandbox/selfhosted/fault-rendering";
import { applyDiff } from "@openai/agents";
import { setSelfhostedApplyDiff } from "../src/sandbox/selfhosted/session";
import { MockAgentResponder, SelfhostedSession } from "../src/sandbox";

test("a tiny editor diff can update a file larger than the control message budget", async () => {
  setSelfhostedApplyDiff(applyDiff);
  const path = "/workspace/large.md";
  const original = "# Before\n" + "Synthetic document line.\n".repeat(60000);
  const agent = new MockAgentResponder({ files: { [path]: original } });
  let transferId = "";
  let expectedDigest = "";
  const chunks: Uint8Array[] = [];
  let committed: Uint8Array | undefined;
  const observations: string[] = [];
  const rpc = new NatsControlRpc(async () => ({
    request: async (subject, payload, opts) => {
      if (payload.byteLength > 1024 * 1024) {
        throw Object.assign(new Error("MAX_PAYLOAD_EXCEEDED"), {
          code: "MAX_PAYLOAD_EXCEEDED",
        });
      }
      const request = ControlRequest.decode(payload);
      const op = request.op;
      let response: ControlResponse;
      if (op?.$case === "opStart" && op.opStart.op?.$case === "fsWrite") {
        transferId = request.requestId;
        expectedDigest = op.opStart.op.fsWrite.contentDigest;
        expect(op.opStart.op.fsWrite.expectedBaseDigest).toBe(
          fileContentDigest(new TextEncoder().encode(original)),
        );
        response = ControlResponse.fromPartial({
          requestId: request.requestId,
          result: {
            $case: "opStart",
            opStart: {
              accepted: true,
              status: { opId: transferId, state: OpState.OP_STATE_RUNNING },
            },
          },
        });
      } else if (op?.$case === "writeChunk") {
        expect(op.writeChunk.opId).toBe(transferId);
        expect(op.writeChunk.seq).toBe(String(chunks.length));
        chunks.push(op.writeChunk.bytes);
        if (op.writeChunk.last) {
          const content = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
          let cursor = 0;
          for (const chunk of chunks) {
            content.set(chunk, cursor);
            cursor += chunk.length;
          }
          expect(fileContentDigest(content)).toBe(expectedDigest);
          await agent.request(
            subject,
            ControlRequest.fromPartial({
              requestId: "synthetic-commit",
              op: {
                $case: "fsWrite",
                fsWrite: { path, content },
              },
            }),
            { timeoutMs: opts.timeout },
          );
          committed = content;
        }
        response = ControlResponse.fromPartial({
          requestId: request.requestId,
          result: {
            $case: "writeChunk",
            writeChunk: { seq: op.writeChunk.seq },
          },
        });
      } else if (op?.$case === "opQuery") {
        response = ControlResponse.fromPartial({
          requestId: request.requestId,
          result: {
            $case: "opStatus",
            opStatus: {
              opId: transferId,
              state: committed ? OpState.OP_STATE_COMPLETE : OpState.OP_STATE_RUNNING,
              exit: committed
                ? {
                    exitCode: 0,
                    digests: { content: expectedDigest },
                    totals: { content: String(committed.length) },
                  }
                : undefined,
            },
          },
        });
      } else {
        response = await agent.request(subject, request, {
          timeoutMs: opts.timeout,
        });
      }
      return { data: ControlResponse.encode(response).finish() };
    },
  }));
  const session = new SelfhostedSession({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    agentId: "synthetic-agent",
    connectionInstanceId: "22222222-2222-4222-8222-222222222222",
    workspaceRoot: "/workspace",
    controlRpc: rpc,
    relay: { host: "relay.test", port: 443, tls: true },
    epoch: 1,
    transactionalFsWriteSupported: true,
    onOp: (event) => {
      observations.push(`${event.op}:${event.outcome}`);
    },
  });
  await session.createEditor().updateFile({
    path,
    diff: "@@\n-# Before\n+# After\n Synthetic document line.",
  });
  expect(new TextDecoder().decode(await session.readFile({ path }))).toBe(
    original.replace("# Before", "# After"),
  );
  expect(observations).toContain("opStart:ok");
  expect(observations).toContain("writeChunk:ok");
  expect(observations).toContain("opQuery:ok");
  expect(observations).toContain("fsWrite:ok");
});

test("an oversized outbound write is a payload fault, not a disconnected machine", async () => {
  let connections = 0;
  let writes = 0;
  const rpc = new NatsControlRpc(async () => {
    connections += 1;
    return {
      request: async (_subject, payload) => {
        if (payload.byteLength > 1024 * 1024) {
          throw Object.assign(new Error("MAX_PAYLOAD_EXCEEDED"), {
            code: "MAX_PAYLOAD_EXCEEDED",
          });
        }
        const request = ControlRequest.decode(payload);
        writes += 1;
        return {
          data: ControlResponse.encode({
            requestId: request.requestId,
            result: { $case: "fsWrite", fsWrite: { bytesWritten: "2" } },
          }).finish(),
        };
      },
    };
  });
  const request = ControlRequest.fromPartial({
    requestId: "large-file-update",
    op: {
      $case: "fsWrite",
      fsWrite: {
        path: "/workspace/large.md",
        content: new Uint8Array(1024 * 1024 + 1),
      },
    },
  });
  const failed = await rpc.request("agent.test.rpc", request, { timeoutMs: 100 });
  expect(failed.error?.code).toBe(ErrorCode.ERROR_CODE_PAYLOAD_TOO_LARGE);
  const rendered = renderSelfhostedFault(agentErrorToControlError(failed.error!));
  expect(rendered).toContain("not sent");
  expect(rendered).not.toContain("command ran");
  expect(writes).toBe(0);
  if (request.op?.$case !== "fsWrite") throw new Error("expected write");
  request.op.fsWrite.content = new TextEncoder().encode("ok");
  const succeeded = await rpc.request("agent.test.rpc", request, { timeoutMs: 100 });
  expect(succeeded.result?.$case).toBe("fsWrite");
  expect(connections).toBe(1);
  expect(writes).toBe(1);
});

test("an old agent keeps accepting edits within its existing message budget", async () => {
  setSelfhostedApplyDiff(applyDiff);
  const path = "/workspace/legacy.md";
  const original = "# Before\n" + "plain text\n".repeat(40000);
  const agent = new MockAgentResponder({ files: { [path]: original } });
  const session = new SelfhostedSession({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    agentId: "synthetic-agent",
    connectionInstanceId: "22222222-2222-4222-8222-222222222222",
    workspaceRoot: "/workspace",
    controlRpc: agent,
    relay: { host: "relay.test", port: 443, tls: true },
    epoch: 1,
  });
  await session.createEditor().updateFile({ path, diff: "@@\n-# Before\n+# After\n plain text" });
  expect(new TextDecoder().decode(await session.readFile({ path }))).toBe(
    original.replace("# Before", "# After"),
  );
  expect(agent.requests.some(({ req }) => req.op?.$case === "opStart")).toBe(false);
});

for (const failure of [
  "chunk-timeout",
  "lost-after-restart",
  "wrong-digest",
  "late-commit",
  "final-query-timeout",
  "final-query-fenced",
  "final-query-authorization",
  "final-query-malformed",
  "abandoned-running",
  "cancel-raced-commit",
  "cancel-timeout",
] as const) {
  test(`transactional editing handles ${failure} without mutation replay`, async () => {
    const mutations: string[] = [];
    const content = new TextEncoder().encode("verified content");
    let opId = "";
    const request = async (
      requestId: string,
      op: NonNullable<ControlRequest["op"]>,
    ): Promise<ControlResponse> => {
      if (op.$case === "opStart") {
        mutations.push("begin");
        opId = requestId;
        return ControlResponse.fromPartial({
          requestId,
          result: {
            $case: "opStart",
            opStart: {
              accepted: true,
              status: { opId, state: OpState.OP_STATE_RUNNING },
            },
          },
        });
      }
      if (op.$case === "writeChunk") {
        mutations.push("chunk");
        if (
          failure === "chunk-timeout" ||
          failure === "late-commit" ||
          failure === "abandoned-running" ||
          failure === "cancel-raced-commit" ||
          failure === "cancel-timeout"
        )
          return ControlResponse.fromPartial({
            requestId,
            error: {
              code: ErrorCode.ERROR_CODE_TIMEOUT,
              message: "synthetic lost acknowledgment",
            },
          });
        return ControlResponse.fromPartial({
          requestId,
          result: { $case: "writeChunk", writeChunk: { seq: op.writeChunk.seq } },
        });
      }
      if (op.$case === "opCancel") {
        mutations.push("cancel");
        expect(op.opCancel.opId).toBe(opId);
        if (failure === "cancel-timeout")
          return ControlResponse.fromPartial({
            requestId,
            error: {
              code: ErrorCode.ERROR_CODE_TIMEOUT,
              message: "cancellation acknowledgment lost",
            },
          });
        if (failure === "cancel-raced-commit")
          return ControlResponse.fromPartial({
            requestId,
            result: {
              $case: "opStatus",
              opStatus: {
                opId,
                state: OpState.OP_STATE_COMPLETE,
                exit: {
                  exitCode: 0,
                  digests: { content: fileContentDigest(content) },
                  totals: { content: String(content.length) },
                },
              },
            },
          });
        return ControlResponse.fromPartial({
          requestId,
          result: {
            $case: "opStatus",
            opStatus: {
              opId,
              state: OpState.OP_STATE_COMPLETE,
              exit: { exitCode: -1, cancelled: true },
            },
          },
        });
      }
      if (
        failure === "abandoned-running" ||
        failure === "cancel-raced-commit" ||
        failure === "cancel-timeout"
      )
        return ControlResponse.fromPartial({
          requestId,
          result: {
            $case: "opStatus",
            opStatus: { opId, state: OpState.OP_STATE_RUNNING },
          },
        });
      if (failure === "final-query-timeout")
        return ControlResponse.fromPartial({
          requestId,
          error: {
            code: ErrorCode.ERROR_CODE_TIMEOUT,
            message: "synthetic final query timeout",
          },
        });
      if (failure === "final-query-fenced")
        return ControlResponse.fromPartial({
          requestId,
          error: {
            code: ErrorCode.ERROR_CODE_FENCED,
            message: "synthetic stale epoch",
          },
        });
      if (failure === "final-query-authorization")
        throw new Error("synthetic authorization revoked");
      if (failure === "final-query-malformed")
        return ControlResponse.fromPartial({ requestId: "wrong-response" });
      return ControlResponse.fromPartial({
        requestId,
        result: {
          $case: "opStatus",
          opStatus: {
            opId,
            state:
              failure === "lost-after-restart" ? OpState.OP_STATE_LOST : OpState.OP_STATE_COMPLETE,
            exit: {
              exitCode: 0,
              digests: {
                content: failure === "late-commit" ? fileContentDigest(content) : "wrong",
              },
              totals: { content: String(content.length) },
            },
          },
        },
      });
    };
    if (failure === "late-commit" || failure === "cancel-raced-commit") {
      await transferEditorFile({ path: "/workspace/new.md", content, request });
    } else {
      let caught: unknown;
      try {
        await transferEditorFile({ path: "/workspace/new.md", content, request });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { retryable?: boolean }).retryable).not.toBe(true);
    }
    expect(mutations).toEqual(
      ["abandoned-running", "cancel-raced-commit", "cancel-timeout"].includes(failure)
        ? ["begin", "chunk", "cancel"]
        : ["begin", "chunk"],
    );
  });
}

for (const changed of ["authorization", "connection", "capability"] as const) {
  test(`a transfer cannot continue after live ${changed} changes`, async () => {
    setSelfhostedApplyDiff(applyDiff);
    const path = "/workspace/authorized.md";
    const original = "# Before\n" + "fixture text\n".repeat(40000);
    const agent = new MockAgentResponder({ files: { [path]: original } });
    let began = false;
    const sent: string[] = [];
    const connection = "22222222-2222-4222-8222-222222222222";
    const rpc = {
      request: async (subject: string, request: ControlRequest, opts: { timeoutMs: number }) => {
        sent.push(request.op!.$case);
        if (request.op?.$case === "opStart") {
          began = true;
          return ControlResponse.fromPartial({
            requestId: request.requestId,
            result: {
              $case: "opStart",
              opStart: {
                accepted: true,
                status: { opId: request.requestId, state: OpState.OP_STATE_RUNNING },
              },
            },
          });
        }
        return await agent.request(subject, request, opts);
      },
    };
    const session = new SelfhostedSession({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      agentId: "synthetic-agent",
      connectionInstanceId: connection,
      workspaceRoot: "/workspace",
      controlRpc: rpc,
      relay: { host: "relay.test", port: 443, tls: true },
      epoch: 1,
      resolveOperationAdmission: async () => {
        if (began && changed === "authorization") return null;
        return {
          connectionInstanceId:
            began && changed === "connection" ? "33333333-3333-4333-8333-333333333333" : connection,
          workspaceRoot: "/workspace",
          transactionalFsWriteSupported: !(began && changed === "capability"),
          operationResourcePolicy: {
            memoryMaxBytes: null,
            memoryHighBytes: null,
            cpuMaxMillicores: null,
            revision: 0,
          },
          operationResourcePolicySupported: false,
          operationCpuQuotaSupported: false,
        };
      },
    });
    await expect(
      session.createEditor().updateFile({ path, diff: "@@\n-# Before\n+# After\n fixture text" }),
    ).rejects.toThrow();
    expect(sent.filter((op) => op === "opStart")).toHaveLength(1);
    expect(sent).not.toContain("writeChunk");
    expect(sent).not.toContain("opQuery");
  });
}

test("a large move never deletes its source through a replacement connection", async () => {
  setSelfhostedApplyDiff(applyDiff);
  const path = "/workspace/source.md";
  const agent = new MockAgentResponder({
    files: { [path]: "# Before\n" + "move fixture\n".repeat(40000) },
  });
  let verified = false;
  let opId = "";
  let digest = "";
  let size = "";
  const sent: string[] = [];
  const connection = "22222222-2222-4222-8222-222222222222";
  const session = new SelfhostedSession({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    agentId: "synthetic-agent",
    connectionInstanceId: connection,
    workspaceRoot: "/workspace",
    epoch: 1,
    relay: { host: "relay.test", port: 443, tls: true },
    resolveOperationAdmission: async () => ({
      connectionInstanceId: verified ? "33333333-3333-4333-8333-333333333333" : connection,
      workspaceRoot: "/workspace",
      transactionalFsWriteSupported: true,
      operationResourcePolicy: {
        memoryMaxBytes: null,
        memoryHighBytes: null,
        cpuMaxMillicores: null,
        revision: 0,
      },
      operationResourcePolicySupported: false,
      operationCpuQuotaSupported: false,
    }),
    controlRpc: {
      request: async (subject, request, opts) => {
        sent.push(request.op!.$case);
        const op = request.op;
        if (op?.$case === "opStart" && op.opStart.op?.$case === "fsWrite") {
          opId = request.requestId;
          digest = op.opStart.op.fsWrite.contentDigest;
          size = op.opStart.op.fsWrite.contentSize!;
          return ControlResponse.fromPartial({
            requestId: request.requestId,
            result: {
              $case: "opStart",
              opStart: { accepted: true, status: { opId, state: OpState.OP_STATE_RUNNING } },
            },
          });
        }
        if (op?.$case === "writeChunk")
          return ControlResponse.fromPartial({
            requestId: request.requestId,
            result: { $case: "writeChunk", writeChunk: { seq: op.writeChunk.seq } },
          });
        if (op?.$case === "opQuery") {
          verified = true;
          return ControlResponse.fromPartial({
            requestId: request.requestId,
            result: {
              $case: "opStatus",
              opStatus: {
                opId,
                state: OpState.OP_STATE_COMPLETE,
                exit: { exitCode: 0, digests: { content: digest }, totals: { content: size } },
              },
            },
          });
        }
        return await agent.request(subject, request, opts);
      },
    },
  });
  await expect(
    session.createEditor().updateFile({
      path,
      moveTo: "/workspace/destination.md",
      diff: "@@\n-# Before\n+# After\n move fixture",
    }),
  ).rejects.toThrow("source cleanup was not verified");
  expect(verified).toBe(true);
  expect(sent).not.toContain("fsRemove");
});

for (const legacy of [false, true]) {
  test(`${legacy ? "legacy large" : "small capable"} moves do not acquire new destination read requirements`, async () => {
    setSelfhostedApplyDiff(applyDiff);
    const source = "/workspace/source.md";
    const destination = "/workspace/write-only.md";
    const original = "# Before\n" + (legacy ? "fixture\n".repeat(40000) : "fixture\n");
    const agent = new MockAgentResponder({
      files: { [source]: original, [destination]: "existing" },
    });
    let destinationReads = 0;
    const session = new SelfhostedSession({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      agentId: "synthetic-agent",
      connectionInstanceId: "22222222-2222-4222-8222-222222222222",
      workspaceRoot: "/workspace",
      relay: { host: "relay.test", port: 443, tls: true },
      epoch: 1,
      transactionalFsWriteSupported: !legacy,
      controlRpc: {
        request: async (subject, request, opts) => {
          if (request.op?.$case === "fsRead" && request.op.fsRead.path === destination) {
            destinationReads += 1;
            return ControlResponse.fromPartial({
              requestId: request.requestId,
              error: {
                code: ErrorCode.ERROR_CODE_OS,
                message: "destination is writable but not readable",
              },
            });
          }
          return await agent.request(subject, request, opts);
        },
      },
    });
    await session
      .createEditor()
      .updateFile({ path: source, moveTo: destination, diff: "@@\n-# Before\n+# After\n fixture" });
    expect(destinationReads).toBe(0);
    expect(
      agent.requests.some(
        ({ req }) => req.op?.$case === "fsWrite" && req.op.fsWrite.path === destination,
      ),
    ).toBe(true);
  });
}
