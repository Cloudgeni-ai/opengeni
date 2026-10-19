import { expect, test } from "bun:test";
import type { EnrollmentRecord } from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { channelAConnectionBinding } from "../src/sandbox/routing";

test("a machine allowed in another workspace is addressed where it is enrolled", () => {
  // The chat's workspace differs from the machine's; the binding names the
  // machine's own workspace, the only one its single connection listens on.
  const enrollment = {
    workspaceId: "machine-home-workspace",
    connectionInstanceId: "runner-a",
    workspaceRoot: "/Users/person",
    opStream: false,
    operationPolicy: null,
    agentCapabilities: {
      transactionalFsWrite: true,
      transactionalFsWriteMachine: true,
      browserControlHttp: true,
    },
  } as unknown as EnrollmentRecord;
  expect(channelAConnectionBinding({ settings: testSettings() }, enrollment)).toMatchObject({
    workspaceId: "machine-home-workspace",
    connectionInstanceId: "runner-a",
    workspaceRoot: "/Users/person",
    transactionalFsWriteSupported: true,
    transactionalFsWriteMachineSupported: true,
    browserControlHttpSupported: true,
  });
  expect(channelAConnectionBinding({ settings: testSettings() }, null)).toBeNull();
});
