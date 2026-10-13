import { describe, expect, mock, test } from "bun:test";
import type { MachineView } from "@opengeni/react/machines";

import { moveChatToMachine } from "./move-chat-to-machine";
import { personalMachineUseIntent } from "./personal-resource-attachments";

const machine = (overrides: Partial<MachineView> = {}): MachineView =>
  ({
    sandboxId: "mac",
    enrollmentId: "enrollment-mac",
    scope: "user",
    name: "Studio Mac",
    kind: "selfhosted",
    state: "online",
    active: false,
    isSessionGroup: false,
    ...overrides,
  }) as MachineView;

const consent = personalMachineUseIntent({ visibility: "workspace", authorityEpoch: 4 });

describe("personalMachineUseIntent", () => {
  test("is session-long consent bound to the chat's authority epoch", () => {
    expect(consent).toEqual({
      mode: "session",
      expectedAuthorityEpoch: 4,
      workspaceSharedAcknowledged: true,
      sharedOutputWarningVersion: 1,
    });
    expect(personalMachineUseIntent({ visibility: "private", authorityEpoch: 2 })).toEqual({
      mode: "session",
      expectedAuthorityEpoch: 2,
      workspaceSharedAcknowledged: false,
      sharedOutputWarningVersion: 1,
    });
  });

  test("is absent when the chat's authority is unknown", () => {
    expect(personalMachineUseIntent(undefined)).toBeUndefined();
  });
});

describe("moveChatToMachine (Runs on and the machine card)", () => {
  const chat = { blocked: null, awaitingHuman: false, personalMachineIntent: consent, extras: {} };

  test("choosing my own machine mid-chat moves the chat and approves it in one step", async () => {
    const order: string[] = [];
    const attach = mock(async () => {
      order.push("attach");
      return true;
    });
    const sendMessage = mock(async (_message: Record<string, unknown>) => {
      order.push("send");
      return { payload: { routing: "accepted_for_execution" } };
    });
    const result = await moveChatToMachine({
      machine: machine(),
      chat,
      canMessage: true,
      attach,
      sendMessage,
    });
    expect(result).toEqual({ moved: true, text: "This chat now runs on Studio Mac." });
    // The consent is derived from the chat's active machine, so it must follow
    // the move rather than precede it.
    expect(order).toEqual(["attach", "send"]);
    expect(sendMessage.mock.calls[0]![0]).toMatchObject({
      text: "Use the machine “Studio Mac” for this chat.",
      personalResourceAttachment: consent,
    });
  });

  test("a refused move sends nothing", async () => {
    const sendMessage = mock(async () => ({}));
    const result = await moveChatToMachine({
      machine: machine(),
      chat,
      canMessage: true,
      attach: async () => false,
      sendMessage,
    });
    expect(result).toEqual({ moved: false, reason: null });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("a chat that can't take input is not moved", async () => {
    const attach = mock(async () => true);
    const result = await moveChatToMachine({
      machine: machine(),
      chat: { ...chat, blocked: "This chat has ended." },
      canMessage: true,
      attach,
      sendMessage: async () => ({}),
    });
    expect(result).toEqual({ moved: false, reason: "This chat has ended." });
    expect(attach).not.toHaveBeenCalled();
  });

  test("a workspace machine is moved without personal consent", async () => {
    const sendMessage = mock(async (_message: Record<string, unknown>) => ({}));
    await moveChatToMachine({
      machine: machine({ scope: "workspace" }),
      chat,
      canMessage: true,
      attach: async () => true,
      sendMessage,
    });
    expect(sendMessage.mock.calls[0]![0].personalResourceAttachment).toBeUndefined();
  });

  test("my machine is not attached while the chat waits on an answer", async () => {
    const attach = mock(async () => true);
    const result = await moveChatToMachine({
      machine: machine(),
      chat: { ...chat, awaitingHuman: true },
      canMessage: true,
      attach,
      sendMessage: async () => ({}),
    });
    expect(result).toEqual({
      moved: false,
      reason: "Answer the question above first, then move this chat to Studio Mac.",
    });
    expect(attach).not.toHaveBeenCalled();
  });

  test("my machine is not attached when the chat's authority is unknown", async () => {
    const attach = mock(async () => true);
    const result = await moveChatToMachine({
      machine: machine(),
      chat: { ...chat, personalMachineIntent: undefined },
      canMessage: true,
      attach,
      sendMessage: async () => ({}),
    });
    expect(result.moved).toBe(false);
    expect(attach).not.toHaveBeenCalled();
  });

  test("a failed consent message moves the chat back", async () => {
    const attach = mock(async (_sandboxId: string) => true);
    const result = await moveChatToMachine({
      machine: machine(),
      chat,
      canMessage: true,
      previousSandboxId: "home",
      attach,
      sendMessage: async () => {
        throw new Error("network");
      },
    });
    expect(attach.mock.calls.map((call) => call[0])).toEqual(["mac", "home"]);
    expect(result).toEqual({
      moved: false,
      reason: "Couldn't approve Studio Mac for this chat, so it stayed where it was. Try again.",
    });
  });
});
