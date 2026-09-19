import { describe, expect, test } from "bun:test";
import { SessionRetryRequest, SessionRetryResponse } from "@opengeni/contracts";
import type {
  SessionRetryRequest as SdkRequest,
  SessionRetryResponse as SdkResponse,
} from "../src/types";

describe("failed-session retry wire contract", () => {
  test("accepts an exact failure and selected execution policy", () => {
    const request: SdkRequest = {
      clientEventId: crypto.randomUUID(),
      failureEventId: crypto.randomUUID(),
      model: "selected-model",
      reasoningEffort: "high",
      latencyMode: "fast",
    };
    expect(SessionRetryRequest.parse(request)).toEqual(request);
    const response: SdkResponse = {
      outcome: "accepted",
      turnId: crypto.randomUUID(),
      failureEventId: request.failureEventId,
    };
    expect(SessionRetryResponse.parse(response)).toEqual(response);
    expect(SessionRetryResponse.parse({ ...response, outcome: "replayed" }).outcome).toBe(
      "replayed",
    );
  });
  test("rejects unfenced or synthetic-prompt retry requests", () => {
    const request = { clientEventId: crypto.randomUUID(), failureEventId: crypto.randomUUID() };
    expect(SessionRetryRequest.safeParse(request).success).toBe(true);
    expect(SessionRetryRequest.safeParse({ clientEventId: request.clientEventId }).success).toBe(
      false,
    );
    expect(SessionRetryRequest.safeParse({ ...request, text: "continue" }).success).toBe(false);
    expect(SessionRetryRequest.safeParse({ ...request, failureEventId: "old" }).success).toBe(
      false,
    );
    expect(SessionRetryRequest.safeParse({ ...request, action: "resume" }).success).toBe(false);
  });
});
