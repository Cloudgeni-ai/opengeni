import { expect, test } from "bun:test";
import {
  initialNativeBrokerOutput,
  planNativeBrokerOutputCapture,
  type NativeBrokerOutputLookup,
  type NativeBrokerOutputPage,
  type NativeBrokerOutputPlan,
  type NativeBrokerOutputSnapshot,
} from "../src/sandbox/providers/native-command-broker-output";
import {
  encodeNativeBrokerFrame,
  type NativeBrokerFrame,
} from "../src/sandbox/providers/native-command-broker-wire";

const brokerId = "18b5623a-1b82-4d0f-937c-9f494bf01d23";
const requestId = "38b5623a-1b82-4d0f-937c-9f494bf01d23";
const commandId = "28b5623a-1b82-4d0f-937c-9f494bf01d23";
const identity = { brokerId, sandboxId: "sb-test", taskId: "ta-test" };
function frame(sequence: number, options: Partial<NativeBrokerFrame> = {}): string {
  return Buffer.from(
    encodeNativeBrokerFrame({
      direction: "response",
      kind: "stdout",
      brokerId,
      requestId,
      commandId,
      ownerEpoch: 1,
      sequence,
      offset: 0,
      payload: Buffer.from("binary\0\xffdata"),
      ...options,
    } as NativeBrokerFrame),
  ).toString();
}
function page(entryId: string, data = "", eof = false): NativeBrokerOutputPage {
  return {
    sandboxId: identity.sandboxId,
    taskId: identity.taskId,
    requestedFileDescriptor: 1,
    entryId,
    items: [{ fileDescriptor: 1, data }],
    eof,
  };
}
function ledger() {
  const entries = new Map<string, string>(),
    frames = new Map<number, string>();
  const lookup: NativeBrokerOutputLookup = {
    entrySha256: async (id) => entries.get(id) ?? null,
    frameSha256: async (sequence) => frames.get(sequence) ?? null,
  };
  return {
    lookup,
    entries,
    frames,
    commit(plan: NativeBrokerOutputPlan) {
      if (plan.page) entries.set(plan.page.entryId, plan.page.sha256);
      for (const item of plan.frames) frames.set(item.sequence, item.sha256);
      return structuredClone(plan.snapshot);
    },
  };
}

test("complete page, all commands and framing suffix are one capture plan", async () => {
  const store = ledger();
  const initial = initialNativeBrokerOutput(identity);
  const next = frame(3);
  const plan = await planNativeBrokerOutputCapture(
    initial,
    "0-0",
    page("1-0", frame(1) + frame(2, { commandId: requestId, kind: "stderr" }) + next.slice(0, 42)),
    store.lookup,
  );
  expect(plan.frames.map((item) => item.sequence)).toEqual([1, 2]);
  expect(plan.frames[1]!.frame.commandId).toBe(requestId);
  expect(plan.snapshot.cursor).toBe("1-0");
  expect(Buffer.from(plan.snapshot.partialBase64, "base64").toString()).toBe(next.slice(0, 42));
  expect(initial.cursor).toBe("0-0");
  expect(initial.lastSequence).toBe(0);
  expect(store.entries.size).toBe(0);
  const committed = store.commit(plan);
  const completed = await planNativeBrokerOutputCapture(
    committed,
    "1-0",
    page("2-0", next.slice(42)),
    store.lookup,
  );
  expect(completed.frames[0]!.sequence).toBe(3);
  expect(completed.snapshot.partialBase64).toBe("");
});

test("every split persists its partial prefix and reconnect completes the same frame", async () => {
  const wire = frame(1);
  for (let split = 0; split <= wire.length; split++) {
    const store = ledger();
    const first = await planNativeBrokerOutputCapture(
      initialNativeBrokerOutput(identity),
      "0-0",
      page("1-0", wire.slice(0, split)),
      store.lookup,
    );
    const restored = JSON.parse(JSON.stringify(store.commit(first)));
    const second = await planNativeBrokerOutputCapture(
      restored,
      "1-0",
      page("2-0", wire.slice(split), true),
      store.lookup,
    );
    expect([...first.frames, ...second.frames].map((item) => item.sequence)).toEqual([1]);
    expect(second.snapshot.partialBase64).toBe("");
  }
});

test("uncommitted capture replay produces the same plan without advancing anything", async () => {
  const store = ledger();
  const initial = initialNativeBrokerOutput(identity);
  const first = await planNativeBrokerOutputCapture(
    initial,
    "0-0",
    page("1-0", frame(1)),
    store.lookup,
  );
  const retry = await planNativeBrokerOutputCapture(
    initial,
    "0-0",
    page("1-0", frame(1)),
    store.lookup,
  );
  expect(retry).toEqual(first);
  expect(store.frames.size).toBe(0);
});

test("identical current-page replay is a no-op, but conflicting and older pages reject", async () => {
  const store = ledger();
  const original = page("1-0", frame(1));
  const first = await planNativeBrokerOutputCapture(
    initialNativeBrokerOutput(identity),
    "0-0",
    original,
    store.lookup,
  );
  const state = store.commit(first);
  const duplicate = await planNativeBrokerOutputCapture(state, "1-0", original, store.lookup);
  expect(duplicate.frames).toEqual([]);
  expect(duplicate.page).toBeNull();
  expect(duplicate.snapshot).toEqual(state);
  await expect(
    planNativeBrokerOutputCapture(
      state,
      "1-0",
      page("1-0", frame(1, { payload: Buffer.from("substitution") })),
      store.lookup,
    ),
  ).rejects.toThrow();
  const second = store.commit(
    await planNativeBrokerOutputCapture(state, "1-0", page("2-0", frame(2)), store.lookup),
  );
  await expect(
    planNativeBrokerOutputCapture(second, "2-0", original, store.lookup),
  ).rejects.toThrow();
});

test("broker replay in a new provider page needs exact immutable frame evidence", async () => {
  const store = ledger();
  const state = store.commit(
    await planNativeBrokerOutputCapture(
      initialNativeBrokerOutput(identity),
      "0-0",
      page("1-0", frame(1) + frame(2)),
      store.lookup,
    ),
  );
  const replay = await planNativeBrokerOutputCapture(
    state,
    "1-0",
    page("2-0", frame(1) + frame(2) + frame(3) + frame(3)),
    store.lookup,
  );
  expect(replay.duplicateSequences).toEqual([1, 2, 3]);
  expect(replay.frames.map((item) => item.sequence)).toEqual([3]);
  await expect(
    planNativeBrokerOutputCapture(state, "1-0", page("2-0", frame(1, { offset: 7 })), store.lookup),
  ).rejects.toThrow();
  store.frames.delete(1);
  await expect(
    planNativeBrokerOutputCapture(state, "1-0", page("2-0", frame(1)), store.lookup),
  ).rejects.toThrow();
});

test("provider EOF is distinct from command EOF, exit and quiescence", async () => {
  const store = ledger();
  const plan = await planNativeBrokerOutputCapture(
    initialNativeBrokerOutput(identity),
    "0-0",
    page("1-0", frame(1), true),
    store.lookup,
  );
  expect(plan.snapshot.providerEof).toBe(true);
  expect(plan.frames[0]!.frame.kind).toBe("stdout");
  expect(Object.keys(plan.snapshot)).not.toContain("commandExitCode");
  expect(Object.keys(plan.snapshot)).not.toContain("receipt");
  const state = store.commit(plan);
  await expect(
    planNativeBrokerOutputCapture(state, "1-0", page("2-0", frame(2)), store.lookup),
  ).rejects.toThrow();
  await expect(
    planNativeBrokerOutputCapture(
      initialNativeBrokerOutput(identity),
      "0-0",
      page("1-0", frame(1).slice(0, -1), true),
      store.lookup,
    ),
  ).rejects.toThrow();
});

test("all initial stderr, missing identity, foreign scope and stale requested cursors reject", async () => {
  const initial = initialNativeBrokerOutput(identity);
  const store = ledger();
  for (const input of [
    { ...page("1-0", frame(1)), taskId: "ta-foreign" },
    { ...page("1-0", frame(1)), sandboxId: "sb-foreign" },
    { ...page("1-0", frame(1)), taskId: "" },
    { ...page("", "", true), requestedFileDescriptor: 2, items: [] },
    { ...page("1-0"), items: [{ fileDescriptor: 2, data: frame(1) }] },
    { ...page("1-0"), items: [{ fileDescriptor: 0, data: frame(1) }] },
    page("1-0", frame(1, { direction: "request", kind: "stdin" } as Partial<NativeBrokerFrame>)),
    page("1-0", frame(2)),
    page("1-0", frame(1, { brokerId: commandId })),
  ])
    await expect(
      planNativeBrokerOutputCapture(initial, "0-0", input as NativeBrokerOutputPage, store.lookup),
    ).rejects.toThrow();
  await expect(
    planNativeBrokerOutputCapture(initial, "wrong", page("1-0", frame(1)), store.lookup),
  ).rejects.toThrow();
});

test("cursor-less heartbeat cannot smuggle bytes, and genuine cursor-less EOF is retained separately", async () => {
  const initial = initialNativeBrokerOutput(identity),
    store = ledger();
  const heartbeat = await planNativeBrokerOutputCapture(initial, "0-0", page(""), store.lookup);
  expect(heartbeat.snapshot).toEqual(initial);
  expect(heartbeat.page).toBeNull();
  await expect(
    planNativeBrokerOutputCapture(initial, "0-0", page("", frame(1)), store.lookup),
  ).rejects.toThrow();
  const eof = await planNativeBrokerOutputCapture(initial, "0-0", page("", "", true), store.lookup);
  expect(eof.snapshot.providerEof).toBe(true);
  expect(eof.snapshot.cursor).toBe("0-0");
  expect(eof.page).toBeNull();
  expect(eof.eofObservationSha256).not.toBeNull();
  const duplicate = await planNativeBrokerOutputCapture(
    eof.snapshot,
    "0-0",
    page("", "", true),
    store.lookup,
  );
  expect(duplicate.snapshot).toEqual(eof.snapshot);
  expect(duplicate.eofObservationSha256).toBeNull();
  const actualProviderEof = { ...page("", "", true), items: [] };
  const actual = await planNativeBrokerOutputCapture(
    initial,
    "0-0",
    actualProviderEof,
    store.lookup,
  );
  expect(actual.snapshot.providerEof).toBe(true);
  expect(actual.frames).toEqual([]);
  const empty = await planNativeBrokerOutputCapture(initial, "0-0", page("1-0"), store.lookup);
  expect(empty.snapshot.cursor).toBe("1-0");
  expect(empty.page).not.toBeNull();
});

test("bounded large pages preserve all frames across decoder chunk boundaries", async () => {
  const store = ledger();
  const data = Array.from({ length: 90 }, (_, i) =>
    frame(i + 1, { payload: Buffer.alloc(8192, i) }),
  ).join("");
  const plan = await planNativeBrokerOutputCapture(
    initialNativeBrokerOutput(identity),
    "0-0",
    page("1-0", data),
    store.lookup,
  );
  expect(plan.frames.length).toBe(90);
  expect(plan.snapshot.lastSequence).toBe(90);
  expect(plan.frames[89]!.frame.payload).toEqual(Buffer.alloc(8192, 89));
  await expect(
    planNativeBrokerOutputCapture(
      initialNativeBrokerOutput(identity),
      "0-0",
      page("1-0", data + data),
      store.lookup,
    ),
  ).rejects.toThrow();
});

test("malformed saved suffix or non-atomic prior inbox state cannot be skipped", async () => {
  const initial = initialNativeBrokerOutput(identity),
    store = ledger();
  for (const patch of [
    { partialBase64: "%%%" },
    { partialBase64: Buffer.from("prefix").toString("base64") },
    { lastSequence: 1 },
    { providerEof: true },
    { cursor: "1-0" },
    { unexpected: true },
    { revision: -1 },
  ])
    await expect(
      planNativeBrokerOutputCapture(
        { ...initial, ...patch } as NativeBrokerOutputSnapshot,
        (patch as Partial<NativeBrokerOutputSnapshot>).cursor ?? "0-0",
        page("2-0", frame(1)),
        store.lookup,
      ),
    ).rejects.toThrow();
  store.frames.set(1, "0".repeat(64));
  await expect(
    planNativeBrokerOutputCapture(initial, "0-0", page("1-0", frame(1)), store.lookup),
  ).rejects.toThrow();
});

test("failed page parsing returns no partial plan and does not mutate the saved cursor", async () => {
  const initial = initialNativeBrokerOutput(identity),
    store = ledger();
  await expect(
    planNativeBrokerOutputCapture(
      initial,
      "0-0",
      page("1-0", frame(1) + "not-a-frame\n"),
      store.lookup,
    ),
  ).rejects.toThrow();
  expect(initial).toEqual(initialNativeBrokerOutput(identity));
  expect(store.frames.size).toBe(0);
  expect(store.entries.size).toBe(0);
});
