import { expect, test } from "bun:test";
import { INCOMPLETE_CHAT_COMPLETION_CODE, IncompleteChatCompletionError } from "@opengeni/runtime";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";

test("a Chat stream without completion evidence stops without automatic replay", () => {
  expect(agentRunFailurePayload(new IncompleteChatCompletionError())).toEqual({
    error: "The model provider ended its response before confirming completion.",
    code: INCOMPLETE_CHAT_COMPLETION_CODE,
    retryable: false,
  });
});
