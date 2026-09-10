import { expect, test } from "bun:test";
import {
  createOlderHistoryLoadReceipt,
  invokeOlderHistoryLoaderWithReceiptCapture,
  type OlderHistoryLoadReceipt,
} from "../src/older-history";

test("automatic tail preservation survives void wrappers without leaking into manual loads", async () => {
  const intents: boolean[] = [];
  const load = () =>
    createOlderHistoryLoadReceipt((_commit, preserveTail) => {
      intents.push(preserveTail);
      return false;
    });
  let captured: OlderHistoryLoadReceipt | undefined;
  invokeOlderHistoryLoaderWithReceiptCapture(
    () => {
      void load();
    },
    (receipt) => {
      captured = receipt;
    },
    true,
  );
  await captured;
  expect(captured?.committed).toBe(false);
  await load();
  expect(intents).toEqual([true, false]);
});

test("throwing loader restores the prior automatic-load context", async () => {
  expect(() =>
    invokeOlderHistoryLoaderWithReceiptCapture(
      () => {
        throw new Error("load failed");
      },
      () => {},
      true,
    ),
  ).toThrow("load failed");
  await createOlderHistoryLoadReceipt((_commit, preserveTail) => {
    expect(preserveTail).toBe(false);
    return false;
  });
});
