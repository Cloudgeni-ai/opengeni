import { expect, test } from "bun:test";
import {
  ModalBrokerProviderCommand,
  ModalRouterProviderCommand,
  SandboxProviderCommand,
} from "../src/sandbox-provider-command";

function command(pty = false) {
  const invocationId = crypto.randomUUID();
  return {
    kind: "modal-broker-v1",
    sandboxId: "sb-test",
    taskId: "ta-test",
    execId: invocationId,
    pty,
    supervision: {
      protocol: pty
        ? "native-subreaper-broker-channel-pty-v1"
        : "native-subreaper-broker-channel-v1",
      invocationId,
      brokerId: crypto.randomUUID(),
      launchRequestId: crypto.randomUUID(),
      launchEpoch: 1,
    },
    capture: { sequence: 4, receiptAckObserved: false },
    streams: {
      stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null as number | null },
      stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null as number | null },
    },
  };
}

test.each([false, true])("broker %s is a distinct locator, never a router descriptor", (pty) => {
  const value = command(pty);
  expect<unknown>(SandboxProviderCommand.parse(value)).toEqual(value);
  expect(ModalRouterProviderCommand.safeParse(value).success).toBe(false);
  expect(ModalRouterProviderCommand.safeParse({ ...value, kind: "modal-router-v1" }).success).toBe(
    false,
  );
  expect(
    ModalBrokerProviderCommand.safeParse({
      ...value,
      supervision: { ...value.supervision, controlPath: "/tmp/fake.sock" },
    }).success,
  ).toBe(false);
});

test.each([
  (value: ReturnType<typeof command>) => {
    value.supervision.invocationId = crypto.randomUUID();
  },
  (value: ReturnType<typeof command>) => {
    value.supervision.protocol = "native-subreaper-v1";
  },
  (value: ReturnType<typeof command>) => {
    value.pty = true;
  },
  (value: ReturnType<typeof command>) => {
    value.supervision.launchEpoch = 0;
  },
  (value: ReturnType<typeof command>) => {
    value.supervision.brokerId = "AAAAAAAA-AAAA-4AAA-AAAA-AAAAAAAAAAAA";
  },
  (value: ReturnType<typeof command>) => {
    value.capture.sequence = -1;
  },
  (value: ReturnType<typeof command>) => {
    value.capture.sequence = Number.MAX_SAFE_INTEGER + 1;
  },
  (value: ReturnType<typeof command>) => {
    value.streams.stdout.exitCode = 0;
  },
  (value: ReturnType<typeof command>) => {
    value.streams.stdout.eof = true;
    value.streams.stdout.utf8Remainder = "4g==";
  },
])("invalid broker identity, mode or partial terminal evidence is rejected", (mutate) => {
  const value = command();
  mutate(value);
  expect(ModalBrokerProviderCommand.safeParse(value).success).toBe(false);
});

test("independent supervisor zero exit requires both stream EOFs and observed ACK", () => {
  const value = command();
  for (const stream of Object.values(value.streams)) {
    stream.eof = true;
    stream.exitCode = 0;
  }
  expect(ModalBrokerProviderCommand.safeParse(value).success).toBe(false);
  value.capture.receiptAckObserved = true;
  expect(ModalBrokerProviderCommand.safeParse(value).success).toBe(true);
  value.streams.stdout.exitCode = 125;
  value.streams.stderr.exitCode = 125;
  expect(ModalBrokerProviderCommand.safeParse(value).success).toBe(false);
});
