import { describe, expect, test } from "bun:test";
import {
  canonicalizeWorkspaceLearningSourceOverrides,
  resolveWorkspaceLearningPolicyEffectiveMode,
  type WorkspaceLearningPolicySnapshot,
} from "../src/workspace-learning-policy";

const HASH = "a".repeat(64);

function snapshot(overrides: WorkspaceLearningPolicySnapshot["sourceOverrides"] = []) {
  return {
    id: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    executionGeneration: 1,
    revision: { id: crypto.randomUUID(), revision: 4, policyHash: HASH },
    activationVersion: 3,
    activatedAt: new Date().toISOString(),
    workspaceMode: "suggest" as const,
    sourceOverrides: overrides,
    snapshotHash: HASH,
    createdAt: new Date().toISOString(),
  } satisfies WorkspaceLearningPolicySnapshot;
}

describe("workspace learning-policy contracts", () => {
  test("canonicalizes sparse overrides and never persists inherit", () => {
    expect(
      canonicalizeWorkspaceLearningSourceOverrides([
        { kind: " Slack Channel ", id: "C02", mode: "automatic" },
        { kind: "google-drive", id: "folder:1", mode: "inherit" },
        { kind: "slack-channel", id: "C01", mode: "off" },
      ]),
    ).toEqual([
      { kind: "slack-channel", id: "C01", mode: "off" },
      { kind: "slack-channel", id: "C02", mode: "automatic" },
    ]);
  });

  test("rejects duplicate source identities instead of applying order-dependent overrides", () => {
    expect(() =>
      canonicalizeWorkspaceLearningSourceOverrides([
        { kind: "slack-channel", id: "C01", mode: "off" },
        { kind: "Slack Channel", id: "C01", mode: "automatic" },
      ]),
    ).toThrow(/duplicate workspace learning source override/i);
  });

  test("resolves exact source overrides and otherwise inherits the workspace mode", () => {
    const accepted = snapshot([
      { kind: "slack-channel", id: "C01", mode: "off" },
      { kind: "google-drive", id: "folder:1", mode: "automatic" },
    ]);
    expect(
      resolveWorkspaceLearningPolicyEffectiveMode(accepted, {
        kind: "slack-channel",
        id: "C01",
      }),
    ).toMatchObject({ mode: "off", inherited: false, policyRevision: accepted.revision });
    expect(
      resolveWorkspaceLearningPolicyEffectiveMode(accepted, {
        kind: "meeting-transcript",
        id: "meeting:1",
      }),
    ).toMatchObject({ mode: "suggest", inherited: true, policyRevision: accepted.revision });
  });
});
