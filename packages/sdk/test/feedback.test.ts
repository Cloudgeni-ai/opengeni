import { expect, test } from "bun:test";
import type {
  CreateFeedbackRequest as ContractRequest,
  Feedback as ContractFeedback,
} from "@opengeni/contracts";
import type { CreateFeedbackRequest, Feedback } from "../src/feedback";
import { OpenGeniClient } from "../src/client";
// Compile-time parity in both directions without runtime contracts in the SDK.
const requestParity = (value: ContractRequest): CreateFeedbackRequest => value;
const contractParity = (value: CreateFeedbackRequest): ContractRequest => value;
const feedbackParity = (value: ContractFeedback): Feedback => value;
const feedbackContractParity = (value: Feedback): ContractFeedback => value;
test("SDK preserves retry keys and encodes feedback read scope", async () => {
  const requests: Request[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://test.invalid",
    fetch: (async (url, init) => {
      requests.push(new Request(url, init));
      return Response.json({ feedback: [], replayed: false });
    }) as typeof fetch,
  });
  const payload = {
    idempotencyKey: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    sentiment: "negative" as const,
    comment: "  unchanged  ",
  };
  await client.createFeedback("workspace", payload);
  await client.createFeedback("workspace", payload);
  expect(await requests[0]!.json()).toEqual(payload);
  expect(await requests[1]!.json()).toEqual(payload);
  await client.listOwnFeedback("workspace", {
    sessionId: payload.sessionId,
    limit: 20,
    includeTurns: false,
  });
  expect(new URL(requests[2]!.url).searchParams.get("sessionId")).toBe(payload.sessionId);
  expect(new URL(requests[2]!.url).searchParams.get("limit")).toBe("20");
  expect(new URL(requests[2]!.url).searchParams.get("includeTurns")).toBe("false");
  expect(contractParity(requestParity(payload))).toEqual(payload);
  expect(typeof feedbackParity).toBe("function");
  expect(typeof feedbackContractParity).toBe("function");
});
