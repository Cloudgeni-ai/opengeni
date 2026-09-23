import { expect, test } from "bun:test";
import { MachineRuntimeCapabilities } from "../src";

const legacy = {
  exec: true,
  filesystem: true,
  git: true,
  pty: false,
  desktop: false,
  opStream: false,
  browserBridge: false,
  operationResourcePolicy: false,
  operationCpuQuota: false,
};

test("transactional filesystem advertisement defaults off for older agents", () => {
  expect(MachineRuntimeCapabilities.parse(legacy).transactionalFsWrite).toBe(false);
});

test("transactional filesystem advertisement preserves explicit true and false", () => {
  for (const transactionalFsWrite of [true, false]) {
    expect(
      MachineRuntimeCapabilities.parse({ ...legacy, transactionalFsWrite }).transactionalFsWrite,
    ).toBe(transactionalFsWrite);
  }
});
