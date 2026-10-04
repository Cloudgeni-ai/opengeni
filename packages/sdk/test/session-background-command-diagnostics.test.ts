import { expect, test } from "bun:test";
import {
  SessionBackgroundCommand as ContractCommand,
  SessionBackgroundCommandReconciliation as ContractReconciliation,
} from "@opengeni/contracts";
import type { z } from "zod";
import { OpenGeniClient } from "../src/client";
import type {
  SessionBackgroundCommand,
  SessionBackgroundCommandReconciliation,
} from "../src/index";

const diagnostics: SessionBackgroundCommandReconciliation = {
  lastOutcome: "settlement_failed",
  attempts: 2,
  dueAt: "2030-01-01T01:00:00.000Z",
  claimedAt: null,
  terminalProof: { outcome: "exited", exitCode: 7, observedAt: "2030-01-01T00:00:00.000Z" },
};

test("SDK reconciliation type matches the contract in both directions", () => {
  const contract: z.infer<typeof ContractReconciliation> = diagnostics;
  const sdk: SessionBackgroundCommandReconciliation = ContractReconciliation.parse(contract);
  expect(sdk).toEqual(diagnostics);
  expect(
    ContractReconciliation.safeParse({
      ...diagnostics,
      terminalProof: { ...diagnostics.terminalProof!, exitCode: null },
    }).success,
  ).toBe(false);
  expect(
    ContractReconciliation.safeParse({
      ...diagnostics,
      terminalProof: { ...diagnostics.terminalProof!, outcome: "lost", exitCode: 7 },
    }).success,
  ).toBe(false);
});

test("normal SDK command GET preserves legacy and additive responses without a mutation", async () => {
  const workspaceId = crypto.randomUUID(),
    sessionId = crypto.randomUUID();
  const legacy: SessionBackgroundCommand = {
    id: crypto.randomUUID(),
    workspaceId,
    sessionId,
    provider: "connected_machine",
    state: "stopping",
    commandPreview: "printf fixture",
    cancelRequestedAt: "2030-01-01T00:00:00.000Z",
    exitCode: null,
    settlementReason: null,
    startedAt: "2030-01-01T00:00:00.000Z",
    settledAt: null,
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
  for (const command of [legacy, { ...legacy, reconciliation: diagnostics }]) {
    expect(ContractCommand.parse(command)).toEqual(command);
    const requests: Request[] = [];
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      apiKey: "fixture-key",
      fetch: (async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ commands: [command] });
      }) as typeof fetch,
    });
    const read = await client.listSessionBackgroundCommands(workspaceId, sessionId);
    expect(read.commands[0]).toEqual(command);
    expect(read.commands[0]?.reconciliation).toEqual(command.reconciliation);
    expect(requests.map((r) => ({ method: r.method, pathname: new URL(r.url).pathname }))).toEqual([
      {
        method: "GET",
        pathname: `/v1/workspaces/${workspaceId}/sessions/${sessionId}/background-commands`,
      },
    ]);
  }
});
