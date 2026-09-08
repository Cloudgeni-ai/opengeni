import { expect, test } from "bun:test";
import {
  normalizeHostCreateSelection,
  metadataWithHostCreateSelection,
  hostCreateSelectionFromMetadata,
} from "../src/host-selection-identity";

test("host selection identity replaces caller metadata and normalizes order without granting authority", () => {
  const one = { serverId: "a", delegationId: crypto.randomUUID(), generation: 1 };
  const two = { ...one, serverId: "b" };
  const metadata = metadataWithHostCreateSelection({ note: "kept" }, [two, one]);
  expect(hostCreateSelectionFromMetadata(metadata)).toEqual([one, two]);
  expect(metadataWithHostCreateSelection(metadata, undefined)).toEqual({ note: "kept" });
  expect(hostCreateSelectionFromMetadata({})).toEqual([]);
  expect(() => normalizeHostCreateSelection([one, one])).toThrow();
  expect(() => normalizeHostCreateSelection([{ ...one, generation: 0 }])).toThrow();
  expect(() => normalizeHostCreateSelection([{ ...one, apiKeyId: "not-authority" }])).toThrow();
});
