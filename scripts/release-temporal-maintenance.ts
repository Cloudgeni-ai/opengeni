#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  Client,
  Connection,
  WorkflowNotFoundError,
  type ScheduleDescription,
} from "@temporalio/client";

type Command = "pause-schedules" | "resume-schedules" | "terminate-session-workflows";

export function maintenanceNote(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
    throw new Error(`unsafe maintenance run id: ${runId}`);
  }
  return `OpenGeni production maintenance ${runId}`;
}

export function scheduleIsOwnedByRun(
  description: Pick<ScheduleDescription, "state">,
  note: string,
): boolean {
  return description.state.paused && description.state.note === note;
}

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (
    command !== "pause-schedules" &&
    command !== "resume-schedules" &&
    command !== "terminate-session-workflows"
  ) {
    throw new Error(
      "command must be pause-schedules, resume-schedules, or terminate-session-workflows",
    );
  }
  const runId = argument("--run-id");
  if (!runId) throw new Error("--run-id is required");
  const note = maintenanceNote(runId);
  const address = process.env.OPENGENI_TEMPORAL_HOST;
  const namespace = process.env.OPENGENI_TEMPORAL_NAMESPACE ?? "default";
  if (!address) throw new Error("OPENGENI_TEMPORAL_HOST is required");

  const connection = await Connection.connect({ address });
  try {
    const client = new Client({ connection, namespace });
    const result =
      command === "terminate-session-workflows"
        ? await terminateSessionWorkflows(client, runId)
        : await controlSchedules(client, command, runId, note);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await connection.close();
  }
}

async function controlSchedules(
  client: Client,
  command: "pause-schedules" | "resume-schedules",
  runId: string,
  note: string,
): Promise<Record<string, unknown>> {
  const scheduleIds: string[] = [];
  for await (const summary of client.schedule.list({ pageSize: 1_000 })) {
    scheduleIds.push(summary.scheduleId);
  }
  scheduleIds.sort();

  const changed: string[] = [];
  const preserved: string[] = [];
  for (const scheduleId of scheduleIds) {
    const handle = client.schedule.getHandle(scheduleId);
    const before = await handle.describe();
    if (command === "pause-schedules") {
      if (!before.state.paused) {
        await handle.pause(note);
        changed.push(scheduleId);
      } else if (scheduleIsOwnedByRun(before, note)) {
        changed.push(scheduleId);
      } else {
        preserved.push(scheduleId);
      }
      const after = await handle.describe();
      if (!after.state.paused) throw new Error(`schedule ${scheduleId} did not pause`);
    } else if (scheduleIsOwnedByRun(before, note)) {
      await handle.unpause(note);
      changed.push(scheduleId);
      const after = await handle.describe();
      if (after.state.paused) throw new Error(`schedule ${scheduleId} did not resume`);
    } else {
      preserved.push(scheduleId);
    }
  }

  return receipt(command, runId, {
    observedCount: scheduleIds.length,
    changedCount: changed.length,
    changedSha256: digestIdentities(changed),
    preservedCount: preserved.length,
    preservedSha256: digestIdentities(preserved),
  });
}

async function terminateSessionWorkflows(
  client: Client,
  runId: string,
): Promise<Record<string, unknown>> {
  const inFlight = new Set<Promise<void>>();
  const hash = createHash("sha256");
  let observedCount = 0;
  let terminatedCount = 0;

  const terminate = async (workflowId: string, executionRunId: string): Promise<void> => {
    try {
      await client.workflow
        .getHandle(workflowId, executionRunId)
        .terminate(`OpenGeni production maintenance ${runId}`);
      terminatedCount += 1;
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
    }
  };

  for await (const execution of client.workflow.list({ query: "ExecutionStatus='Running'" })) {
    if (!execution.workflowId.startsWith("session-")) continue;
    observedCount += 1;
    updateIdentityDigest(hash, `${execution.workflowId}\0${execution.runId}`);
    const running = terminate(execution.workflowId, execution.runId).finally(() => {
      inFlight.delete(running);
    });
    inFlight.add(running);
    if (inFlight.size >= 20) await Promise.race(inFlight);
  }
  await Promise.all(inFlight);

  let remainingCount = 0;
  for await (const execution of client.workflow.list({ query: "ExecutionStatus='Running'" })) {
    if (execution.workflowId.startsWith("session-")) remainingCount += 1;
  }
  if (remainingCount !== 0) {
    throw new Error(`${remainingCount} session workflow executions remain running`);
  }

  return receipt("terminate-session-workflows", runId, {
    observedCount,
    terminatedCount,
    identitySha256: hash.digest("hex"),
    remainingCount,
  });
}

function receipt(command: Command, runId: string, detail: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    command,
    runId,
    completedAt: new Date().toISOString(),
    ...detail,
  };
}

export function digestIdentities(values: string[]): string {
  const hash = createHash("sha256");
  for (const value of values) updateIdentityDigest(hash, value);
  return hash.digest("hex");
}

function updateIdentityDigest(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value);
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) await main();
