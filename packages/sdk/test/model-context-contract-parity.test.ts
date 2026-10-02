import { describe, expect, test } from "bun:test";
import {
  AGENT_PROMPT_MODULE_IDS,
  AGENT_PROMPT_MODULE_TITLES,
  ModelContextInstructionLayerId as ContractLayerId,
  ModelContextSnapshot as ContractModelContextSnapshot,
  SessionModelContextResponse as ContractSessionModelContextResponse,
} from "@opengeni/contracts";
import type {
  AgentPromptModuleId,
  ModelContextInstructionLayerId,
  ModelContextSnapshot,
  SessionModelContextResponse,
} from "../src/model-context";
import type { z } from "zod";

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("model context inspector contract parity", () => {
  test("SDK mirrors match the contracts schemas", () => {
    const acceptSnapshot = (
      value: z.infer<typeof ContractModelContextSnapshot>,
    ): ModelContextSnapshot => value;
    const acceptResponse = (
      value: z.infer<typeof ContractSessionModelContextResponse>,
    ): SessionModelContextResponse => value;
    expect([acceptSnapshot, acceptResponse].every((value) => typeof value === "function")).toBe(
      true,
    );
  });

  test("layer and prompt-module id unions are exactly the contract enums", () => {
    const layerIds: Exact<ModelContextInstructionLayerId, z.infer<typeof ContractLayerId>> = true;
    const moduleIds: Exact<AgentPromptModuleId, (typeof AGENT_PROMPT_MODULE_IDS)[number]> = true;
    expect([layerIds, moduleIds]).toEqual([true, true]);
    expect(Object.keys(AGENT_PROMPT_MODULE_TITLES).sort()).toEqual(
      [...AGENT_PROMPT_MODULE_IDS].sort(),
    );
  });
});
