import { expect, test } from "bun:test";
import { isEncryptedReasoningRefusalText } from "../src/encrypted-reasoning-refusal";

test("names provider refusals of encrypted reasoning, not request-shape errors", () => {
  for (const text of [
    "The encrypted content gAAA...aiQ= could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
    "Could not decrypt the provided encrypted_content. Ensure the value is the unmodified encrypted_content from a previous response.",
    "Failed to parse encrypted_content.",
    "Encrypted reasoning cannot be parsed",
  ])
    expect(isEncryptedReasoningRefusalText(text)).toBe(true);
  for (const text of [
    "Unsupported parameter: encrypted_content could not be parsed.",
    "Invalid value for include: reasoning.encrypted_content could not be parsed.",
    "Missing required parameter: 'input[3].encrypted_content'.",
    "Missing required parameter: 'input[116].status'.",
  ])
    expect(isEncryptedReasoningRefusalText(text)).toBe(false);
});
