import { describe, expect, test } from "bun:test";
import {
  ModelContextSnapshot as ContractModelContextSnapshot,
  SessionModelContextResponse as ContractSessionModelContextResponse,
} from "@opengeni/contracts";
import type { ModelContextSnapshot, SessionModelContextResponse } from "../src/model-context";
import type { z } from "zod";

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
});