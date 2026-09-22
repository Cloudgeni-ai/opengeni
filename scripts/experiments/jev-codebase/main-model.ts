import { createHash } from "node:crypto";
import { CONTENT_PASS_BUDGET, assertContentLedger } from "./direct-budget";

export const ASTRA_PASS_BUDGET = {
  baselineAttempts: 648,
  baselineUsd: 1.7286868619999969,
  maxAdditionalAttempts: 60,
  maxAdditionalUsd: 2,
};

export function mainModelConfig(name = "terra") {
  if (name === "terra") return { name, id: "openai/gpt-5.6-terra", budget: CONTENT_PASS_BUDGET };
  if (name === "astra") return { name, id: "openai/gpt-6-astra", budget: ASTRA_PASS_BUDGET };
  throw new Error("unsupported_main_model");
}

export function assertMainModelLedger(text: string, name: string) {
  mainModelConfig(name);
  assertContentLedger(text);
  if (name !== "astra") return;
  assertAstraBaseline(text);
}

export function assertAstraBaseline(text: string) {
  const bytes = Buffer.from(text);
  if (
    bytes.length < 929375 ||
    createHash("sha256").update(bytes.subarray(0, 929375)).digest("hex") !==
      "2eabb3d8a91b315df19702b069f1e21738dc60948393e94f3c40852cf99bafca"
  )
    throw new Error("astra_baseline_mismatch");
}
