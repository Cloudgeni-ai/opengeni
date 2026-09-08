import { expect, test } from "bun:test";
import type {
  SkillRecord as ContractRecord,
  SkillWriteReceipt as ContractReceipt,
} from "@opengeni/contracts";
import type { SkillRecord, SkillWriteReceipt } from "../src/skills";

test("shared Skill SDK records and receipts match both directions", () => {
  const toSdk = (value: ContractRecord): SkillRecord => value;
  const toContract = (value: SkillRecord): ContractRecord => value;
  const receiptToSdk = (value: ContractReceipt): SkillWriteReceipt => value;
  const receiptToContract = (value: SkillWriteReceipt): ContractReceipt => value;
  expect(
    [toSdk, toContract, receiptToSdk, receiptToContract].every(
      (value) => typeof value === "function",
    ),
  ).toBe(true);
});
