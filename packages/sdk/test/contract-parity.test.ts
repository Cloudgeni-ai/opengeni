import { describe, expect, test } from "bun:test";
import {
  ClientSessionEvent,
  CreateSessionRequest as ContractCreateSessionRequest,
  SandboxBackend as ContractSandboxBackend,
  Session as ContractSessionSchema,
  SessionEvent as ContractSessionEventSchema,
  SessionEventType as ContractSessionEventType,
  SessionStatus as ContractSessionStatus,
  SessionTurn as ContractSessionTurn,
  ReasoningEffort as ContractReasoningEffort,
} from "@opengeni/contracts";
import type { z } from "zod";
import { SESSION_EVENT_TYPES } from "../src/types";
import type {
  ClientSessionEventInput,
  CreateSessionRequest,
  ReasoningEffort,
  SandboxBackend,
  Session,
  SessionEvent,
  SessionStatus,
  SessionTurn,
  SessionTurnSource,
  SessionTurnStatus,
} from "../src/types";

// The SDK ships hand-written wire types so it carries zero runtime
// dependencies. This suite pins them to `@opengeni/contracts`: if the public
// contracts move, these checks (value-level and type-level) fail the gate.

describe("SDK / contracts parity", () => {
  test("known session event types match the contracts enum exactly", () => {
    expect([...SESSION_EVENT_TYPES].sort()).toEqual([...ContractSessionEventType.options].sort());
  });

  test("session status, sandbox backend, and reasoning effort literals match", () => {
    const statuses: readonly SessionStatus[] = ContractSessionStatus.options;
    const backends: readonly SandboxBackend[] = ContractSandboxBackend.options;
    const efforts: readonly ReasoningEffort[] = ContractReasoningEffort.options;
    expect(statuses).toEqual(ContractSessionStatus.options);
    expect(backends).toEqual(ContractSandboxBackend.options);
    expect(efforts).toEqual(ContractReasoningEffort.options);
  });

  test("contract-parsed payloads are assignable to SDK types (compile-time)", () => {
    // Server -> client shapes: anything the contracts produce, the SDK accepts.
    const acceptSession = (value: z.infer<typeof ContractSessionSchema>): Session => value;
    const acceptEvent = (value: z.infer<typeof ContractSessionEventSchema>): SessionEvent => value;
    const acceptTurn = (value: z.infer<typeof ContractSessionTurn>): SessionTurn => value;
    const acceptTurnStatus = (value: z.infer<typeof ContractSessionTurn>["status"]): SessionTurnStatus => value;
    const acceptTurnSource = (value: z.infer<typeof ContractSessionTurn>["source"]): SessionTurnSource => value;
    // Client -> server shapes: anything the SDK sends, the contracts accept.
    // firstPartyMcpPermissions is deliberately `string[]` in the SDK (forward
    // compatible with new server-side permissions), so it is checked at
    // runtime by the server rather than at compile time here.
    const acceptCreateRequest = (
      value: Omit<CreateSessionRequest, "firstPartyMcpPermissions">,
    ): z.input<typeof ContractCreateSessionRequest> => value;
    const acceptClientEvent = (value: ClientSessionEventInput): z.input<typeof ClientSessionEvent> => value;
    const checks = [acceptSession, acceptEvent, acceptTurn, acceptTurnStatus, acceptTurnSource, acceptCreateRequest, acceptClientEvent];
    expect(checks.every((fn) => typeof fn === "function")).toBe(true);
  });

  test("SDK-built control events parse under the contracts schema", () => {
    const message: ClientSessionEventInput = {
      type: "user.message",
      clientEventId: "ce-1",
      payload: { text: "hello", tools: [{ kind: "mcp", id: "documents" }] },
    };
    const interrupt: ClientSessionEventInput = { type: "user.interrupt", payload: { reason: "stop" } };
    const approval: ClientSessionEventInput = {
      type: "user.approvalDecision",
      payload: { approvalId: "ap-1", decision: "approve" },
    };
    for (const event of [message, interrupt, approval]) {
      expect(ClientSessionEvent.safeParse(event).success).toBe(true);
    }
  });

  test("SDK-built create-session requests parse under the contracts schema", () => {
    const request: CreateSessionRequest = {
      initialMessage: "Investigate the failing deploy",
      resources: [{ kind: "repository", uri: "https://github.com/acme/app.git", ref: "main" }],
      tools: [{ kind: "mcp", id: "documents" }],
      metadata: { origin: "sdk-test" },
      sandboxBackend: "none",
      reasoningEffort: "low",
      goal: { text: "Keep deploys green" },
    };
    expect(ContractCreateSessionRequest.safeParse(request).success).toBe(true);
  });
});
