import { describe, expect, test } from "bun:test";
import type {
  BrowserActionCommand,
  BrowserObservation,
  BrowserTarget,
  ComputerNativeCommand,
} from "@opengeni/contracts";
import { BrowserInteractionController, secretFreeCommandDigest } from "../src";

const browserSessionId = "11111111-1111-4111-8111-111111111111";
const controllerGeneration = "controller-1";
const observedAt = "2026-10-12T12:00:00.000Z";
const PASSWORD = "Fake-Login-Alice-Password-1";
const KEY = "secret|path:alice/password||";

function target(): BrowserTarget {
  return {
    id: "target-1",
    browserSessionId,
    controllerGeneration,
    targetGeneration: "target-1",
    documentGeneration: "document-1",
    kind: "page",
    title: "Fixture",
    url: "https://fixture.test/",
    selected: true,
    attached: true,
    createdAt: observedAt,
  };
}

function observation(): BrowserObservation {
  return {
    protocolVersion: 1,
    observationId: "observation-1",
    browserSessionId,
    target: target(),
    frameId: "frame-1",
    semantic: { kind: "snapshot", roots: [], nodeCount: 0 },
    screenshot: null,
    focusedRef: null,
    changedRegions: [],
    diagnostics: {
      consoleErrorCount: 0,
      failedRequestCount: 0,
      downloadCount: 0,
      pageErrorCount: 0,
    },
    dialog: null,
    observedAt,
  };
}

function command(secretValues?: Record<string, string>): BrowserActionCommand {
  return {
    protocolVersion: 1,
    operationId: "22222222-2222-4222-8222-000000000001",
    browserSessionId,
    controllerGeneration,
    targetId: "target-1",
    expectedTargetGeneration: "target-1",
    expectedDocumentGeneration: "document-1",
    expectedFrameId: "frame-1",
    actor: { kind: "agent", subjectId: "agent:fixture" },
    action: { type: "fill", locator: { kind: "ref", ref: "e1" }, value: "{{secret:alice}}" },
    ...(secretValues ? { secretValues } : {}),
  };
}

describe("controller-private secret values", () => {
  test("the digest ignores the side map and nothing else", () => {
    const withValues = command({ [KEY]: PASSWORD });
    const without = command();
    expect(secretFreeCommandDigest(withValues)).toBe(secretFreeCommandDigest(without));
    expect(secretFreeCommandDigest(command({ [KEY]: "other" }))).toBe(
      secretFreeCommandDigest(without),
    );
    expect(
      secretFreeCommandDigest({ ...without, action: { ...without.action, value: "x" } } as object),
    ).not.toBe(secretFreeCommandDigest(without));
    const native: ComputerNativeCommand = {
      operationId: "22222222-2222-4222-8222-000000000002",
      tool: "type_text",
      arguments: { text: "{{secret:alice}}" },
      protocolVersion: 1,
      computerSessionId: browserSessionId,
      controllerGeneration,
      targetId: null,
      actor: { kind: "agent", subjectId: "agent:fixture" },
    };
    expect(secretFreeCommandDigest({ ...native, secretValues: { [KEY]: PASSWORD } })).toBe(
      secretFreeCommandDigest(native),
    );
  });

  test("the driver receives values; the journal and receipt never do; replays stay idempotent", async () => {
    const records: unknown[] = [];
    const seen: Array<Record<string, string> | undefined> = [];
    const controller = new BrowserInteractionController({
      browserSessionId,
      controllerGeneration,
      onJournalRecord(record) {
        records.push(structuredClone(record));
      },
      driver: {
        async target() {
          return target();
        },
        async observe() {
          return observation();
        },
        async dispatch(dispatched) {
          seen.push(dispatched.secretValues);
          return observation();
        },
      },
    });
    const receipt = await controller.run(command({ [KEY]: PASSWORD }));
    await controller.waitForIdle();
    expect(receipt.state).toBe("completed");
    expect(seen).toEqual([{ [KEY]: PASSWORD }]);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(JSON.stringify(record)).not.toContain(PASSWORD);
      expect((record as { commandDigest: string }).commandDigest).toBe(
        secretFreeCommandDigest(command()),
      );
    }
    expect(JSON.stringify(receipt)).not.toContain(PASSWORD);
    expect(JSON.stringify(controller.journalSnapshot())).not.toContain(PASSWORD);
    // A retry with a fresh value (a new TOTP code) is the same operation.
    expect(await controller.run(command({ [KEY]: "fresh-value" }))).toEqual(receipt);
    expect(seen).toHaveLength(1);
  });
});
