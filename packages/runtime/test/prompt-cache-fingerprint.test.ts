import { describe, expect, test } from "bun:test";
import type { PromptCacheRequestFingerprint } from "@opengeni/contracts";
import {
  observePromptCacheRequestBody,
  promptCacheRequestFingerprint,
  withPromptCacheFingerprintObserver,
} from "../src/prompt-cache-fingerprint";
import { ReplayableJsonBody, requestBodyText } from "../src/replayable-json-body";

const responsesBody = {
  model: "gpt-test",
  instructions: "You are a helpful agent.",
  tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
  input: [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi" },
    { role: "user", content: "Next" },
  ],
};

async function observed(body: unknown): Promise<PromptCacheRequestFingerprint | null | undefined> {
  let seen: Promise<PromptCacheRequestFingerprint | null> | undefined;
  withPromptCacheFingerprintObserver(
    (fingerprint) => {
      seen = fingerprint;
    },
    () => observePromptCacheRequestBody(body),
  );
  return seen ? await seen : undefined;
}

describe("observePromptCacheRequestBody", () => {
  test("fingerprints a JSON text body", async () => {
    expect(await observed(JSON.stringify(responsesBody))).toEqual(
      promptCacheRequestFingerprint(responsesBody),
    );
  });

  test("fingerprints the replayable stream OpenAI-family clients send, without consuming it", async () => {
    const stream = new ReplayableJsonBody(responsesBody).createStream();
    const fingerprint = await observed(stream);
    expect(fingerprint).not.toBeNull();
    expect(fingerprint).toEqual(await observed(JSON.stringify(responsesBody)));
    expect(fingerprint?.items).toBe(3);
    expect(JSON.parse(await requestBodyText(stream))).toEqual(responsesBody);
  });

  test("ignores bodies it cannot read", async () => {
    expect(await observed(new ReadableStream())).toBeUndefined();
    expect(await observed(undefined)).toBeUndefined();
  });
});
