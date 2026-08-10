import { describe, expect, test } from "bun:test";
import {
  DURABLE_LEARNING_INPUT_MAX_UTF8_BYTES,
  DurableLearningWriteRequest,
  canonicalDurableLearningInput,
} from "../src";

const authority = {
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003",
  turnId: "00000000-0000-4000-8000-000000000004",
  attemptId: "00000000-0000-4000-8000-000000000005",
  executionGeneration: 1,
};

describe("durable-learning contracts", () => {
  test("accepts only explicit confirmed writes for the three canonical authorities", () => {
    const company = DurableLearningWriteRequest.parse({
      operationId: "00000000-0000-4000-8000-000000000011",
      authority,
      confirmation: { state: "confirmed" },
      activation: "active",
      subject: {
        kind: "company_goal",
        stableKey: "reliable-recovery",
        content: "Ship reliable recovery.",
      },
    });
    expect(company.subject).toMatchObject({
      kind: "company_goal",
      stableKey: "reliable-recovery",
    });

    const instruction = DurableLearningWriteRequest.parse({
      operationId: "00000000-0000-4000-8000-000000000012",
      authority,
      confirmation: { state: "confirmed" },
      activation: "proposal",
      subject: {
        kind: "workspace_instruction",
        target: { kind: "policy", scope: "role", roleKey: "support" },
        content: "Escalate account recovery requests.",
      },
    });
    expect(instruction.subject.kind).toBe("workspace_instruction");

    const preference = DurableLearningWriteRequest.parse({
      operationId: "00000000-0000-4000-8000-000000000013",
      authority,
      confirmation: { state: "confirmed" },
      activation: "active",
      subject: {
        kind: "preference",
        action: "create",
        scope: "user",
        stableKey: "  Concise Responses  ",
        title: "Concise responses",
        description: "Prefer concise status updates.",
        content: "Keep routine status updates concise.",
      },
    });
    expect(preference.subject).toMatchObject({
      kind: "preference",
      scope: "user",
      stableKey: "concise-responses",
    });
  });

  test("rejects implicit confirmation and invalid authority-specific shapes", () => {
    expect(() =>
      DurableLearningWriteRequest.parse({
        operationId: "00000000-0000-4000-8000-000000000021",
        authority,
        activation: "active",
        subject: { kind: "company_mission", stableKey: null, content: "A mission." },
      }),
    ).toThrow();
    expect(() =>
      DurableLearningWriteRequest.parse({
        operationId: "00000000-0000-4000-8000-000000000022",
        authority,
        confirmation: { state: "confirmed" },
        activation: "active",
        subject: {
          kind: "company_mission",
          stableKey: "missions-are-scalar",
          content: "A mission.",
        },
      }),
    ).toThrow("scalar company-profile subjects must not have a stable key");
    expect(() =>
      DurableLearningWriteRequest.parse({
        operationId: "00000000-0000-4000-8000-000000000023",
        authority,
        confirmation: { state: "confirmed" },
        activation: "proposal",
        subject: {
          kind: "preference",
          action: "correct",
          scope: "workspace",
          preferenceId: "00000000-0000-4000-8000-000000000024",
          expectedCurrentRevisionId: "00000000-0000-4000-8000-000000000025",
          expectedScopeVersion: 1,
          title: "Correction",
          description: "Correct an active preference.",
          content: "Corrected content.",
          reason: "Confirmed correction",
        },
      }),
    ).toThrow("preference corrections must use active authority");
  });

  test("canonicalizes recursively and enforces the immutable ledger byte bound", () => {
    const left = canonicalDurableLearningInput({
      request: { z: [3, { b: 2, a: 1 }], a: true },
      authority: { workspaceId: authority.workspaceId, accountId: authority.accountId },
    });
    const right = canonicalDurableLearningInput({
      authority: { accountId: authority.accountId, workspaceId: authority.workspaceId },
      request: { a: true, z: [3, { a: 1, b: 2 }] },
    });
    expect(left).toBe(right);
    expect(new TextEncoder().encode(left).byteLength).toBeLessThan(
      DURABLE_LEARNING_INPUT_MAX_UTF8_BYTES,
    );
    expect(() =>
      canonicalDurableLearningInput({ content: "x".repeat(DURABLE_LEARNING_INPUT_MAX_UTF8_BYTES) }),
    ).toThrow("UTF-8 bytes");
  });
});
