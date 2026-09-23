import { expect, test } from "bun:test";
import {
  withoutRetiredSessionCreateMetadata,
  hasRetiredSessionCreateSelection,
} from "../src/retired-session-create-metadata";

const key = "_opengeni_session_create_host_delegations_v1";

test("new session metadata strips retired selection without mutating historical input", () => {
  const selection = [{ serverId: "a", delegationId: crypto.randomUUID(), generation: 1 }];
  const metadata = { note: "kept", [key]: selection };
  expect(withoutRetiredSessionCreateMetadata(metadata)).toEqual({ note: "kept" });
  expect(metadata[key]).toBe(selection);
  expect(hasRetiredSessionCreateSelection(metadata)).toBe(true);
});

test.each([{ value: undefined }, { value: null }, { value: [] }])(
  "empty historical selection allows native replay: %j",
  ({ value }) => {
    expect(hasRetiredSessionCreateSelection({ [key]: value })).toBe(false);
  },
);

test.each([{ value: [{}] }, { value: {} }, { value: "invalid" }, { value: false }])(
  "nonempty or malformed historical selection rejects native replay: %j",
  ({ value }) => {
    expect(hasRetiredSessionCreateSelection({ [key]: value })).toBe(true);
  },
);
