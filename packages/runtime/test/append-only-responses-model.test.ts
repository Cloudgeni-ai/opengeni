import { describe, expect, test } from "bun:test";
import { OpenAIResponsesModel, type AgentInputItem, type ModelRequest } from "@openai/agents";
import OpenAI from "openai";
import { AppendOnlyOpenAIResponsesModel } from "../src/append-only-responses-model";

class ExposedAppendOnlyModel extends AppendOnlyOpenAIResponsesModel {
  convert(input: ModelRequest["input"]): OpenAI.Responses.ResponseInputItem[] {
    return this._getInputItems(input);
  }
}

class ExposedCanonicalModel extends OpenAIResponsesModel {
  convert(input: ModelRequest["input"]): OpenAI.Responses.ResponseInputItem[] {
    return this._getInputItems(input);
  }
}

function model(): ExposedAppendOnlyModel {
  return new ExposedAppendOnlyModel(
    new OpenAI({ apiKey: "test", baseURL: "https://example.invalid/v1" }),
    "test-model",
  );
}

function canonicalModel(): ExposedCanonicalModel {
  return new ExposedCanonicalModel(
    new OpenAI({ apiKey: "test", baseURL: "https://example.invalid/v1" }),
    "test-model",
  );
}

function message(text: string): AgentInputItem {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  } as AgentInputItem;
}

describe("append-only Responses input conversion", () => {
  test("matches the canonical SDK conversion while reusing an unchanged prefix", () => {
    const subject = model();
    const canonical = canonicalModel();
    const first = message("first");
    const second = message("second");
    const third = message("third");

    const initial = subject.convert([first, second]);
    const appended = subject.convert([first, second, third]);

    expect(appended).toEqual(canonical.convert([first, second, third]));
    expect(appended[0]).toBe(initial[0]);
    expect(appended[1]).toBe(initial[1]);
    expect(appended[2]).not.toBeUndefined();
  });

  test("reconverts from the first identity divergence and handles shortening", () => {
    const subject = model();
    const canonical = canonicalModel();
    const first = message("first");
    const second = message("second");
    const third = message("third");
    const initial = subject.convert([first, second, third]);
    const replacement = message("replacement");

    const diverged = subject.convert([first, replacement, third]);
    expect(diverged).toEqual(canonical.convert([first, replacement, third]));
    expect(diverged[0]).toBe(initial[0]);
    expect(diverged[1]).not.toBe(initial[1]);
    expect(diverged[2]).not.toBe(initial[2]);

    const shortened = subject.convert([first]);
    expect(shortened).toEqual(canonical.convert([first]));
    expect(shortened[0]).toBe(diverged[0]);
  });

  test("captures length when the same source array is appended in place", () => {
    const subject = model();
    const canonical = canonicalModel();
    const input = [message("first")];
    const initial = subject.convert(input);
    input.push(message("second"));

    const appended = subject.convert(input);
    expect(appended).toEqual(canonical.convert(input));
    expect(appended[0]).toBe(initial[0]);
    expect(appended).toHaveLength(2);
  });

  test("returns the same converted view for identical input and resets after a string", () => {
    const subject = model();
    const item = message("first");
    const initial = subject.convert([item]);
    expect(subject.convert([item])).toBe(initial);
    expect(subject.convert("plain prompt")).toEqual([{ role: "user", content: "plain prompt" }]);
    expect(subject.convert([item])).not.toBe(initial);
  });
});
