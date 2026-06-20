import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_DESCRIPTORS,
  ClientSessionEvent,
  CreateSessionRequest as ContractCreateSessionRequest,
  DESKTOP_STREAM_PORT,
  SandboxBackend as ContractSandboxBackend,
  Session as ContractSessionSchema,
  SessionEvent as ContractSessionEventSchema,
  SessionEventType as ContractSessionEventType,
  SessionStatus as ContractSessionStatus,
  SessionTurn as ContractSessionTurn,
  ReasoningEffort as ContractReasoningEffort,
  ScheduledTask as ContractScheduledTask,
  ScheduledTaskOverlapPolicy as ContractScheduledTaskOverlapPolicy,
  ScheduledTaskRunMode as ContractScheduledTaskRunMode,
  ScheduledTaskStatus as ContractScheduledTaskStatus,
} from "@opengeni/contracts";
import { SandboxBackend as DeploymentSandboxBackend } from "@opengeni/deployment";
import type { z } from "zod";
import { SESSION_EVENT_TYPES } from "../src/types";
import type {
  ClientSessionEventInput,
  CreateSessionRequest,
  ReasoningEffort,
  SandboxBackend,
  ScheduledTask,
  ScheduledTaskOverlapPolicy,
  ScheduledTaskRunMode,
  ScheduledTaskStatus,
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

  test("sandbox backend enum is 3-way parity across contracts / sdk / deployment", () => {
    // The SDK ships a hand-written `SandboxBackend` type (no runtime array), so
    // we pin a runtime literal list to that type: TS rejects this assignment if
    // any value drifts from the SDK type, and the sorted-equality below pins it
    // to the two runtime Zod enums. All three sources must agree.
    const sdkBackends: readonly SandboxBackend[] = [
      "docker",
      "modal",
      "local",
      "none",
      "daytona",
      "runloop",
      "e2b",
      "blaxel",
      "cloudflare",
      "vercel",
    ];
    const contracts = [...ContractSandboxBackend.options].sort();
    const deployment = [...DeploymentSandboxBackend.options].sort();
    const sdk = [...sdkBackends].sort();
    expect(contracts).toEqual(deployment);
    expect(contracts).toEqual(sdk);
    expect(contracts).toHaveLength(10);
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

  test("scheduled task literals and shapes match the contracts", () => {
    const statuses: readonly ScheduledTaskStatus[] = ContractScheduledTaskStatus.options;
    const runModes: readonly ScheduledTaskRunMode[] = ContractScheduledTaskRunMode.options;
    const overlapPolicies: readonly ScheduledTaskOverlapPolicy[] = ContractScheduledTaskOverlapPolicy.options;
    expect(statuses).toEqual(ContractScheduledTaskStatus.options);
    expect(runModes).toEqual(ContractScheduledTaskRunMode.options);
    expect(overlapPolicies).toEqual(ContractScheduledTaskOverlapPolicy.options);
    // Server -> client: anything the contract produces, the SDK type accepts.
    const acceptScheduledTask = (value: z.infer<typeof ContractScheduledTask>): ScheduledTask => value;
    expect(typeof acceptScheduledTask).toBe("function");
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

  test("every sandbox backend has a capability descriptor row keyed by itself", () => {
    const backends = [...ContractSandboxBackend.options].sort();
    const descriptorKeys = Object.keys(CAPABILITY_DESCRIPTORS).sort();
    expect(descriptorKeys).toEqual(backends);
    for (const backend of ContractSandboxBackend.options) {
      const descriptor = CAPABILITY_DESCRIPTORS[backend];
      expect(descriptor).toBeDefined();
      // The record key and the `backend` field agree. backendId is pinned to the
      // SDK client's actual backendId (asserted against the real clients in
      // packages/runtime — P0.3): it == the enum key for every backend except
      // local, whose UnixLocalSandboxClient reports "unix_local".
      expect(descriptor.backend).toBe(backend);
      expect(descriptor.backendId).toBe(backend === "local" ? "unix_local" : backend);
    }
  });

  test("descriptor invariants: Recording feasibility, OS, and the 6080 desktop port", () => {
    for (const backend of ContractSandboxBackend.options) {
      const descriptor = CAPABILITY_DESCRIPTORS[backend];
      const desktopCapable = descriptor.capabilities.DesktopStream.available;
      const isLinux = descriptor.os.default === "linux" && descriptor.os.supported.includes("linux");

      // Recording feasibility == DesktopStream.available && os==linux (x11grab
      // is X11-only). In v1 every reachable cell is Linux, so this reduces to
      // Recording.available === DesktopStream.available.
      expect(descriptor.capabilities.Recording.available).toBe(desktopCapable && isLinux);

      if (desktopCapable) {
        // Desktop-capable backends are Linux in v1 and must carry a real VNC
        // transport (never null).
        expect(isLinux).toBe(true);
        expect(descriptor.capabilities.DesktopStream.transport).not.toBeNull();
        // 6080 is the websockify/noVNC port; it is merged into exposedPorts by
        // createSandboxClient (P0.3). The descriptor must reserve the canonical
        // port constant for every desktop-capable (backend, os).
        expect(DESKTOP_STREAM_PORT).toBe(6080);
      } else {
        // Non-desktop backends never advertise a DesktopStream transport and
        // are never recording-capable.
        expect(descriptor.capabilities.DesktopStream.transport).toBeNull();
        expect(descriptor.capabilities.Recording.available).toBe(false);
      }
    }
  });
});
