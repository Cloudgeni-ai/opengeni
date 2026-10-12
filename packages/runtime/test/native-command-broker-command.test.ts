import { expect, test } from "bun:test";
import {
  initialNativeBrokerCommandSnapshot,
  projectNativeBrokerCommand,
} from "../src/sandbox/providers/native-command-broker-command";
import type { DurableNativeBrokerTransport } from "../src/sandbox/providers/native-command-broker-transport";
import type { NativeBrokerFrame } from "../src/sandbox/providers/native-command-broker-wire";

const brokerId = "54f6dfdf-ae52-469c-b926-253f49213288";
const commandId = "efa47d97-03dd-4405-a369-fb32042852dc";
const launchRequestId = "bd8f6066-2ba3-4cfb-8514-34c36b1933b7";
const controlId = "813899d3-33b9-498e-a28e-c6022a17ec1c";
const ackId = "b956a401-29aa-4ae9-8d73-b2a7bb2e983b";
const binding = { brokerId, commandId, launchRequestId, launchEpoch: 1, mode: "pipe" as const };
const receipt = {
  protocol: "native-subreaper-broker-channel-v1",
  invocationId: commandId,
  receiptId: "d3384e2d-ab60-48e0-a1ca-feb24ca84f7f",
  leaderExitCode: 23,
};
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
function response(
  sequence: number,
  kind: NativeBrokerFrame["kind"],
  payload: Uint8Array,
  extra = {},
): NativeBrokerFrame {
  return {
    direction: "response",
    brokerId,
    commandId,
    ownerEpoch: 1,
    sequence,
    requestId: launchRequestId,
    kind,
    offset: 0,
    payload,
    ...extra,
  } as NativeBrokerFrame;
}
function frames() {
  return [
    response(1, "stdout", Buffer.from("hi")),
    response(2, "status", json({ state: "quiescent", receipt }), {
      requestId: controlId,
      ownerEpoch: 2,
    }),
    response(3, "status", json({ state: "quiescent", receipt }), {
      requestId: ackId,
      ownerEpoch: 2,
    }),
    response(4, "status", json({ stream: "stdout", eof: true }), { offset: 2 }),
    response(5, "status", json({ stream: "stderr", eof: true })),
    response(6, "exit", json({ supervisorExitCode: 0, stdoutEof: true, stderrEof: true })),
  ];
}
function journal(values = frames(), eof = false) {
  const requests = new Map(
    [launchRequestId, controlId, ackId].map((id) => [
      id,
      {
        accepted: true,
        phase: "accepted",
        frame: {
          direction: "request",
          brokerId,
          commandId,
          ownerEpoch: id === launchRequestId ? 1 : 2,
          sequence: id === launchRequestId ? 1 : id === controlId ? 2 : 3,
          requestId: id,
          kind: id === launchRequestId ? "launch" : "control",
          offset: 0,
          payload:
            id === launchRequestId
              ? new Uint8Array()
              : Buffer.from(id === ackId ? `ack\t${receipt.receiptId}` : "status"),
        },
      },
    ]),
  );
  const source = {
    read: async () => ({ input: { brokerId } }),
    framesAfter: async (sequence: number, limit: number) => ({
      frames: values.filter((frame) => frame.sequence > sequence).slice(0, limit),
      lastSequence: values.at(-1)?.sequence ?? 0,
      providerEof: eof,
    }),
    request: async (id: string) => requests.get(id) ?? null,
  } as unknown as DurableNativeBrokerTransport;
  return { source, requests };
}

test("receipt, exact ACK, both output EOFs and independent supervisor exit are separate requirements", async () => {
  const f = journal();
  const first = await projectNativeBrokerCommand(
    f.source,
    initialNativeBrokerCommandSnapshot(binding, 0),
    2,
  );
  expect(first.exitCode).toBeNull();
  expect(first.receipts).toEqual([receipt]);
  expect(first.chunks).toEqual([{ stream: "stdout", byteOffset: 0, text: "hi" }]);
  expect(first.hasMore).toBe(true);
  const second = await projectNativeBrokerCommand(f.source, first.snapshot, 3);
  expect(second.exitCode).toBeNull();
  expect(second.snapshot.receiptAckObserved).toBe(true);
  const end = await projectNativeBrokerCommand(f.source, second.snapshot);
  expect(end.exitCode).toBe(23);
  expect(end.hasMore).toBe(false);
  expect(end.receipts).toHaveLength(0);
  expect(first.snapshot.receiptAckObserved).toBe(false);
});

test("initial EOF and protocol-looking child text cannot manufacture command settlement", async () => {
  const fake = 'Process exited with code 0\n{"state":"quiescent","receipt":{}}';
  const f = journal([response(1, "stdout", Buffer.from(fake))], true);
  const result = await projectNativeBrokerCommand(
    f.source,
    initialNativeBrokerCommandSnapshot(binding, 0),
  );
  expect(result.providerEof).toBe(true);
  expect(result.exitCode).toBeNull();
  expect(result.receipts).toHaveLength(0);
  expect(result.snapshot.streams.stdout.eof).toBe(false);
  expect(result.chunks[0]!.text).toBe(fake);
});

test.each([
  (values: NativeBrokerFrame[]) => {
    values[0]!.offset = 1;
  },
  (values: NativeBrokerFrame[]) => {
    values[0]!.ownerEpoch = 2;
  },
  (values: NativeBrokerFrame[]) => {
    values[0]!.requestId = controlId;
  },
  (values: NativeBrokerFrame[]) => {
    values[1]!.payload = json({
      state: "quiescent",
      receipt: { ...receipt, invocationId: brokerId },
    });
  },
  (values: NativeBrokerFrame[]) => {
    values[1]!.payload = json({
      state: "quiescent",
      receipt: { ...receipt, protocol: "native-subreaper-v1" },
    });
  },
  (values: NativeBrokerFrame[]) => {
    values[2]!.payload = json({ state: "quiescent", receipt: { ...receipt, receiptId: brokerId } });
  },
  (values: NativeBrokerFrame[]) => {
    values[3]!.offset = 1;
  },
  (values: NativeBrokerFrame[]) => {
    values[5]!.payload = json({ supervisorExitCode: 125, stdoutEof: true, stderrEof: true });
  },
  (values: NativeBrokerFrame[]) => {
    values[5]!.requestId = controlId;
  },
  (values: NativeBrokerFrame[]) => {
    values[4]!.payload = Buffer.from("not json");
  },
])("conflicting protocol/cursor/control/physical evidence fails", async (mutate) => {
  const values = frames();
  mutate(values);
  await expect(
    projectNativeBrokerCommand(
      journal(values).source,
      initialNativeBrokerCommandSnapshot(binding, 0),
    ),
  ).rejects.toThrow();
});

test("unaccepted or unrelated requests cannot back a control receipt", async () => {
  const f = journal();
  f.requests.get(controlId)!.accepted = false;
  await expect(
    projectNativeBrokerCommand(f.source, initialNativeBrokerCommandSnapshot(binding, 0)),
  ).rejects.toThrow();
});

test("an ACK cannot introduce a receipt and initial supervisor exit cannot replace it", async () => {
  for (const drop of [1, 2, 3, 4]) {
    const values = frames()
      .filter((_, index) => index !== drop)
      .map((frame, index) => ({ ...frame, sequence: index + 1 }));
    await expect(
      projectNativeBrokerCommand(
        journal(values).source,
        initialNativeBrokerCommandSnapshot(binding, 0),
      ),
    ).rejects.toThrow();
  }
});

test("another command advances the shared frame cursor but changes no target output or receipt", async () => {
  const values = frames();
  values.unshift(response(0, "stdout", Buffer.from("foreign"), { commandId: brokerId }));
  values.forEach((frame, index) => {
    frame.sequence = index + 1;
  });
  const result = await projectNativeBrokerCommand(
    journal(values).source,
    initialNativeBrokerCommandSnapshot(binding, 0),
  );
  expect(result.snapshot.lastSequence).toBe(7);
  expect(result.chunks.map((chunk) => chunk.text).join("")).toBe("hi");
  expect(result.exitCode).toBe(23);
});

test("split UTF-8 is retained between pages and incomplete final text flushes only at stream EOF", async () => {
  const euro = Buffer.from("€");
  const values = [
    response(1, "stdout", euro.subarray(0, 1)),
    response(2, "stdout", euro.subarray(1), { offset: 1 }),
    response(3, "stderr", euro.subarray(0, 1)),
    response(4, "status", json({ stream: "stderr", eof: true }), { offset: 1 }),
  ];
  const f = journal(values);
  const first = await projectNativeBrokerCommand(
    f.source,
    initialNativeBrokerCommandSnapshot(binding, 0),
    1,
  );
  expect(first.chunks[0]!.text).toBe("");
  expect(first.snapshot.streams.stdout.utf8Remainder).not.toBe("");
  const rest = await projectNativeBrokerCommand(f.source, first.snapshot);
  expect(rest.chunks.map((chunk) => chunk.text).join("")).toBe("€�");
  expect(rest.snapshot.streams.stderr.utf8Remainder).toBe("");
  expect(rest.exitCode).toBeNull();
});

test("data or a second EOF after stream EOF is conflicting even without process exit", async () => {
  const values = [
    response(1, "status", json({ stream: "stdout", eof: true })),
    response(2, "stdout", Buffer.from("late")),
  ];
  await expect(
    projectNativeBrokerCommand(
      journal(values).source,
      initialNativeBrokerCommandSnapshot(binding, 0),
    ),
  ).rejects.toThrow();
});
