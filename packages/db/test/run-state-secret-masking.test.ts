import { describe, expect, test } from "bun:test";
import { SecretValueMemory } from "@opengeni/contracts";
import { maskSerializedRunStateForStorage } from "../src/lossless-columns";
import { withSecretValueMasking } from "../src/secret-value-masking";

// References are assembled so no tool on the way resolves them.
const TOKEN_REF = "\u007B\u007Bsecret:fake-vault/FAKE_TOKEN/value}}";
const FAKE_TOKEN = "fake-token-FAKE-0000-not-a-secret";

function memory() {
  const values = new SecretValueMemory();
  values.remember(FAKE_TOKEN, TOKEN_REF);
  return values;
}

describe("serialized RunState masking", () => {
  test("masks a known value and keeps the JSON and data URLs intact", async () => {
    // A data URL whose base64 happens to contain the value's base64 form.
    const image = `data:image/png;base64,AAAA${Buffer.from(FAKE_TOKEN).toString("base64")}`;
    const state = JSON.stringify({
      $schemaVersion: "1.0",
      history: [
        { role: "assistant", content: [{ type: "output_text", text: `token ${FAKE_TOKEN}` }] },
        { role: "user", content: [{ type: "input_image", image }] },
      ],
    });
    const masked = await withSecretValueMasking(memory(), async () =>
      maskSerializedRunStateForStorage(state),
    );
    const parsed = JSON.parse(masked) as {
      history: Array<{ content: Array<{ text?: string; image?: string }> }>;
    };
    expect(parsed.history[0]!.content[0]!.text).toBe(`token ${TOKEN_REF}`);
    expect(parsed.history[1]!.content[0]!.image).toBe(image);
  });

  test("unchanged state and states outside an attempt are stored exactly as written", async () => {
    const state = `{"b": 1,  "a": "${FAKE_TOKEN}"}`;
    expect(maskSerializedRunStateForStorage(state)).toBe(state);
    const clean = `{"b": 1,  "a": "nothing here"}`;
    const kept = await withSecretValueMasking(memory(), async () =>
      maskSerializedRunStateForStorage(clean),
    );
    expect(kept).toBe(clean);
  });

  test("text that is not JSON is masked as text", async () => {
    const masked = await withSecretValueMasking(memory(), async () =>
      maskSerializedRunStateForStorage(`not json ${FAKE_TOKEN}`),
    );
    expect(masked).toBe(`not json ${TOKEN_REF}`);
  });
});
