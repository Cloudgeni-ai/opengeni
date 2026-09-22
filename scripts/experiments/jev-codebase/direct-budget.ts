import { createHash } from "node:crypto";
export function assertContentLedger(text: string) {
  const bytes = Buffer.from(text);
  if (
    bytes.length < 883317 ||
    createHash("sha256").update(bytes.subarray(0, 883317)).digest("hex") !==
      "b9c2baed0aac8640299623ffacd05ce0eba29f3ad1c15a7e5a2d7304cef090c8"
  )
    throw new Error("content_baseline_mismatch");
}
/** This explicit user-authorized pass begins after the retained 496-attempt ledger. */
export const DIRECT_PASS_BUDGET = {
  baselineAttempts: 496,
  baselineUsd: 1.2872993319999984,
  maxAdditionalAttempts: 40,
  maxAdditionalUsd: 1,
};

/** New improvement pass, retaining all previous native/Gateway attempts. */
export const IMPROVEMENT_PASS_BUDGET = {
  baselineAttempts: 530,
  baselineUsd: 1.3418997759999984,
  maxAdditionalAttempts: 100,
  maxAdditionalUsd: 1,
};
/** Content-first pass, preserving the original ledger and every earlier charge. */
export const CONTENT_PASS_BUDGET = {
  baselineAttempts: 617,
  baselineUsd: 1.5647185659999971,
  maxAdditionalAttempts: 80,
  maxAdditionalUsd: 1,
};
