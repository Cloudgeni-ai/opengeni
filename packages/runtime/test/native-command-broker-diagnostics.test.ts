import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  inspectNativeBrokerInitialDiagnostics,
  NativeBrokerInitialDiagnosticsError,
  parseNativeBrokerDiagnosticsFault,
  type NativeBrokerDiagnosticsChannel,
  type NativeBrokerDiagnosticsPage,
} from "../src/sandbox/providers/native-command-broker-diagnostics";

const page = (change: Partial<NativeBrokerDiagnosticsPage> = {}): NativeBrokerDiagnosticsPage => ({
  sandboxId: "sb-exact",
  taskId: "ta-exact",
  requestedFileDescriptor: 2,
  entryId: "1-0",
  items: [],
  eof: false,
  ...change,
});
test("retained faults validate the exact canonical page, reason, checksum and physical scope", () => {
  const exactPage = page({ items: [{ fileDescriptor: 2, data: "retained failure" }] });
  const value = JSON.stringify(exactPage);
  const fault = {
    version: 1,
    sandboxId: "sb-exact",
    taskId: "ta-exact",
    reason: "diagnostics",
    page: { value, sha256: createHash("sha256").update(value).digest("hex") },
  };
  expect(parseNativeBrokerDiagnosticsFault(fault, channel([]))).toEqual(fault);
  for (const changed of [
    { sandboxId: "sb-other" },
    { taskId: "ta-other" },
    { page: null },
    { reason: "initial_eof" },
    { reason: "identity_mismatch" },
    { reason: "replay_conflict" },
    { reason: "invalid_page" },
    { reason: "observation_limit" },
    { page: { ...fault.page, sha256: "0".repeat(64) } },
    { page: { ...fault.page, value: value + " " } },
  ])
    expect(() =>
      parseNativeBrokerDiagnosticsFault({ ...fault, ...changed }, channel([])),
    ).toThrow();
  for (const reason of ["invalid_page", "observation_limit"])
    expect(
      parseNativeBrokerDiagnosticsFault({ ...fault, reason, page: null }, channel([])).page,
    ).toBeNull();
});
function channel(pages: NativeBrokerDiagnosticsPage[]): NativeBrokerDiagnosticsChannel {
  return {
    sandboxId: "sb-exact",
    taskId: "ta-exact",
    async *diagnostics(cursor, signal) {
      expect(cursor).toBe("0-0");
      expect(signal).toBeInstanceOf(AbortSignal);
      yield* pages;
    },
  };
}
test("a complete empty query is a bounded clean observation, never command admission", async () => {
  const empty = await inspectNativeBrokerInitialDiagnostics(channel([]));
  expect(empty).toEqual({
    sandboxId: "sb-exact",
    taskId: "ta-exact",
    version: 1,
    requestedCursor: "0-0",
    status: "clean_observation",
    commandAdmission: false,
    pages: [],
  });
  expect(Object.isFrozen(empty)).toBe(true);
  const repeated = await inspectNativeBrokerInitialDiagnostics(channel([page(), page()]));
  expect(repeated.pages).toHaveLength(1);
  expect(repeated.pages[0]!.sha256).toBe(
    createHash("sha256").update(JSON.stringify(page())).digest("hex"),
  );
});
test("diagnostic bytes and initial EOF reject with an exact private bounded receipt", async () => {
  for (const next of [
    page({ items: [{ fileDescriptor: 2, data: "native failure\n" }] }),
    page({ eof: true, entryId: "" }),
  ]) {
    let observed: unknown;
    try {
      await inspectNativeBrokerInitialDiagnostics(channel([next]));
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(NativeBrokerInitialDiagnosticsError);
    const error = observed as NativeBrokerInitialDiagnosticsError;
    expect(error.message).not.toContain("native failure");
    expect(error.observation.page!.value).toBe(JSON.stringify(next));
    expect(error.observation.page!.sha256).toBe(
      createHash("sha256").update(error.observation.page!.value).digest("hex"),
    );
    expect(Object.isFrozen(error.observation)).toBe(true);
  }
});
test("foreign scope, stream and conflicting page replay cannot produce a clean observation", async () => {
  for (const changed of [
    { sandboxId: "sb-other" },
    { taskId: "ta-other" },
    { requestedFileDescriptor: 1 },
    { items: [{ fileDescriptor: 1, data: "" }] },
  ]) {
    await expect(
      inspectNativeBrokerInitialDiagnostics(channel([page(changed as never)])),
    ).rejects.toThrow();
  }
  await expect(
    inspectNativeBrokerInitialDiagnostics(
      channel([page(), page({ items: [{ fileDescriptor: 2, data: "" }] })]),
    ),
  ).rejects.toThrow("replay_conflict");
});
test("page and byte bounds reject instead of silently stopping with success", async () => {
  await expect(
    inspectNativeBrokerInitialDiagnostics(channel(Array.from({ length: 129 }, () => page()))),
  ).rejects.toThrow("observation_limit");
  await expect(
    inspectNativeBrokerInitialDiagnostics(
      channel([page({ items: [{ fileDescriptor: 2, data: "x".repeat(65536) }] })]),
    ),
  ).rejects.toThrow("observation_limit");
});
test("query failures and aborts remain unavailable rather than being converted to clean completion", async () => {
  const error = new Error("unknown provider query outcome");
  await expect(
    inspectNativeBrokerInitialDiagnostics({
      ...channel([]),
      async *diagnostics() {
        yield page();
        throw error;
      },
    }),
  ).rejects.toBe(error);
  const stopped = new AbortController();
  stopped.abort(error);
  await expect(
    inspectNativeBrokerInitialDiagnostics(
      {
        ...channel([]),
        diagnostics() {
          throw new Error("must not query");
        },
      },
      stopped.signal,
    ),
  ).rejects.toBe(error);
  const during = new AbortController();
  await expect(
    inspectNativeBrokerInitialDiagnostics(
      {
        ...channel([]),
        async *diagnostics() {
          during.abort(error);
          yield page();
        },
      },
      during.signal,
    ),
  ).rejects.toBe(error);
});
